/*
 * Dev-only scripting hook: `window.__chessmind`, for driving a ChessMind model headlessly (scripts/cm-chat.mjs) with
 * exactly the product path (the same worker, int8 ONNX model, line rules, tools and claim checker as the chat panel).
 * Installed only when the page is opened with `?dev=1` or localStorage `notemate.dev` = '1' (main.tsx loads this
 * chunk lazily; the normal UI never does). It runs its own worker, independent of the panel's.
 *
 *   await __chessmind.loadModel('v5-250m-s95k')
 *   await __chessmind.ask({ prompt: 'Show me the Najdorf', seed: 1 })        // -> DevAnswer
 *   await __chessmind.predict({ moves: 'e4 c5 Nf3', top: 5 })                // -> top moves with probabilities
 */
import { Chess } from 'chess.js';
import ChessMindWorker from './worker.ts?worker&inline';
import { DEFAULT_LINE_TEMPERATURE, DEFAULT_MAX_THINK_TOKENS, DEFAULT_THINK_MOVE_TOKENS, type Backend, type ChatTrace, type FromWorker, type ModelManifest, type ThinkMode, type ToWorker } from './protocol';
import { historyParts, splitThink, type DialogueTurn } from './tokenizer';
import type { ChatLeafPart, ChatMessage, ChatPart, GameState, MoveNode } from '../types';
import { ROOT_ID } from '../types';
import { OFFERED_TOOLS, TOOL_SPECS, engineToolResult, errorText, type ToolResultData } from './tools';
import { chatContext, engineInfoFor, messageMarks } from './chatContext';
import { dialoguePosition } from './snapshots';
import { lineText } from './lines';
import { lineEnding } from './lineRules';
import { finishedResult, TOOL_ENGINE_DEPTH, TOOL_ENGINE_MS, TOOL_ENGINE_MULTIPV } from './useChessMindTools';
import { runNotesTool } from './notesTool';
import { EngineClient } from '../engine/EngineClient';
import { DEFAULT_ENGINE_SETTINGS, resolveEngineSource } from '../engine/engines';
import type { ChessMindModel } from './useChessMind';
import type { ContextEngineInfo } from './promptContext';

/** Moves as a list or a string: UCI or SAN, move numbers ("1.", "12...") ignored. */
type MovesInput = string | string[];

export interface DevTurn {
  role: 'user' | 'assistant';
  /** Plain text of the turn (ignored when `parts` is given). */
  text?: string;
  /** Exact dialogue parts (as returned in `history`). */
  parts?: ChatPart[];
  /** User turns: the board snapshot the question was about. */
  fen?: string;
}

export interface DevAskOptions {
  prompt: string;
  /** The position asked about (a board snapshot; lines start here). */
  fen?: string;
  /** Game moves from the initial position: sent as the question's line (no `fen`), or as the rewind candidates of a
   * snapshot (with `fen`, or `aboutPosition`). */
  moves?: MovesInput;
  /** With `moves` and no `fen`: ask about the position after them as a snapshot (the panel's "about position"). */
  aboutPosition?: boolean;
  history?: DevTurn[];
  /** Earlier answers keep their think in the history (default: the model's manifest think_chain, as the panel). */
  keepThinks?: boolean;
  think?: ThinkMode;
  temperature?: number;
  topK?: number;
  seed?: number;
  /** Start from an empty KV cache (default: when `seed` is set, so a seeded answer does not depend on what ran
   * before; cached prefixes shift the logits slightly). */
  freshCache?: boolean;
  /** The context part: a literal string, or 'auto' (position note + engine / the model's candidates, as the panel
   * sends to models trained on the ctx1 blocks; any model when forced with 'auto!'). */
  contextText?: string;
  /** With contextText 'auto': run Stockfish on the position and send the [Engine] block (else candidates). */
  engineContext?: boolean;
  /** Tool calling: true / 'on' (engine, notes, all_notes), 'force' (first engine call forced), or tool names. */
  tools?: boolean | 'on' | 'off' | 'force' | string[];
  /** Notes for the notes tools, keyed by ply along `moves` (1 = on the first move) or 'start'. */
  notes?: Record<string, string | string[]>;
  maxTokens?: number;
  maxThinkTokens?: number;
  lineTemperature?: number;
  lineRules?: Extract<ToWorker, { type: 'chat' }>['lineRules'];
  /** Load this model first when another one is loaded. */
  model?: string;
  timeoutMs?: number;
}

export interface DevLine {
  where: 'think' | 'answer';
  san: string;
  uci: string[];
  plies: number;
  /** End marker the model wrote (<|mate|> / <|draw|> / <|repetition|>). */
  mark?: string;
  /** The finished position the line reached (checkmate, stalemate, draws), if any. */
  finished?: string | null;
  /** rule (length cap or finished position), threshold (P(end) >= the end-line threshold), model, or open. */
  reason: string;
  pEnd?: number;
}

export interface DevAnswer {
  model: string;
  prompt: string;
  seed?: number;
  think: { text: string; tokens: number; open: boolean } | null;
  answer: string;
  /** Raw parts (think included), and the question's context part as sent. */
  parts: ChatPart[];
  contextText?: string;
  tokens: number;
  ms: number;
  prefillMs?: number;
  msPerToken: number;
  stop: string;
  promptTokens?: number;
  lines: DevLine[];
  tools: { where: 'think' | 'answer'; name: string; line?: string; result?: string; ok?: boolean }[];
  flags: { where: 'think' | 'answer'; text: string; claim?: string; evalNote?: string }[];
  /** `history` + this exchange, ready to pass back as the next ask's `history`. */
  history: DevTurn[];
  error?: string;
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** UCI moves from `fen` (default: the initial position) for UCI / SAN input. */
export function parseMoves(input: MovesInput | undefined, fen?: string): string[] {
  if (!input) return [];
  const words = (Array.isArray(input) ? input : input.split(/\s+/)).map((w) => w.trim().replace(/^\d+\.+/, '')).filter((w) => w && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(w));
  const c = new Chess(fen);
  const out: string[] = [];
  for (const w of words) {
    let m;
    try {
      m = UCI.test(w) ? c.move({ from: w.slice(0, 2), to: w.slice(2, 4), promotion: w[4] }) : c.move(w);
    } catch {
      throw new Error(`illegal move "${w}" after ${out.length} plies`);
    }
    out.push(m.from + m.to + (m.promotion ?? ''));
  }
  return out;
}

function fenAfter(moves: string[], fen?: string): string {
  const c = new Chess(fen);
  for (const u of moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return c.fen();
}

/** A one-line game tree with notes keyed by ply (1 = the first move) or 'start'. */
function notesGame(moves: string[], notes: Record<string, string | string[]> | undefined): GameState {
  const note = (k: string) => {
    const v = notes?.[k];
    return (Array.isArray(v) ? v : v ? [v] : []).map((text, i) => ({ id: `n${k}-${i}`, text, color: 'yellow', createdAt: 0 }));
  };
  const ann = (k: string) => ({ arrows: [], highlights: [], notes: note(k) }) as unknown as MoveNode['annotation'];
  const nodes: Record<string, MoveNode> = { [ROOT_ID]: { id: ROOT_ID, san: '', parent: null, children: [], annotation: ann('start') } };
  const c = new Chess();
  let parent = ROOT_ID;
  moves.forEach((u, i) => {
    const san = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san;
    const id = `m${i + 1}`;
    nodes[id] = { id, san, parent, children: [], annotation: ann(String(i + 1)) };
    nodes[parent].children.push(id);
    parent = id;
  });
  return { version: 2, startFen: new Chess().fen(), nodes, currentId: parent, meta: {} } as GameState;
}

class DevChessMind {
  private worker: Worker | null = null;
  private reqId = 0;
  private listeners = new Map<number, (m: FromWorker) => void>();
  private engine: Promise<EngineClient> | null = null;
  private engineChain: Promise<unknown> = Promise.resolve();
  /** The notes game of the running ask (the notes tools read it). */
  private game: GameState | null = null;
  modelId: string | null = null;
  info: { manifest: ModelManifest; backend: string; loadMs: number; cached: boolean; thinking: boolean; threads?: number } | null = null;
  private catalog: ChessMindModel[] | null = null;

  async models(): Promise<ChessMindModel[]> {
    if (!this.catalog) this.catalog = (await (await fetch('chessmind/models.json')).json()) as ChessMindModel[];
    return this.catalog;
  }

  async loadModel(id: string, opts: { backend?: Backend; threads?: number; timeoutMs?: number } = {}) {
    const list = await this.models();
    if (!list.some((m) => m.id === id)) throw new Error(`unknown model ${id} (have: ${list.map((m) => m.id).join(', ')})`);
    this.unload();
    const worker = new ChessMindWorker();
    this.worker = worker;
    const ready = new Promise<NonNullable<DevChessMind['info']>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`loading ${id} timed out`)), opts.timeoutMs ?? 600_000);
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve({ manifest: m.manifest, backend: m.backend, loadMs: Math.round(m.loadMs), cached: m.cached, thinking: m.thinking, threads: m.threads });
        } else if (m.type === 'error' && m.id === undefined) {
          clearTimeout(timer);
          reject(new Error(m.message));
        } else if ('id' in m && m.id !== undefined) this.listeners.get(m.id)?.(m);
        else if (m.type === 'error') for (const l of this.listeners.values()) l(m);
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'worker failed'));
      };
    });
    worker.postMessage({ type: 'load', base: new URL(`chessmind/${id}/`, location.href).href, backend: opts.backend ?? 'auto', threads: opts.threads } satisfies ToWorker);
    try {
      this.info = await ready;
    } catch (e) {
      this.unload();
      throw e;
    }
    this.modelId = id;
    const { manifest, ...rest } = this.info;
    return { model: id, ...rest, params: manifest.params, step: manifest.step, maxSeqLen: manifest.max_seq_len, kvCache: !!manifest.kv_cache };
  }

  unload() {
    this.worker?.terminate();
    this.worker = null;
    this.info = null;
    this.modelId = null;
    for (const l of this.listeners.values()) l({ type: 'error', message: 'model unloaded' });
    this.listeners.clear();
  }

  private async ensure(model?: string) {
    if (model && model !== this.modelId) await this.loadModel(model);
    if (!this.worker) throw new Error('no model loaded (loadModel(id) or pass `model`)');
    return this.worker;
  }

  /** Top moves (legal-masked probabilities) after `moves` from the initial position, or after `moves` from `fen`
   * (board models: a board-only prompt). */
  async predict(o: { fen?: string; moves?: MovesInput; top?: number; contextPlies?: number | null; model?: string }) {
    const worker = await this.ensure(o.model);
    const moves = parseMoves(o.moves, o.fen);
    const id = ++this.reqId;
    const r = await new Promise<Extract<FromWorker, { type: 'prediction' }>>((resolve, reject) => {
      this.listeners.set(id, (m) => {
        if (m.type === 'prediction') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      });
      worker.postMessage({ type: 'predict', id, moves, top: o.top ?? 5, contextPlies: o.contextPlies ?? null, ...(o.fen ? { startFen: new Chess(o.fen).fen() } : {}) } satisfies ToWorker);
    }).finally(() => this.listeners.delete(id));
    const c = new Chess(fenAfter(moves, o.fen));
    const san = (u: string) => new Chess(c.fen()).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san;
    return { model: this.modelId, fen: c.fen(), moves: r.moves.map((m) => ({ uci: m.uci, san: san(m.uci), p: Math.round(m.p * 10000) / 10000 })), ms: Math.round(r.ms), tokens: r.tokens };
  }

  private engineClient(): Promise<EngineClient> {
    if (this.engine) return this.engine;
    const source = resolveEngineSource({ ...DEFAULT_ENGINE_SETTINGS, enabled: true }, null);
    if (!source) return Promise.reject(new Error('no Stockfish build'));
    const ready = (async () => {
      const c = new EngineClient(source.script, source.remote);
      await c.init();
      await c.setOption('Threads', 1);
      await c.setOption('Hash', 16);
      await c.newGame();
      return c;
    })();
    ready.catch(() => (this.engine = null));
    this.engine = ready;
    return ready;
  }

  /** Stockfish (the Lite single-threaded build) on `fen`, as the context / tool engine result. */
  private engineInfo(fen: string): Promise<ContextEngineInfo | null> {
    const job = this.engineChain.then(async () => {
      const c = await this.engineClient();
      const lines = await c.searchLines(fen, { depth: TOOL_ENGINE_DEPTH, movetime: TOOL_ENGINE_MS }, TOOL_ENGINE_MULTIPV, TOOL_ENGINE_MS + 8000);
      return engineInfoFor(fen, { fen, lines, name: c.info.name }, 1);
    });
    this.engineChain = job.catch(() => undefined);
    return job;
  }

  private async runTool(name: string, fen: string, numbers: boolean): Promise<ToolResultData> {
    if (name === 'notes' || name === 'all_notes') return runNotesTool(this.game, name, fen);
    if (name !== 'engine') return { text: errorText(name, 'unknown tool'), ok: false };
    const done = finishedResult(fen);
    if (done) return done;
    try {
      const info = await this.engineInfo(fen);
      return info ? engineToolResult(fen, info, numbers) : { text: errorText('Engine', 'no line'), ok: false };
    } catch (e) {
      return { text: errorText('Engine', /timed out/.test(String(e)) ? 'timeout' : 'error'), ok: false };
    }
  }

  /**
   * Think-then-move along a given game (teacher-forced: the game's moves are played whatever the model picks): at
   * each of `plies` (the side to move's own plies) the model thinks and picks, with its earlier thinks of this call
   * in the prompt when `keep` (default true: the running thread, as Simulate plays) -- the chain-coherence battery.
   */
  async thinkGame(o: { moves: MovesInput; plies: number[]; keep?: boolean; think?: ThinkMode; seed?: number; temperature?: number; maxThinkTokens?: number; maxPriorThinks?: number; contextPlies?: number | null; model?: string; timeoutMs?: number }) {
    const worker = await this.ensure(o.model);
    const moves = parseMoves(o.moves);
    const thinks: Record<number, number[]> = {};
    const rows: { ply: number; fen: string; played: string; picked: string | null; think: string | null; raw?: string; tokens: number; open: boolean; promptTokens: number; kept: number; ms: number }[] = [];
    for (const ply of [...o.plies].sort((a, b) => a - b)) {
      if (ply < 0 || ply >= moves.length) continue;
      const prefix = moves.slice(0, ply);
      const fen = fenAfter(prefix);
      const id = ++this.reqId;
      const t0 = performance.now();
      const kept = o.keep === false ? 0 : Object.keys(thinks).filter((p) => Number(p) % 2 === ply % 2).length;
      const r = await new Promise<Extract<FromWorker, { type: 'picked' }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), o.timeoutMs ?? 300_000);
        this.listeners.set(id, (m) => {
          if (m.type === 'picked') {
            clearTimeout(timer);
            resolve(m);
          } else if (m.type === 'error') {
            clearTimeout(timer);
            reject(new Error(m.message));
          }
        });
        worker.postMessage({
          type: 'pick', id, moves: prefix, temperature: o.temperature ?? 0, contextPlies: o.contextPlies ?? null, think: o.think ?? 'on',
          maxThinkTokens: o.maxThinkTokens ?? DEFAULT_THINK_MOVE_TOKENS, lineTemperature: DEFAULT_LINE_TEMPERATURE, seed: o.seed ?? 1,
          ...(o.keep === false ? {} : { thinks: { ...thinks }, maxPriorThinks: o.maxPriorThinks }),
        } satisfies ToWorker);
      }).finally(() => this.listeners.delete(id));
      if (r.think?.ids) thinks[ply] = r.think.ids;
      rows.push({
        ply, fen, played: moves[ply], picked: r.uci, think: r.think ? thinkPlain(r.think.parts, fen) : null, raw: r.think?.raw, tokens: r.think?.tokens ?? 0,
        open: !!r.think?.open, promptTokens: r.tokens - (r.think?.ids?.length ?? 0) - 1, kept, ms: Math.round(performance.now() - t0),
      });
    }
    return { model: this.modelId, moves, keep: o.keep !== false, rows };
  }

  async ask(o: DevAskOptions): Promise<DevAnswer> {
    const worker = await this.ensure(o.model);
    const model = this.modelId!;
    const t0 = performance.now();
    const text = o.prompt.trim();
    const moves = parseMoves(o.moves);
    const fen = o.fen ? new Chess(o.fen).fen() : o.aboutPosition && moves.length ? fenAfter(moves) : undefined;
    const context = !fen && moves.length ? moves : undefined;
    const gameMoves = fen && moves.length ? moves : undefined;
    this.game = notesGame(moves, o.notes);
    // Earlier turns as the panel sends them: user = snapshot + text, assistant = the answer with its think (unless
    // keepThinks is false)
    const history: DialogueTurn[] = (o.history ?? []).map((h) => {
      const parts: ChatPart[] = h.parts ?? [{ kind: 'text', text: h.text ?? '' }];
      if (h.role === 'assistant') return { role: 'assistant', parts: historyParts(parts, o.keepThinks ?? !!this.info?.manifest.think_chain) };
      return { role: 'user', parts: h.fen && !parts.some((p) => p.kind === 'fen') ? [{ kind: 'fen', fen: h.fen }, ...parts] : parts };
    });
    // The context part
    let contextText = o.contextText;
    if (contextText === 'auto' || contextText === 'auto!') {
      const entry = (await this.models()).find((m) => m.id === model);
      const discussed = fen ?? (context ? fenAfter(context) : new Chess().fen());
      if (contextText === 'auto!' || entry?.contextBlocks) {
        const engine = o.engineContext ? await this.engineInfo(discussed).catch(() => null) : null;
        const candidates = engine ? null : (await this.predict({ fen: fen ? discussed : undefined, moves: fen ? undefined : context, top: 5 })).moves;
        contextText = chatContext({ fen: discussed, engine, candidates, sendEngine: true, sendCandidates: true });
      } else contextText = '';
    }
    const toolsMode = o.tools === true ? 'on' : o.tools || 'off';
    const names = Array.isArray(toolsMode) ? toolsMode : toolsMode === 'off' ? [] : OFFERED_TOOLS;
    const tools = names.length ? { names, takesLine: Object.fromEntries(names.map((n) => [n, TOOL_SPECS[n]?.takesLine ?? false])), force: toolsMode === 'force' ? 'engine' : null } : undefined;

    const id = ++this.reqId;
    let last: Extract<FromWorker, { type: 'chat-update' }> | null = null;
    let trace: ChatTrace | null = null;
    let error: string | undefined;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        error = 'timeout';
        worker.postMessage({ type: 'stop', id } satisfies ToWorker);
        setTimeout(resolve, 3000);
      }, o.timeoutMs ?? 300_000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      this.listeners.set(id, (m) => {
        if (m.type === 'chat-update') last = m;
        else if (m.type === 'chat-trace') {
          trace = m.trace;
          finish();
        } else if (m.type === 'error') {
          error = m.message;
          finish();
        } else if (m.type === 'tool-call')
          this.runTool(m.name, m.fen, m.numbers).then(
            (r) => worker.postMessage({ type: 'tool-result', id, call: m.call, text: r.text, ok: r.ok, compact: r.compact } satisfies ToWorker),
            () => worker.postMessage({ type: 'tool-result', id, call: m.call, text: errorText('Tool', 'error'), ok: false } satisfies ToWorker),
          );
      });
      worker.postMessage({
        type: 'chat',
        id,
        history,
        prompt: text,
        fen,
        context,
        gameMoves,
        contextText: contextText || undefined,
        maxTokens: o.maxTokens ?? 60,
        temperature: o.temperature ?? 0.8,
        topK: o.topK ?? 50,
        lineTemperature: o.lineTemperature ?? DEFAULT_LINE_TEMPERATURE,
        think: o.think ?? 'auto',
        maxThinkTokens: o.maxThinkTokens ?? DEFAULT_MAX_THINK_TOKENS,
        lineRules: o.lineRules,
        tools,
        seed: o.seed,
        freshCache: o.freshCache ?? o.seed !== undefined,
        trace: true,
      } satisfies ToWorker);
    });
    this.listeners.delete(id);
    const final = last as Extract<FromWorker, { type: 'chat-update' }> | null;
    const tr = trace as ChatTrace | null;
    const parts = final?.parts ?? [];
    return this.describe({ model, text, fen, context, contextText: contextText || undefined, history, parts, trace: tr, final, seed: o.seed, ms: performance.now() - t0, error, inHistory: o.history ?? [] });
  }

  private describe(a: {
    model: string;
    text: string;
    fen?: string;
    context?: string[];
    contextText?: string;
    history: DialogueTurn[];
    parts: ChatPart[];
    trace: ChatTrace | null;
    final: Extract<FromWorker, { type: 'chat-update' }> | null;
    seed?: number;
    ms: number;
    error?: string;
    inHistory: DevTurn[];
  }): DevAnswer {
    const userParts: ChatPart[] = [...(a.fen ? [{ kind: 'fen', fen: a.fen } as ChatPart] : []), { kind: 'text', text: a.text }, ...(a.context ? [{ kind: 'line', moves: a.context } as ChatPart] : [])];
    let start: string | undefined;
    try {
      start = dialoguePosition([...a.history, { role: 'user', parts: userParts }]).start;
    } catch {
      start = a.fen; // an inconsistent dialogue (the worker reports the error too)
    }
    const lines: DevLine[] = [];
    const tools: DevAnswer['tools'] = [];
    const ends = a.trace?.lineEnds ?? [];
    let endIdx = 0;
    const lastLeaf = (() => {
      const top = a.parts[a.parts.length - 1];
      return top?.kind === 'think' ? top.parts[top.parts.length - 1] : top;
    })();
    const render = (leaves: ChatLeafPart[], where: 'think' | 'answer'): string =>
      leaves
        .map((p) => {
          if (p.kind === 'text') return p.text;
          if (p.kind === 'fen') {
            start = p.fen;
            return ` [board ${p.fen}] `;
          }
          if (p.kind === 'tool') {
            let line: string | undefined;
            if (p.moves?.length) {
              line = safeLine({ moves: p.moves }, p.fen ? undefined : start);
              endIdx++;
            }
            tools.push({ where, name: p.name, line, result: p.result, ok: p.ok });
            return ` {${p.name}${line ? ` ${line}` : ''} -> ${p.result ?? '…'}} `;
          }
          const san = safeLine(p, start);
          const open = p === lastLeaf && a.trace?.stop === 'budget';
          const e = open ? undefined : ends[endIdx++];
          lines.push({ where, san, uci: p.moves, plies: p.moves.length, ...(p.end ? { mark: p.end } : {}), finished: safeEnding(start, p.moves), reason: open ? 'open' : (e?.reason ?? '?'), ...(e ? { pEnd: Math.round(e.p * 1000) / 1000 } : {}) });
          return ` [[${san}]] `;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    const thinkPart = a.parts[0]?.kind === 'think' ? a.parts[0] : null;
    const think = thinkPart ? { text: render(thinkPart.parts, 'think'), tokens: thinkPart.tokens ?? 0, open: !!thinkPart.open } : null;
    const answerParts = splitThink(a.parts).answer;
    const answer = render(answerParts, 'answer');
    // Claim checker, as the panel marks the message
    const flags: DevAnswer['flags'] = [];
    try {
      const user: ChatMessage = { id: 'u', role: 'user', kind: 'model', parts: [{ kind: 'text', text: a.text }], fen: a.fen, context: a.context, contextText: a.contextText };
      const msg: ChatMessage = { id: 'a', role: 'assistant', kind: 'model', parts: a.parts, fen: a.fen };
      const mk = messageMarks(msg, user);
      for (const [where, map] of [['think', mk.think], ['answer', mk.answer]] as const)
        for (const segs of map.values()) for (const s of segs) if (s.claim || s.evalNote) flags.push({ where, text: s.text.trim(), ...(s.claim ? { claim: s.claim } : {}), ...(s.evalNote ? { evalNote: s.evalNote } : {}) });
    } catch {
      /* claim checker failure: no flags */
    }
    const userTurn: DevTurn = { role: 'user', text: a.text, ...(a.fen ? { fen: a.fen } : {}) };
    const f = a.final;
    return {
      model: a.model,
      prompt: a.text,
      ...(a.seed !== undefined ? { seed: a.seed } : {}),
      think,
      answer,
      parts: a.parts,
      ...(a.contextText ? { contextText: a.contextText } : {}),
      tokens: f?.tokens ?? 0,
      ms: Math.round(a.ms),
      prefillMs: f?.prefillMs !== undefined ? Math.round(f.prefillMs) : undefined,
      msPerToken: Math.round((f?.msPerToken ?? 0) * 10) / 10,
      stop: a.error ? `error: ${a.error}` : (a.trace?.stop ?? '?'),
      promptTokens: a.trace?.promptTokens,
      lines,
      tools,
      flags,
      history: [...a.inHistory, userTurn, { role: 'assistant', text: answer, parts: historyParts(a.parts, true) as ChatPart[] }],
      ...(a.error ? { error: a.error } : {}),
    };
  }
}

/** A think's parts as plain text (lines in SAN from `fen`), for the chain battery's scorer. */
function thinkPlain(parts: ChatLeafPart[], fen: string): string {
  return parts
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'line' ? `[${safeLine(p, fen)}]` : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeLine(line: Parameters<typeof lineText>[0], fen?: string): string {
  try {
    return lineText(line, fen) || line.moves.join(' ');
  } catch {
    return line.moves.join(' ');
  }
}

function safeEnding(fen: string | undefined, moves: string[]): string | null {
  try {
    return lineEnding(fen, moves);
  } catch {
    return null;
  }
}

export function installDevHook() {
  const dev = new DevChessMind();
  const api = {
    models: () => dev.models(),
    loadModel: (id: string, opts?: { backend?: Backend; threads?: number }) => dev.loadModel(id, opts),
    unload: () => dev.unload(),
    current: () => ({ model: dev.modelId, backend: dev.info?.backend ?? null, threads: dev.info?.threads ?? null }),
    ask: (o: DevAskOptions) => dev.ask(o),
    predict: (o: { fen?: string; moves?: MovesInput; top?: number; contextPlies?: number | null; model?: string }) => dev.predict(o),
    thinkGame: (o: Parameters<DevChessMind['thinkGame']>[0]) => dev.thinkGame(o),
  };
  (window as unknown as { __chessmind: typeof api }).__chessmind = api;
  document.documentElement.dataset.chessmindDev = 'ready';
  return api;
}
