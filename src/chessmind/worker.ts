/// <reference lib="webworker" />
/*
 * ChessMind inference worker: onnxruntime-web (served from ort/; wasm, multi-threaded when the page is cross-origin
 * isolated, or WebGPU),
 * the model fetched in <= 14 MB chunks and reassembled, legal-move-masked prediction and
 * dialogue generation with the LineConstraint (legal moves only inside <|line|>).
 * Exports with a KV cache (manifest `kv_cache`) run each new token once: a small pool of caches keeps the K/V of
 * recent sequences, and every forward pass reuses the longest cached prefix (the next token of a generation, the next
 * ply of a game, a follow-up chat turn). Older exports re-run the whole sequence every step.
 */
import { Chess } from 'chess.js';
import { ChessTokenizer, type DialoguePart, type DialogueTurn } from './tokenizer';
import { BoardTracker, dialogueSnapshotFens, encodeGameWithBoards, nSlots, type BoardRow, type BoardSync } from './boards';
import { KV_SINKS, moveKeys, rowsHash, sharedPrefix } from './kv';
import { DEFAULT_LINE_RULES, probAmong, type LineRules } from './lineRules';
import { dialoguePosition, rewindCandidates } from './snapshots';
import { LineConstraint, MAX_TOOL_CALLS, ToolConstraint, type GenConstraint, type ToolRequestInfo } from './constraint';
import { DEFAULT_TOOL_TIMEOUT_MS, RESULT_BUDGET, TOOL_SPECS, addToolsBlock, errorText, fitToolResult, type ToolResultData } from './tools';
import { DEFAULT_LINE_TEMPERATURE, DEFAULT_MAX_THINK_TOKENS, DEFAULT_THINK_MOVE_TEMPERATURE, DEFAULT_THINK_MOVE_TOKENS, DEFAULT_THINK_MOVE_TOP_K, ORT_DIR, ORT_SCRIPT_FILE, type Backend, type FromWorker, type ModelManifest, type MovePrediction, type PickThink, type ToWorker } from './protocol';
import { ThinkMoveConstraint } from './thinkMove';

// Minimal typing of the onnxruntime-web globals used here.
interface OrtTensor { data: Float32Array | BigInt64Array; dims: readonly number[]; dispose?: () => void }
type ModelKv = NonNullable<ModelManifest['kv']>;
/** Context slides with a cache: drop this fraction of max_seq_len at a time (the keys are re-rotated, no re-prefill). */
const KV_SLIDE = 1 / 8;
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
interface Ort {
  env: { wasm: { numThreads: number; wasmPaths: string | { wasm?: string; mjs?: string }; proxy: boolean; simd?: boolean }; logLevel?: string };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => OrtTensor;
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
/** Debug mode (localStorage notemate.chessmind.debug = 1): every cached forward is checked against a fresh pass over
 * the same ids and board rows, and each request is logged (ids, a board-row hash, the cache hit, the top 5). */
let debug = false;
let debugTag = '';
/** Debug: the moves of the prediction being logged (Python rebuilds a cropped game's start position from them). */
let debugMoves: string[] | null = null;
let pendingPredict: Extract<ToWorker, { type: 'predict' }> | null = null;
let predictRunning = false;

// session.run must not overlap (and the caches must not change under a run): chain every call.
let runChain: Promise<unknown> = Promise.resolve();
function chained<T>(fn: () => Promise<T>): Promise<T> {
  const job = runChain.then(fn);
  runChain = job.catch(() => undefined);
  return job;
}

function idsTensor(ids: number[]): OrtTensor {
  return new ort!.Tensor('int64', BigInt64Array.from(ids, (i) => BigInt(i)), [1, ids.length]);
}

/** The model's board-row options (v6 sync / feature planes; legacy without them). */
function boardOpts(): { sync: BoardSync; features: string[] } {
  return { sync: manifest?.board_sync ?? 'legacy', features: manifest?.board_features ?? [] };
}

function boardsTensor(rows: (BoardRow | undefined)[] | undefined, n: number): OrtTensor {
  if (!rows || rows.length !== n || rows.some((r) => !r)) throw new Error('board rows missing for a board-embedding model');
  const width = nSlots(boardOpts().features);
  const flat = new BigInt64Array(n * width);
  rows.forEach((r, i) => r!.forEach((c, j) => (flat[i * width + j] = BigInt(c))));
  return new ort!.Tensor('int64', flat, [1, n, width]);
}

/** Stateless graph: logits of the last position of the whole sequence. */
async function runStateless(ids: number[], rows?: BoardRow[]): Promise<Float32Array> {
  const feeds: Record<string, OrtTensor> = { ids: idsTensor(ids) };
  if (manifest!.boards) feeds.boards = boardsTensor(rows, ids.length);
  const out = await session!.run(feeds);
  return out.logits.data as Float32Array;
}

/**
 * The KV cache of one token sequence: per layer, keys and values of the cached tokens, token-major
 * ([tokens, heads, head_dim], the export's layout), in buffers that grow by doubling up to max_seq_len. A prefix of
 * the buffer is handed to the graph as the past without copying it in JS; only the new tokens' rows come back.
 */
class KvCache {
  readonly ids: number[] = [];
  readonly rows: (BoardRow | undefined)[] = [];
  /** LRU stamp. */
  used = 0;
  private k: Float32Array[] = [];
  private v: Float32Array[] = [];
  private capacity = 0;
  private readonly kv: ModelKv;
  private readonly maxLen: number;
  constructor(kv: ModelKv, maxLen: number) {
    this.kv = kv;
    this.maxLen = maxLen;
  }
  get length(): number {
    return this.ids.length;
  }
  private get stride(): number {
    return this.kv.n_kv_heads * this.kv.head_dim;
  }
  /** Leading tokens (ids and board rows) shared with a sequence. */
  common(ids: number[], rows?: BoardRow[]): number {
    return sharedPrefix(this.ids, this.rows, ids, rows);
  }
  truncate(n: number) {
    this.ids.length = Math.min(n, this.ids.length);
    this.rows.length = this.ids.length;
  }
  /**
   * Drop cached tokens sinks .. sinks+drop-1 and move the rest down to follow the sinks, re-rotating their keys to the
   * new positions. The kept tokens' keys and values still carry what they saw of the dropped ones (StreamingLLM-style
   * sliding window); a re-prefill of the window would cost a full prompt pass.
   */
  shift(sinks: number, drop: number) {
    const n = this.length;
    const from = sinks + drop;
    if (from >= n) return this.truncate(sinks);
    const s = this.stride;
    for (let l = 0; l < this.kv.n_layer; l++) {
      moveKeys(this.k[l], from, sinks, n - from, this.kv.n_kv_heads, this.kv.head_dim, this.kv.rope_theta ?? 10000);
      this.v[l].copyWithin(sinks * s, from * s, n * s);
    }
    this.ids.splice(sinks, drop);
    this.rows.splice(sinks, drop);
  }
  private reserve(n: number) {
    if (n <= this.capacity) return;
    const cap = Math.max(n, Math.min(this.maxLen, Math.max(64, this.capacity * 2)));
    const used = this.length * this.stride;
    const grow = (old: Float32Array[]) =>
      Array.from({ length: this.kv.n_layer }, (_, l) => {
        const a = new Float32Array(cap * this.stride);
        if (old[l]) a.set(old[l].subarray(0, used));
        return a;
      });
    this.k = grow(this.k);
    this.v = grow(this.v);
    this.capacity = cap;
  }
  /** Run `ids` (continuing the cached tokens, at positions length ..) and append their keys and values; logits of the last. */
  async extend(ids: number[], rows?: BoardRow[]): Promise<Float32Array> {
    const p = this.length;
    const s = this.stride;
    this.reserve(p + ids.length);
    const feeds: Record<string, OrtTensor> = { ids: idsTensor(ids) };
    if (manifest!.boards) feeds.boards = boardsTensor(rows, ids.length);
    const dims = [1, p, this.kv.n_kv_heads, this.kv.head_dim];
    // Names come in (key, value) pairs per layer: past_key.0, past_value.0, past_key.1, ...
    for (let l = 0; l < this.kv.n_layer; l++) {
      feeds[this.kv.past[2 * l]] = new ort!.Tensor('float32', this.k[l].subarray(0, p * s), dims);
      feeds[this.kv.past[2 * l + 1]] = new ort!.Tensor('float32', this.v[l].subarray(0, p * s), dims);
    }
    const out = await session!.run(feeds);
    for (let l = 0; l < this.kv.n_layer; l++) {
      const nk = out[this.kv.new[2 * l]];
      const nv = out[this.kv.new[2 * l + 1]];
      this.k[l].set(nk.data as Float32Array, p * s);
      this.v[l].set(nv.data as Float32Array, p * s);
      nk.dispose?.();
      nv.dispose?.();
    }
    for (let i = 0; i < ids.length; i++) {
      this.ids.push(ids[i]);
      this.rows.push(rows?.[i]);
    }
    return out.logits.data as Float32Array;
  }
}

/** Recent sequences' caches: a chat, and a game seen from each side (per-side prompts differ at the side token). */
const POOL_SIZE = 4;
let pool: KvCache[] = [];
let poolTick = 0;

/** Shift the cache that holds (a prefix of) `ids` as KvCache.shift; without one the next forward re-prefills. */
function slideCache(ids: number[], rows: BoardRow[] | undefined, sinks: number, drop: number): Promise<void> {
  return chained(async () => {
    const c = pool.find((p) => p.length >= sinks + drop && p.common(ids, rows) === p.length);
    c?.shift(sinks, drop);
  });
}

/**
 * Logits of the last position of `ids` (`rows`: one board row per id, required by board-embedding models). With a KV
 * cache only the tokens after the longest cached prefix run (at least the last one, for its logits).
 */
function forward(ids: number[], rows?: BoardRow[]): Promise<Float32Array> {
  return chained(async () => {
    const m = manifest!;
    if (!m.kv_cache || !m.kv) return runStateless(ids, rows);
    if (ids.length > m.max_seq_len) throw new Error(`sequence of ${ids.length} tokens exceeds the model context (${m.max_seq_len})`);
    // The cache sharing the longest prefix, but never one that would lose most of its own sequence (the white- and
    // black-to-move prompts of a game share only <|bos|> <|game|>: each keeps its cache and extends it every ply).
    let best: KvCache | null = null;
    let bestLen = 0;
    for (const c of pool) {
      const n = c.common(ids, rows);
      if (n < c.length && n < c.length / 2) continue;
      if (!best || n > bestLen || (n === bestLen && c.used < best.used)) {
        best = c;
        bestLen = n;
      }
    }
    if (!best) {
      if (pool.length < POOL_SIZE) pool.push((best = new KvCache(m.kv, m.max_seq_len)));
      else best = pool.reduce((a, b) => (b.used < a.used ? b : a)); // recycle the least recently used
      bestLen = best.common(ids, rows);
    }
    const keep = Math.min(bestLen, ids.length - 1);
    best.truncate(keep);
    best.used = ++poolTick;
    const logits = await best.extend(ids.slice(keep), rows?.slice(keep));
    if (debug) await debugCheck(ids, rows, logits, keep, pool.indexOf(best));
    return logits;
  });
}

const top5 = (l: Float32Array) =>
  Array.from(l.keys())
    .sort((a, b) => l[b] - l[a])
    .slice(0, 5);

/** Debug: the logits of a fresh pass (no cache) over the same ids and rows vs the cached pass. */
async function debugCheck(ids: number[], rows: BoardRow[] | undefined, cached: Float32Array, hit: number, cache: number) {
  const check = !debugTag.startsWith('chat') || ids.length % 32 === 0;
  let diff: number | null = null;
  let freshTop: number[] | null = null;
  if (check && hit > 0) {
    const fresh = await new KvCache(manifest!.kv!, manifest!.max_seq_len).extend(ids, rows);
    diff = 0;
    for (let i = 0; i < fresh.length; i++) diff = Math.max(diff, Math.abs(fresh[i] - cached[i]));
    freshTop = top5(fresh);
  }
  const top = top5(cached);
  post({ type: 'debug', data: { tag: debugTag, n: ids.length, hit, cache, rowsHash: rowsHash(rows), top, freshTop, diff, ids: hit === 0 || debugTag.startsWith('predict') ? ids : undefined, moves: debugTag.startsWith('predict') ? debugMoves : undefined } });
}

/** Loads onnxruntime from <page root>/ort/. `modelBase` is <root>/chessmind/<model>/, so the root is two levels up. */
async function loadOrt(modelBase: string, threads: number): Promise<Ort> {
  if (!ort) {
    const dir = new URL(`../../${ORT_DIR}`, modelBase).href;
    try {
      ctx.importScripts(dir + ORT_SCRIPT_FILE); // classic worker (production builds)
      ort = (ctx as unknown as { ort: Ort }).ort;
    } catch {
      // module worker (vite dev): importScripts is unavailable
      ort = (await import(/* @vite-ignore */ dir + ORT_SCRIPT_FILE.replace(/\.js$/, '.mjs'))) as Ort;
    }
    // Threads need SharedArrayBuffer, i.e. a cross-origin isolated page (the local host); the artifact host is not.
    const isolated = (ctx as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    // ~60% of the cores, at most 6 (a 10-core M-series: 6 threads decode 1.3-1.8x faster than 4; 8 spill onto E-cores)
    const auto = Math.min(6, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) * 0.6)));
    ort.env.wasm.numThreads = isolated ? (threads > 0 ? threads : auto) : 1;
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

async function load(base: string, backend: Backend, threads = 0, dbg = false) {
  debug = dbg;
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
  const o = await loadOrt(base, threads);
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
  // Warm-up runs (the first run allocates / compiles kernels): a prefill and, with a cache, a decode step on top.
  const warm = [tok.gameId, tok.moveToId('e2e4')];
  const warmRows = new BoardTracker(tok, undefined, boardOpts()).rows(warm);
  await forward(warm.slice(0, 1), warmRows.slice(0, 1));
  if (manifest.kv_cache) await forward(warm, warmRows);
  pool = [];
  post({ type: 'ready', manifest, backend: used, loadMs: performance.now() - t0, cached, hasText: tok.hasText, thinking: tok.hasText && tok.supportsThinking, threads: o.env.wasm.numThreads, kvCache: !!manifest.kv_cache });
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
  if (manifest!.boards) return encodeGameWithBoards(tok!, moves, k, perspective, boardOpts());
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
  debugTag = `predict ${moves.length} k=${k}`;
  debugMoves = moves;
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

/** One move for the simulator: argmax or a sample from p^(1/T) over the legal moves (after a think, see thinkPick). */
async function pick(req: Extract<ToWorker, { type: 'pick' }>) {
  const t = tok!;
  if (req.think && req.think !== 'off' && t.hasText && t.supportsThinking) {
    if (await thinkPick(req)) return;
    if (stopped.has(req.id)) {
      post({ type: 'picked', id: req.id, uci: null, p: 0, ms: 0, tokens: 0 });
      return;
    }
  }
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

/**
 * Think-then-move (port of think_move.play_move_with_think): after the per-side game prompt, an optional
 * `<|think|> <side> text / lines <|end_think|>` and then the move, under ThinkMoveConstraint, on the KV cache. Text is
 * sampled at thinkTemperature / thinkTopK, think lines at lineTemperature (greedy by default), the move (and the
 * auto mode's first token) at the request's temperature. The think streams as chat-update messages; false when no
 * move came out (budget or stop), and the caller picks without the think.
 */
async function thinkPick(req: Extract<ToWorker, { type: 'pick' }>): Promise<boolean> {
  const t = tok!;
  const chess = new Chess();
  for (const m of req.moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  if (chess.moves().length === 0) return false;
  const limit = manifest!.max_seq_len;
  const game = gamePrefix(req.moves, req.contextPlies);
  // The think fits the context next to the game prompt (as play_move_with_think's budget), at least a few tokens.
  const maxThink = Math.max(8, Math.min(req.maxThinkTokens ?? DEFAULT_THINK_MOVE_TOKENS, limit - game.ids.length - 8));
  const rules: LineRules = {
    ...DEFAULT_LINE_RULES,
    ...req.lineRules,
    endP: { ...DEFAULT_LINE_RULES.endP, ...req.lineRules?.endP },
    maxPlies: { ...DEFAULT_LINE_RULES.maxPlies, ...req.lineRules?.maxPlies },
  };
  const cons = new ThinkMoveConstraint(t, chess.fen(), req.think === 'on' ? true : null, maxThink, rules);
  // Board rows of the generated tokens: a legacy tracker primed with the whole game (its state is the game position).
  let tracker: BoardTracker | null = null;
  if (game.rows) {
    tracker = new BoardTracker(t, undefined, boardOpts());
    tracker.rows(t.encodeGame(req.moves, undefined, manifest!.perspective_games ? ChessTokenizer.sideToMove(req.moves.length) : undefined));
  }
  const textT = req.thinkTemperature ?? DEFAULT_THINK_MOVE_TEMPERATURE;
  const textK = req.thinkTopK ?? DEFAULT_THINK_MOVE_TOP_K;
  const lineT = req.lineTemperature ?? DEFAULT_LINE_TEMPERATURE;
  let p = 0;
  let phase = cons.phase;
  debugTag = `think-pick ${req.moves.length}`;
  debugMoves = req.moves;
  const t0 = performance.now();
  const endThink = t.endThinkId!;
  const renderThink = (out: number[]): PickThink | undefined => {
    if (out[0] !== t.thinkId) return undefined;
    const close = out.indexOf(endThink);
    const ids = close < 0 ? out : out.slice(0, close + 1);
    const parts = t.decodeDialogueContent(ids);
    const think = parts[0]?.kind === 'think' ? parts[0].parts : [];
    return { parts: think, tokens: (close < 0 ? out.length : close) - 1, open: close < 0 };
  };
  const out = await generate({
    id: req.id,
    prefix: game.ids,
    prefixRows: game.rows,
    nextRow: tracker ? (id) => tracker.feed(id) : undefined,
    // the think, then closes (open branches, the line, <|end_think|>) and the move
    maxTokens: maxThink + 8,
    temperature: textT,
    topK: textK,
    allowed: (o) => {
      const a = cons.allowed(o);
      phase = cons.phase;
      return a;
    },
    sampling: () => {
      if (phase === 'think' && cons.inLine) return { temperature: lineT, topK: 0 };
      if (phase === 'move' || (phase === 'start' && cons.think !== true)) return { temperature: req.temperature, topK: 0 };
      return { temperature: textT, topK: textK };
    },
    observe: (logits, allowed, next) => {
      if (t.isMoveId(next) && (phase === 'move' || phase === 'start')) p = probAmong(logits, allowed.filter((i) => t.isMoveId(i)), next);
    },
    endLine: { id: t.endLineId, threshold: () => cons.endThreshold() },
    stops: new Set([t.eosId]),
    until: (o) => {
      cons.sync(o);
      return cons.done;
    },
    render: (o) => {
      cons.sync(o);
      const th = renderThink(o);
      return th ? [{ kind: 'think', parts: th.parts, open: th.open, tokens: th.tokens }] : [];
    },
  });
  cons.sync(out);
  if (cons.move === null) return false;
  post({ type: 'picked', id: req.id, uci: cons.move, p, ms: performance.now() - t0, tokens: game.ids.length + out.length, think: renderThink(out) });
  return true;
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
  /** Lines: <|end_line|> is chosen once its probability among the allowed ids reaches `threshold()` (null = off). */
  endLine?: { id: number; threshold: () => number | null };
  stops: Set<number>;
  /** Also stop once this holds for the ids so far (think picks: the move was sampled). */
  until?: (out: number[]) => boolean;
  render: (out: number[]) => DialoguePart[];
  extra?: Partial<Extract<FromWorker, { type: 'chat-update' }>>;
  /** Tool calls: after each sampled id (not a stop), ids to append as if generated (a tool result and <|end_tool|>),
   * read on the KV cache with the next forward; `room` = ids left in the budget. */
  inject?: (out: number[], room: number) => Promise<number[] | null>;
  /** Per-step sampling (read after `allowed`): overrides `temperature` / `topK` / `lineTemperature` (think picks). */
  sampling?: () => { temperature: number; topK: number };
  /** Called with each step's logits, the allowed ids and the chosen id. */
  observe?: (logits: Float32Array, allowed: number[], next: number) => void;
}

/** Sample up to maxTokens ids, streaming chat-update messages; stops on a stop id or a stop request. Returns the ids. */
async function generate(o: GenOptions): Promise<number[]> {
  const limit = manifest!.max_seq_len;
  const kv = !!manifest!.kv_cache;
  // The prompt keeps room to answer (up to a quarter of the context); a longer generation slides the window below.
  let { ids, rows } = trimPrefix(o.prefix, o.prefixRows, Math.min(o.maxTokens, Math.floor(limit / 4)));
  const out: number[] = [];
  // Lines (greedy by default in chat): from a generated <|line|> through its <|end_line|>, as generate.py's line_temperature
  const lineId = o.lineTemperature !== undefined && tok ? tok.lineId : -1;
  const endLineId = o.lineTemperature !== undefined && tok ? tok.endLineId : -1;
  let inLine = false;
  let genMs = 0;
  let prefillMs: number | undefined;
  // ms/token over the steps after the first (the first reads the whole prompt and is reported as prefillMs)
  const msPerToken = () => (out.length > 1 ? (genMs - (prefillMs ?? 0)) / (out.length - 1) : genMs);
  for (let step = 0; out.length < o.maxTokens; step++) {
    if (stopped.has(o.id)) {
      post({ type: 'chat-update', id: o.id, parts: o.render(out), tokens: out.length, msPerToken: out.length ? msPerToken() : 0, done: true, stopped: true, prefillMs, ...o.extra });
      return out;
    }
    if (ids.length > limit && kv) {
      // Context full: keep the first KV_SINKS tokens and drop the oldest after them, KV_SLIDE of the context at a
      // time; the cache moves its keys down (re-rotated) instead of re-reading the window.
      const drop = ids.length - (limit - Math.floor(limit * KV_SLIDE));
      await slideCache(ids, rows, KV_SINKS, drop);
      ids = [...ids.slice(0, KV_SINKS), ...ids.slice(KV_SINKS + drop)];
      rows = rows && [...rows.slice(0, KV_SINKS), ...rows.slice(KV_SINKS + drop)];
    } else if (ids.length > limit) {
      // Stateless graph: it re-reads everything anyway, so the window slides one token at a time.
      ids = ids.slice(ids.length - limit);
      rows = rows?.slice(rows.length - limit);
    }
    const t0 = performance.now();
    const logits = await forward(ids, rows);
    const dt = performance.now() - t0;
    if (step === 0) prefillMs = dt;
    genMs += dt;
    const allowed = o.allowed(out);
    const custom = o.sampling?.();
    const temperature = custom ? custom.temperature : inLine && o.lineTemperature !== undefined ? o.lineTemperature : o.temperature;
    const tau = o.endLine?.threshold() ?? null;
    const next = tau !== null && probAmong(logits, allowed, o.endLine!.id) >= tau ? o.endLine!.id : sample(logits, allowed, temperature, custom ? custom.topK : o.topK);
    o.observe?.(logits, allowed, next);
    out.push(next);
    if (next === lineId) inLine = true;
    else if (next === endLineId) inLine = false;
    ids = [...ids, next];
    if (rows && o.nextRow) rows = [...rows, o.nextRow(next)];
    if (o.inject && !o.stops.has(next) && out.length < o.maxTokens) {
      // A tool call: stream the call first (the chip shows it running), then wait for the result.
      post({ type: 'chat-update', id: o.id, parts: o.render(out), tokens: out.length, msPerToken: msPerToken(), done: false, prefillMs, ...o.extra });
      const extra = ((await o.inject(out, o.maxTokens - out.length)) ?? []).slice(0, o.maxTokens - out.length);
      for (const x of extra) {
        out.push(x);
        ids = [...ids, x];
        if (rows && o.nextRow) rows = [...rows, o.nextRow(x)];
      }
    }
    const done = o.stops.has(next) || out.length >= o.maxTokens || stopped.has(o.id) || !!o.until?.(out);
    post({ type: 'chat-update', id: o.id, parts: o.render(out), tokens: out.length, msPerToken: msPerToken(), done, prefillMs, ...o.extra });
    if (done) return out;
    // Let queued messages (stop, predict) in between steps.
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

async function chat(req: Extract<ToWorker, { type: 'chat' }>) {
  const t = tok!;
  if (!t.hasText) throw new Error('this model has no text tokenizer');
  let userParts: DialoguePart[] = [];
  if (req.fen) userParts.push({ kind: 'fen', fen: req.fen });
  userParts.push({ kind: 'text', text: req.prompt });
  if (req.context?.length) userParts.push({ kind: 'line', moves: req.context });
  if (req.contextText) userParts.push({ kind: 'text', text: req.contextText });
  const tools = req.tools?.names.length && t.supportsTools ? req.tools : null;
  if (tools) userParts = addToolsBlock(userParts, tools.names);
  // Models without the tool tokens cannot read earlier answers' tool calls: leave them out
  if (!t.supportsTools) req.history = req.history.map((h) => ({ ...h, parts: h.parts.filter((p) => p.kind !== 'tool') }));
  // Earlier turns take at most half the context (the rest is for the think and the answer): oldest exchanges go first
  const history = [...req.history];
  let turns: DialogueTurn[] = [...history, { role: 'user', parts: userParts }];
  while (history.length && t.chatPrompt(turns).length > manifest!.max_seq_len / 2) {
    history.splice(0, history[1]?.role === 'assistant' ? 2 : 1);
    turns = [...history, { role: 'user', parts: userParts }];
  }
  // <|eos|> <|user|> ... <|assistant|>: the context every training dialogue has (the packer's separator first)
  const prefix = t.chatPrompt(turns);
  const { start } = dialoguePosition(turns);
  // Snapshots may rewind: the initial position and the positions along the game (the moves when only a FEN is sent)
  const positions = rewindCandidates(turns, req.gameMoves);
  debugTag = `chat ${req.id}`;
  debugMoves = null;
  const mode = req.think ?? 'auto';
  const thinking = t.supportsThinking && mode !== 'off';
  // The think fits the context: what the prompt and the answer leave (a quarter of it at least), as chat() in generate.py
  const maxCalls = tools ? (tools.maxCalls ?? MAX_TOOL_CALLS) : 0;
  const toolBudget = RESULT_BUDGET * maxCalls;
  const room = manifest!.max_seq_len - prefix.length - req.maxTokens - toolBudget - 3;
  const maxThink = Math.max(0, Math.min(req.maxThinkTokens ?? DEFAULT_MAX_THINK_TOKENS, Math.max(room, Math.floor((manifest!.max_seq_len - req.maxTokens) / 4))));
  const rules: LineRules = {
    ...DEFAULT_LINE_RULES,
    ...req.lineRules,
    endP: { ...DEFAULT_LINE_RULES.endP, ...req.lineRules?.endP },
    maxPlies: { ...DEFAULT_LINE_RULES.maxPlies, ...req.lineRules?.maxPlies },
  };
  const lines = new LineConstraint(t, start, positions, mode === 'on' ? true : mode === 'off' ? false : null, maxThink, rules);
  const under = positions[0];
  const toolConstraint = tools ? new ToolConstraint(lines, t, tools.names, under, maxCalls, tools.force ?? null, tools.takesLine ?? {}) : null;
  const constraint: GenConstraint = toolConstraint ?? lines;
  /** The calls made so far: where the tool ran and whether it answered (the text does not carry these). */
  const made: { fen: string; ok: boolean }[] = [];
  const inject = toolConstraint
    ? async (out: number[], room: number): Promise<number[] | null> => {
        if (out[out.length - 1] !== t.toolResultId) return null;
        toolConstraint.sync(out);
        const call = toolConstraint.pending();
        if (!call) return null;
        const title = TOOL_SPECS[call.name]?.title ?? 'Tool';
        const result = await askTool(req.id, made.length, call, tools!.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, title);
        const fit = fitToolResult(t, result, room, title);
        made.push({ fen: call.fen, ok: result.ok && fit.text !== '' && !fit.text.includes(': no result (') });
        return fit.ids;
      }
    : undefined;
  // v6 rows take the snapshots' clocks / castling / en passant from their FENs (not a text note)
  const tracker = manifest!.boards ? new BoardTracker(t, undefined, { ...boardOpts(), snapshotFens: dialogueSnapshotFens(turns) }) : null;
  const endThink = t.endThinkId;
  await generate({
    id: req.id,
    prefix,
    prefixRows: tracker?.rows(prefix),
    nextRow: tracker ? (id) => tracker.feed(id) : undefined,
    maxTokens: req.maxTokens + (thinking ? maxThink + 2 : 0) + toolBudget,
    inject,
    temperature: req.temperature,
    topK: req.topK,
    lineTemperature: req.lineTemperature ?? DEFAULT_LINE_TEMPERATURE,
    allowed: (out) => constraint.allowed(out),
    endLine: { id: t.endLineId, threshold: () => constraint.endThreshold() },
    stops: new Set([t.eosId, t.userId]),
    render: (out) => {
      const parts = t.decodeDialogueContent(out);
      if (made.length) {
        let k = 0;
        for (const p of parts) {
          const leaves = p.kind === 'think' ? p.parts : [p];
          for (const q of leaves) if (q.kind === 'tool' && k < made.length) Object.assign(q, made[k++]);
        }
      }
      if (parts[0]?.kind === 'think' && out[0] === t.thinkId) {
        const close = endThink === null ? -1 : out.indexOf(endThink);
        parts[0] = { ...parts[0], open: close < 0, tokens: (close < 0 ? out.length : close) - 1 };
      }
      return parts;
    },
  });
}

/** Pending `tool-call`s by `${request id}:${call index}`. */
const toolWaiters = new Map<string, (r: ToolResultData) => void>();

/** Ask the app to run a tool; an error result after `timeoutMs` or when the request is stopped. */
function askTool(id: number, call: number, info: ToolRequestInfo, timeoutMs: number, title: string): Promise<ToolResultData> {
  const key = `${id}:${call}`;
  return new Promise<ToolResultData>((resolve) => {
    const timer = setTimeout(() => finish({ text: errorText(title, 'timeout'), ok: false }), timeoutMs);
    const finish = (r: ToolResultData) => {
      clearTimeout(timer);
      if (toolWaiters.get(key) === finish) toolWaiters.delete(key);
      resolve(r);
    };
    toolWaiters.set(key, finish);
    // Snapshot and game FENs carry real move numbers here (the app's own positions)
    post({ type: 'tool-call', id, call, name: info.name, fen: info.fen, moves: info.moves, baseFen: info.baseFen, numbers: true });
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
      load(msg.base, msg.backend, msg.threads ?? 0, !!msg.debug).catch((err) => fail(err));
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
      pick(msg)
        .catch((err) => fail(err, msg.id))
        .finally(() => stopped.delete(msg.id));
      break;
    case 'stop':
      stopped.add(msg.id);
      for (const [key, finish] of toolWaiters) if (key.startsWith(`${msg.id}:`)) finish({ text: errorText('Tool', 'stopped'), ok: false });
      break;
    case 'tool-result':
      toolWaiters.get(`${msg.id}:${msg.call}`)?.({ text: msg.text, ok: msg.ok, compact: msg.compact });
      break;
  }
};

ctx.addEventListener('unhandledrejection', (ev) => post({ type: 'error', message: String((ev as PromiseRejectionEvent).reason) }));
