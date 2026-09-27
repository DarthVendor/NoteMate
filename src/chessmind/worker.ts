/// <reference lib="webworker" />
/*
 * ChessMind inference worker: onnxruntime-web (from cdnjs, single-threaded wasm or WebGPU),
 * the model fetched in <= 14 MB chunks and reassembled, legal-move-masked prediction and
 * dialogue generation with the LineConstraint (legal moves only inside <|line|>).
 * The graph has no KV cache, so every step re-runs the whole (short) sequence.
 */
import { Chess } from 'chess.js';
import { ChessTokenizer, type DialoguePart, type DialogueTurn } from './tokenizer';
import { BoardTracker, encodeGameWithBoards, N_SLOTS, type BoardRow } from './boards';
import { DEFAULT_LINE_TEMPERATURE, DEFAULT_MAX_THINK_TOKENS, ORT_DIR, ORT_SCRIPT_FILE, type Backend, type FromWorker, type ModelManifest, type MovePrediction, type ToWorker } from './protocol';

// Minimal typing of the onnxruntime-web globals used here.
interface OrtTensor { data: Float32Array | BigInt64Array; dims: readonly number[]; dispose?: () => void }
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
interface Ort {
  env: { wasm: { numThreads: number; wasmPaths: string | { wasm?: string; mjs?: string }; proxy: boolean; simd?: boolean }; logLevel?: string };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(model: Uint8Array, opts: Record<string, unknown>): Promise<OrtSession> };
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker) => ctx.postMessage(m);
const CACHE = 'notemate-chessmind-v1';

let ort: Ort | null = null;
let session: OrtSession | null = null;
let tok: ChessTokenizer | null = null;
let manifest: ModelManifest | null = null;
const stopped = new Set<number>();
let pendingPredict: Extract<ToWorker, { type: 'predict' }> | null = null;
let predictRunning = false;

// session.run must not overlap: chain every call.
let runChain: Promise<unknown> = Promise.resolve();
/** Logits of the last position. `rows` (one board row per id) is required by board-embedding models. */
function forward(ids: number[], rows?: BoardRow[]): Promise<Float32Array> {
  const job = runChain.then(async () => {
    const t = new ort!.Tensor('int64', BigInt64Array.from(ids, (i) => BigInt(i)), [1, ids.length]);
    const feeds: Record<string, OrtTensor> = { ids: t };
    if (manifest!.boards) {
      if (!rows || rows.length !== ids.length) throw new Error('board rows missing for a board-embedding model');
      const flat = new BigInt64Array(ids.length * N_SLOTS);
      rows.forEach((r, i) => r.forEach((c, j) => (flat[i * N_SLOTS + j] = BigInt(c))));
      feeds.boards = new ort!.Tensor('int64', flat, [1, ids.length, N_SLOTS]);
    }
    const out = await session!.run(feeds);
    const logits = out.logits.data as Float32Array;
    return logits;
  });
  runChain = job.catch(() => undefined);
  return job;
}

/** Loads onnxruntime from <page root>/ort/. `modelBase` is <root>/chessmind/<model>/, so the root is two levels up. */
async function loadOrt(modelBase: string): Promise<Ort> {
  if (!ort) {
    const dir = new URL(`../../${ORT_DIR}`, modelBase).href;
    try {
      ctx.importScripts(dir + ORT_SCRIPT_FILE); // classic worker (production builds)
      ort = (ctx as unknown as { ort: Ort }).ort;
    } catch {
      // module worker (vite dev): importScripts is unavailable
      ort = (await import(/* @vite-ignore */ dir + ORT_SCRIPT_FILE.replace(/\.js$/, '.mjs'))) as Ort;
    }
    ort.env.wasm.numThreads = 1; // no cross-origin isolation in the artifact host
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { wasm: dir + 'ort-wasm-simd-threaded.wasm', mjs: dir + 'ort-wasm-simd-threaded.mjs' };
  }
  return ort;
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
  } catch {
    return null;
  }
}

async function fetchModel(base: string, m: ModelManifest): Promise<{ bytes: Uint8Array; cached: boolean }> {
  const key = `${base}model.onnx?size=${m.chunks.size}&step=${m.step}`;
  const cache = await openCache();
  try {
    const hit = cache ? await cache.match(key) : undefined;
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      if (buf.byteLength === m.chunks.size) {
        post({ type: 'progress', loaded: buf.byteLength, total: m.chunks.size, phase: 'download' });
        return { bytes: buf, cached: true };
      }
    }
  } catch {
    /* cache unusable */
  }
  const bytes = new Uint8Array(m.chunks.size);
  let offset = 0;
  for (const part of m.chunks.parts) {
    const r = await fetch(base + part);
    if (!r.ok || !r.body) throw new Error(`failed to fetch ${part} (${r.status})`);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.set(value, offset);
      offset += value.byteLength;
      post({ type: 'progress', loaded: offset, total: m.chunks.size, phase: 'download' });
    }
  }
  if (offset !== m.chunks.size) throw new Error(`model is ${offset} bytes, expected ${m.chunks.size}`);
  if (cache) cache.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return { bytes, cached: false };
}

async function load(base: string, backend: Backend) {
  const t0 = performance.now();
  const getJson = async <T,>(name: string): Promise<T> => {
    const r = await fetch(base + name);
    if (!r.ok) throw new Error(`failed to fetch ${name} (${r.status})`);
    return (await r.json()) as T;
  };
  manifest = await getJson<ModelManifest>('model.json');
  const [vocab, bpe] = await Promise.all([
    getJson<ConstructorParameters<typeof ChessTokenizer>[0]>(manifest.files.chess_vocab),
    getJson<ConstructorParameters<typeof ChessTokenizer>[1]>(manifest.files.tokenizer).catch(() => null),
  ]);
  tok = new ChessTokenizer(vocab, bpe);
  const o = await loadOrt(base);
  const { bytes, cached } = await fetchModel(base, manifest);
  post({ type: 'progress', loaded: bytes.byteLength, total: manifest.chunks.size, phase: 'compile' });

  const opts = { graphOptimizationLevel: 'all' };
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  // int8 (dynamic quantization) runs MatMulInteger, which WebGPU hands back to the CPU: auto = wasm for those.
  const preferGpu = hasGpu && !manifest.quant.startsWith('int8');
  const attempts: string[][] = backend === 'wasm' ? [['wasm']] : backend === 'webgpu' ? [['webgpu', 'wasm']] : preferGpu ? [['webgpu', 'wasm'], ['wasm']] : [['wasm']];
  let lastErr: unknown = null;
  let used = '';
  for (const eps of attempts) {
    try {
      // ORT may transfer or detach the buffer; hand it a copy when a retry could need the original.
      session = await o.InferenceSession.create(attempts.length > 1 ? bytes.slice() : bytes, { ...opts, executionProviders: eps });
      used = eps[0];
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!session) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  // Warm-up run (first run allocates / compiles kernels).
  await forward([tok.gameId], new BoardTracker(tok).rows([tok.gameId]));
  post({ type: 'ready', manifest, backend: used, loadMs: performance.now() - t0, cached, hasText: tok.hasText, thinking: tok.hasText && tok.supportsThinking });
}

function legalUci(chess: Chess): string[] {
  return chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));
}

/** Keep the last max_seq_len - reserve tokens (and their board rows, computed before trimming). */
function trimPrefix(ids: number[], rows: BoardRow[] | undefined, reserve: number): { ids: number[]; rows?: BoardRow[] } {
  const budget = manifest!.max_seq_len - reserve;
  if (ids.length <= budget) return { ids, rows };
  return { ids: ids.slice(ids.length - budget), rows: rows?.slice(rows.length - budget) };
}

/**
 * Game prefix for the position after `moves`: board models may crop to the last `k` plies. Models trained on
 * per-side instances (manifest `perspective_games`) get `<|bos|> <|game|> <side to move>` in front, like
 * ChessMind's generate.game_prompt.
 */
function gamePrefix(moves: string[], k: number | null): { ids: number[]; rows?: BoardRow[] } {
  const perspective = manifest!.perspective_games ? ChessTokenizer.sideToMove(moves.length) : undefined;
  if (manifest!.boards) return encodeGameWithBoards(tok!, moves, k, perspective);
  return { ids: tok!.encodeGame(moves, undefined, perspective) };
}

/** Legal-move distribution for the position after `moves` (softmax over legal moves only). */
async function topMoves(moves: string[], top: number, k: number | null): Promise<{ moves: MovePrediction[]; ms: number; tokens: number }> {
  const chess = new Chess();
  for (const m of moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  const legal = legalUci(chess);
  if (legal.length === 0) return { moves: [], ms: 0, tokens: 0 };
  const game = gamePrefix(moves, k);
  const { ids, rows } = trimPrefix(game.ids, game.rows, 1);
  const t0 = performance.now();
  const logits = await forward(ids, rows);
  const ms = performance.now() - t0;
  const scored = legal.map((uci) => ({ uci, l: logits[tok!.moveToId(uci)] }));
  const max = Math.max(...scored.map((s) => s.l));
  const z = scored.reduce((a, s) => a + Math.exp(s.l - max), 0);
  const out = scored
    .map((s) => ({ uci: s.uci, p: Math.exp(s.l - max) / z }))
    .sort((a, b) => b.p - a.p)
    .slice(0, top);
  return { moves: out, ms, tokens: ids.length };
}

async function predict(req: Extract<ToWorker, { type: 'predict' }>) {
  const r = await topMoves(req.moves, req.top, req.contextPlies);
  post({ type: 'prediction', id: req.id, ...r });
}

async function drainPredict() {
  if (predictRunning) return;
  predictRunning = true;
  try {
    while (pendingPredict) {
      const req = pendingPredict;
      pendingPredict = null;
      try {
        await predict(req);
      } catch (e) {
        post({ type: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    predictRunning = false;
  }
}

/** One move for the simulator: argmax or a sample from p^(1/T) over the legal moves. */
async function pick(req: Extract<ToWorker, { type: 'pick' }>) {
  const r = await topMoves(req.moves, Infinity, req.contextPlies);
  if (r.moves.length === 0) {
    post({ type: 'picked', id: req.id, uci: null, p: 0, ms: r.ms, tokens: r.tokens });
    return;
  }
  let chosen = r.moves[0];
  if (req.temperature > 0) {
    const w = r.moves.map((m) => Math.pow(m.p, 1 / req.temperature));
    let x = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) {
      x -= w[i];
      if (x <= 0) {
        chosen = r.moves[i];
        break;
      }
    }
  }
  post({ type: 'picked', id: req.id, uci: chosen.uci, p: chosen.p, ms: r.ms, tokens: r.tokens });
}

/** Sample from `logits` restricted to `allowed` ids (temperature 0 = greedy, top-k over the allowed set). */
function sample(logits: Float32Array, allowed: number[], temperature: number, topK: number): number {
  if (temperature <= 0) {
    let best = allowed[0];
    for (const i of allowed) if (logits[i] > logits[best]) best = i;
    return best;
  }
  let cand = allowed.map((i) => ({ i, l: logits[i] / temperature }));
  if (topK > 0 && cand.length > topK) cand = cand.sort((a, b) => b.l - a.l).slice(0, topK);
  const max = Math.max(...cand.map((c) => c.l));
  const w = cand.map((c) => Math.exp(c.l - max));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < cand.length; k++) {
    r -= w[k];
    if (r <= 0) return cand[k].i;
  }
  return cand[cand.length - 1].i;
}

/**
 * Port of chessmind.model.generate.LineConstraint: text outside <|line|>, legal moves (+ <|end_line|>) inside.
 *
 * `start`: where lines begin (the user's FEN; undefined = the initial position). `positions`: candidate boards
 * under discussion (dialoguePosition); when given (and the tokenizer can think), `<|fen|>` may be sampled, the side
 * token after it picks the candidate (the first one per side) and the 64 piece tokens are FORCED to it, which then
 * becomes the start of later lines. Hidden reasoning (tokenizers with <|end_think|>): `think` true forces <|think|>
 * as the first token, false forbids it, null lets the model choose (first token only). Inside the think the turn
 * cannot end (no <|eos|> / <|user|>), <|end_think|> closes it outside a line, and after `maxThinkTokens` think
 * tokens the close is forced (<|end_line|> first when a line is open). <|end_think|> restores the line start that
 * was active before the think. A tokenizer without <|end_think|> gets exactly the old masks.
 */
class LineConstraint {
  private board: Chess | null = null;
  private readonly t: ChessTokenizer;
  private start: string | undefined;
  /** Side token -> candidate FEN. */
  private readonly positions = new Map<number, string>();
  private position: string | null = null;
  private readonly endThink: number | null;
  private readonly think: boolean | null;
  private readonly maxThinkTokens: number | null;
  private readonly textMask: number[];
  private readonly thinkTextMask: number[];
  private inThink = false;
  private thinkTokens = 0;
  private outerStart: string | undefined;
  private forced: number[] = [];
  /** Right after <|fen|>: the side token chooses the candidate. */
  private pickSide = false;
  private seen = 0;
  constructor(t: ChessTokenizer, start?: string, positions: string[] = [], think: boolean | null = null, maxThinkTokens: number | null = null) {
    this.t = t;
    this.start = start;
    this.endThink = t.endThinkId;
    this.think = this.endThink !== null ? think : false;
    this.maxThinkTokens = maxThinkTokens;
    // Board snapshots only for models that can think (format 4 was trained with them; keep older masks unchanged).
    if (this.endThink !== null) {
      for (const fen of positions) {
        const side = fen.split(' ')[1] === 'b' ? t.blackId : t.whiteId;
        if (!this.positions.has(side)) this.positions.set(side, fen);
      }
    }
    const base: number[] = [];
    for (let i = t.textOffset; i < t.extraOffset; i++) base.push(i);
    base.push(t.lineId);
    if (this.positions.size) base.push(t.fenId);
    this.textMask = [...base, t.eosId, t.userId];
    this.thinkTextMask = this.endThink !== null ? [...base, this.endThink] : base;
  }
  private feedOne(id: number, index: number) {
    const t = this.t;
    if (this.inThink) this.thinkTokens++;
    if (this.pickSide) {
      this.pickSide = false;
      this.position = this.positions.get(id)!;
      this.forced = t.encodeBoard(this.position).slice(2);
      return;
    }
    if (this.forced.length) {
      this.forced.shift();
      if (!this.forced.length && this.position !== null) this.start = this.position;
      return;
    }
    if (index === 0 && id === t.thinkId && this.endThink !== null) {
      this.inThink = true;
      this.outerStart = this.start;
      return;
    }
    if (this.inThink && id === this.endThink) {
      this.inThink = false;
      this.start = this.outerStart;
      this.board = null;
      return;
    }
    if (id === t.fenId && this.positions.size) this.pickSide = true;
    else if (id === t.lineId) this.board = new Chess(this.start);
    else if (id === t.endLineId) this.board = null;
    else if (this.board && t.isMoveId(id)) {
      const m = t.idToMove(id);
      this.board.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    }
  }
  allowed(out: number[]): number[] {
    for (let i = this.seen; i < out.length; i++) this.feedOne(out[i], i);
    this.seen = out.length;
    const t = this.t;
    if (this.pickSide) return [...this.positions.keys()].sort((a, b) => a - b);
    if (this.forced.length) return [this.forced[0]];
    if (out.length === 0 && this.endThink !== null && this.think !== false) {
      if (this.think) return [t.thinkId];
      return [...this.textMask, t.thinkId];
    }
    const over = this.inThink && this.maxThinkTokens !== null && this.thinkTokens >= this.maxThinkTokens;
    if (this.board) {
      if (over) return [t.endLineId];
      return [...legalUci(this.board).map((m) => t.moveToId(m)), t.endLineId];
    }
    if (this.inThink) return over ? [this.endThink!] : this.thinkTextMask;
    return this.textMask;
  }
}

/**
 * Port of generate.dialogue_position: `start` = the last snapshot of the dialogue (lines start there) and
 * `positions` = what the last user turn talks about: the end of its last line and the position before that line's
 * last move (a question about the move just played), else the snapshot. FENs.
 */
function dialoguePosition(turns: DialogueTurn[]): { start?: string; positions: string[] } {
  let start: string | undefined;
  let positions: string[] = [];
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'fen') {
        start = part.fen;
        positions = [new Chess(part.fen).fen()];
      } else if (part.kind === 'line') {
        const b = new Chess(start);
        let before: string | null = null;
        for (const m of part.moves) {
          before = b.fen();
          b.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
        }
        if (turn.role === 'user') positions = [b.fen(), ...(before !== null ? [before] : [])];
      }
    }
  }
  return { start, positions };
}

interface GenOptions {
  id: number;
  prefix: number[];
  /** Board rows of the prefix and the row of each generated token (board models). */
  prefixRows?: BoardRow[];
  nextRow?: (id: number) => BoardRow;
  maxTokens: number;
  temperature: number;
  topK: number;
  /** Temperature for the tokens after a generated <|line|> through its <|end_line|> (unset: `temperature`). */
  lineTemperature?: number;
  allowed: (out: number[]) => number[];
  stops: Set<number>;
  render: (out: number[]) => DialoguePart[];
  extra?: Partial<Extract<FromWorker, { type: 'chat-update' }>>;
}

/** Sample up to maxTokens ids, streaming chat-update messages; stops on a stop id or a stop request. */
async function generate(o: GenOptions) {
  let { ids, rows } = trimPrefix(o.prefix, o.prefixRows, o.maxTokens);
  const out: number[] = [];
  // Lines (greedy by default in chat): from a generated <|line|> through its <|end_line|>, as generate.py's line_temperature
  const lineId = o.lineTemperature !== undefined && tok ? tok.lineId : -1;
  const endLineId = o.lineTemperature !== undefined && tok ? tok.endLineId : -1;
  let inLine = false;
  let genMs = 0;
  let prefillMs: number | undefined;
  for (let step = 0; step < o.maxTokens; step++) {
    if (stopped.has(o.id)) {
      post({ type: 'chat-update', id: o.id, parts: o.render(out), tokens: out.length, msPerToken: out.length ? genMs / out.length : 0, done: true, stopped: true, prefillMs, ...o.extra });
      return;
    }
    const t0 = performance.now();
    const logits = await forward(ids, rows);
    const dt = performance.now() - t0;
    if (step === 0) prefillMs = dt;
    genMs += dt;
    const temperature = inLine && o.lineTemperature !== undefined ? o.lineTemperature : o.temperature;
    const next = sample(logits, o.allowed(out), temperature, o.topK);
    out.push(next);
    if (next === lineId) inLine = true;
    else if (next === endLineId) inLine = false;
    ids = [...ids, next];
    if (rows && o.nextRow) rows = [...rows, o.nextRow(next)];
    const done = o.stops.has(next) || step === o.maxTokens - 1;
    post({ type: 'chat-update', id: o.id, parts: o.render(out), tokens: out.length, msPerToken: genMs / out.length, done, prefillMs, ...o.extra });
    if (done) return;
    // Let queued messages (stop, predict) in between steps.
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function chat(req: Extract<ToWorker, { type: 'chat' }>) {
  const t = tok!;
  if (!t.hasText) throw new Error('this model has no text tokenizer');
  const userParts: DialoguePart[] = [];
  if (req.fen) userParts.push({ kind: 'fen', fen: req.fen });
  userParts.push({ kind: 'text', text: req.prompt });
  if (req.context?.length) userParts.push({ kind: 'line', moves: req.context });
  const turns: DialogueTurn[] = [...req.history, { role: 'user', parts: userParts }];
  // <|eos|> <|user|> ... <|assistant|>: the context every training dialogue has (the packer's separator first)
  const prefix = t.chatPrompt(turns);
  const { start, positions } = dialoguePosition(turns);
  const mode = req.think ?? 'auto';
  const thinking = t.supportsThinking && mode !== 'off';
  // The think fits the context: what the prompt and the answer leave (a quarter of it at least), as chat() in generate.py
  const room = manifest!.max_seq_len - prefix.length - req.maxTokens - 3;
  const maxThink = Math.max(0, Math.min(req.maxThinkTokens ?? DEFAULT_MAX_THINK_TOKENS, Math.max(room, Math.floor((manifest!.max_seq_len - req.maxTokens) / 4))));
  const constraint = new LineConstraint(t, start, positions, mode === 'on' ? true : mode === 'off' ? false : null, maxThink);
  const tracker = manifest!.boards ? new BoardTracker(t) : null;
  const endThink = t.endThinkId;
  await generate({
    id: req.id,
    prefix,
    prefixRows: tracker?.rows(prefix),
    nextRow: tracker ? (id) => tracker.feed(id) : undefined,
    maxTokens: req.maxTokens + (thinking ? maxThink + 2 : 0),
    temperature: req.temperature,
    topK: req.topK,
    lineTemperature: req.lineTemperature ?? DEFAULT_LINE_TEMPERATURE,
    allowed: (out) => constraint.allowed(out),
    stops: new Set([t.eosId, t.userId]),
    render: (out) => {
      const parts = t.decodeDialogueContent(out);
      if (parts[0]?.kind === 'think' && out[0] === t.thinkId) {
        const close = endThink === null ? -1 : out.indexOf(endThink);
        parts[0] = { ...parts[0], open: close < 0, tokens: (close < 0 ? out.length : close) - 1 };
      }
      return parts;
    },
  });
}

/** Port of generate.explain(): top moves, then English after `<|think|> <side>` until <|move|> / <|eos|>. */
async function explain(req: Extract<ToWorker, { type: 'explain' }>) {
  const t = tok!;
  const { moves: predictions } = await topMoves(req.moves, req.top, req.contextPlies);
  if (!t.hasText) {
    post({ type: 'chat-update', id: req.id, parts: [], tokens: 0, msPerToken: 0, done: true, predictions });
    return;
  }
  const game = gamePrefix(req.moves, req.contextPlies);
  const prefix = [...game.ids, t.thinkId, req.moves.length % 2 === 0 ? t.whiteId : t.blackId];
  // <|think|>, the side token and commentary keep the current board (BoardTracker semantics).
  const last = game.rows?.[game.rows.length - 1];
  const prefixRows = game.rows && last ? [...game.rows, last, last] : undefined;
  const allowed: number[] = [];
  for (let i = t.textOffset; i < t.extraOffset; i++) allowed.push(i);
  allowed.push(t.moveId, t.eosId);
  await generate({
    id: req.id,
    prefix,
    prefixRows,
    nextRow: last ? () => last : undefined,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    topK: req.topK,
    allowed: () => allowed,
    stops: new Set([t.moveId, t.eosId]),
    render: (out) => {
      const text = t.decodeText(out.filter((i) => t.isTextId(i))).trim();
      return text ? [{ kind: 'text', text }] : [];
    },
    extra: { predictions },
  });
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  const fail = (err: unknown, id?: number) => post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  switch (msg.type) {
    case 'load':
      load(msg.base, msg.backend).catch((err) => fail(err));
      break;
    case 'predict':
      if (!session) return;
      pendingPredict = msg;
      void drainPredict();
      break;
    case 'chat':
      if (!session) return fail(new Error('model not loaded'), msg.id);
      chat(msg)
        .catch((err) => fail(err, msg.id))
        .finally(() => stopped.delete(msg.id));
      break;
    case 'explain':
      if (!session) return fail(new Error('model not loaded'), msg.id);
      explain(msg)
        .catch((err) => fail(err, msg.id))
        .finally(() => stopped.delete(msg.id));
      break;
    case 'pick':
      if (!session) return fail(new Error('model not loaded'), msg.id);
      pick(msg).catch((err) => fail(err, msg.id));
      break;
    case 'stop':
      stopped.add(msg.id);
      break;
  }
};

ctx.addEventListener('unhandledrejection', (ev) => post({ type: 'error', message: String((ev as PromiseRejectionEvent).reason) }));
