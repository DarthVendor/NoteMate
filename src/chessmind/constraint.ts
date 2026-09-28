/*
 * Generation constraints of a chat answer (ports of chessmind.model.generate.LineConstraint and
 * chessmind.model.tools.ToolConstraint): which ids may come next given the ids generated so far.
 */
import { Chess } from 'chess.js';
import type { ChessTokenizer } from './tokenizer';
import { DEFAULT_LINE_RULES, LineWatch, type LineRules } from './lineRules';
import { LineWalker } from './lines';
import { SnapshotPicker } from './snapshots';

/** What generate() needs from a constraint. */
export interface GenConstraint {
  allowed(out: number[]): number[];
  endThreshold(): number | null;
}

function legalUci(chess: Chess): string[] {
  return chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));
}

/**
 * Port of chessmind.model.generate.LineConstraint: text outside <|line|>, legal moves (+ <|end_line|>) inside.
 *
 * `start`: where lines begin (the user's FEN; undefined = the initial position). `positions`: candidate boards
 * (rewindCandidates: the position under discussion, the one before its last move, the initial position and the
 * positions along the user's game); when given (and the tokenizer can think), `<|fen|>` may be sampled and the side
 * + 64 piece tokens after it walk a trie of the candidates (snapshots.ts SnapshotPicker; forced once one is left),
 * which then becomes the start of later lines. Hidden reasoning (tokenizers with <|end_think|>): `think` true forces <|think|>
 * as the first token, false forbids it, null lets the model choose (first token only). Inside the think the turn
 * cannot end (no <|eos|> / <|user|>), <|end_think|> closes it outside a line, and after `maxThinkTokens` think
 * tokens the close is forced (<|end_line|> first when a line is open). <|end_think|> restores the line start that
 * was active before the think. A tokenizer without <|end_think|> gets exactly the old masks.
 */
export class LineConstraint implements GenConstraint {
  /** The open line (its board, plies and repetitions). */
  private line: LineWatch | null = null;
  /** Tokenizers with line branches / end markers: the open line's walker (branches, forced markers, lines.ts). */
  private walker: LineWalker | null = null;
  private readonly rules: LineRules;
  private readonly t: ChessTokenizer;
  private start: string | undefined;
  /** The last snapshot the model showed that is still in scope (a snapshot inside the think ends with it). */
  private shown: string | undefined;
  private outerShown: string | undefined;
  /** The boards a <|fen|> may show (a trie over their snapshot tokens). */
  private readonly snapshots: SnapshotPicker;
  private readonly endThink: number | null;
  readonly think: boolean | null;
  private readonly maxThinkTokens: number | null;
  private readonly textMask: number[];
  private readonly thinkTextMask: number[];
  private inThink = false;
  private thinkTokens = 0;
  private outerStart: string | undefined;
  private seen = 0;
  constructor(t: ChessTokenizer, start?: string, positions: string[] = [], think: boolean | null = null, maxThinkTokens: number | null = null, rules: LineRules = DEFAULT_LINE_RULES) {
    this.t = t;
    this.rules = rules;
    this.start = start;
    this.endThink = t.endThinkId;
    this.think = this.endThink !== null ? think : false;
    this.maxThinkTokens = maxThinkTokens;
    // Board snapshots only for models that can think (format 4 was trained with them; keep older masks unchanged).
    this.snapshots = new SnapshotPicker(t, this.endThink !== null ? positions : []);
    const base: number[] = [];
    for (let i = t.textOffset; i < t.extraOffset; i++) base.push(i);
    base.push(t.lineId);
    if (this.snapshots.size) base.push(t.fenId);
    this.textMask = [...base, t.eosId, t.userId];
    this.thinkTextMask = this.endThink !== null ? [...base, this.endThink] : base;
  }
  /** Where a line would start now (undefined = the initial position). */
  get lineStart(): string | undefined {
    return this.start;
  }
  /** The last snapshot the model showed, in scope. */
  get lastShown(): string | undefined {
    return this.shown;
  }
  /** Inside <|line|> ... <|end_line|> or a snapshot: no free text. */
  get busy(): boolean {
    return this.line !== null || this.snapshots.active;
  }
  private feedOne(id: number, index: number) {
    const t = this.t;
    if (this.inThink) this.thinkTokens++;
    if (this.snapshots.active) {
      const chosen = this.snapshots.feed(id);
      if (chosen !== null) this.start = this.shown = chosen;
      return;
    }
    if (index === 0 && id === t.thinkId && this.endThink !== null) {
      this.inThink = true;
      this.outerStart = this.start;
      this.outerShown = this.shown;
      return;
    }
    if (this.inThink && id === this.endThink) {
      this.inThink = false;
      this.start = this.outerStart;
      this.shown = this.outerShown;
      this.line = null;
      this.walker = null;
      return;
    }
    if (id === t.fenId && this.snapshots.size) this.snapshots.begin();
    else if (id === t.lineId) {
      this.line = new LineWatch(this.start);
      this.walker = t.supportsBranches ? new LineWalker(t, this.start) : null;
    } else if (id === t.endLineId) {
      this.line = null;
      this.walker = null;
    } else if (this.walker) this.walker.feed(id);
    else if (this.line && t.isMoveId(id)) this.line.push(t.idToMove(id));
  }
  /** Follow `out` up to (not including) index `upto`. */
  sync(out: number[], upto = out.length) {
    for (let i = this.seen; i < upto; i++) this.feedOne(out[i], i);
    this.seen = Math.max(this.seen, upto);
  }
  /** Inside a line with at least one move: the P(<|end_line|>) that ends it (think or answer threshold). */
  endThreshold(): number | null {
    if (!this.line || this.snapshots.active) return null;
    // the threshold is for <|end_line|>: not inside a branch, and only after a main-line move
    if (this.walker ? this.walker.inBranch || this.walker.plies === 0 : this.line.plies === 0) return null;
    return this.inThink ? this.rules.endP.think : this.rules.endP.answer;
  }
  allowed(out: number[]): number[] {
    this.sync(out);
    const t = this.t;
    if (this.snapshots.active) return this.snapshots.allowed();
    if (out.length === 0 && this.endThink !== null && this.think !== false) {
      if (this.think) return [t.thinkId];
      return [...this.textMask, t.thinkId];
    }
    const over = this.inThink && this.maxThinkTokens !== null && this.thinkTokens >= this.maxThinkTokens;
    if (this.line) {
      const max = this.inThink ? this.rules.maxPlies.think : this.rules.maxPlies.answer;
      // Branches and end markers: the walker forces the marker of a finished position (the repetition guard) and
      // closes open branches before the line when the budget or the length cap is spent.
      if (this.walker) return this.walker.allowed(over || this.walker.plies >= max);
      if (over) return [t.endLineId];
      if (this.line.plies >= max || (this.rules.stopFinished && this.line.ended())) return [t.endLineId];
      return [...legalUci(this.line.board).map((m) => t.moveToId(m)), t.endLineId];
    }
    if (this.inThink) return over ? [this.endThink!] : this.thinkTextMask;
    return this.textMask;
  }
}

/** A finished call waiting for its result: the tool, the position asked about (full FEN) and the call's line. */
export interface ToolRequestInfo {
  name: string;
  fen: string;
  /** The call's line (UCI from `baseFen`); empty = the current position was asked about. */
  moves: string[];
  baseFen?: string;
}

/** Most tool calls in one assistant turn (think + answer), as tools.MAX_CALLS in Python. */
export const MAX_TOOL_CALLS = 3;

/**
 * Port of chessmind.model.tools.ToolConstraint: the line constraint plus the call syntax. Outside calls it is the
 * inner constraint with `<|tool|>` added wherever free text is allowed (think and answer; not inside lines or
 * snapshots, not as a forced token) while fewer than `maxCalls` calls were made. After `<|tool|>`: the name's tokens (a
 * trie over the offered names), then `<|line|>` (tools that take one; the inner constraint makes its moves legal) and
 * `<|tool_result|>`; after the line only `<|tool_result|>`. The runtime then inserts the result and `<|end_tool|>`.
 * `force`: the first place a call may start gets exactly `<|tool|> force <|tool_result|>` (a demo for models not
 * trained with tools). `under`: the position under discussion (full FEN).
 */
export class ToolConstraint implements GenConstraint {
  private readonly codes: Map<string, number[]>;
  state: 'idle' | 'name' | 'line' | 'args' | 'wait' = 'idle';
  calls = 0;
  private prefix: number[] = [];
  private name: string | null = null;
  private moves: string[] = [];
  private base: string | undefined;
  private hasBase = false;
  private seen = 0;
  readonly inner: LineConstraint;
  private readonly t: ChessTokenizer;
  private readonly under: string | undefined;
  private readonly maxCalls: number;
  private readonly force: string | null;
  private readonly takesLine: Record<string, boolean>;
  constructor(inner: LineConstraint, t: ChessTokenizer, names: string[], under?: string, maxCalls = MAX_TOOL_CALLS, force: string | null = null, takesLine: Record<string, boolean> = {}) {
    this.inner = inner;
    this.t = t;
    this.under = under;
    this.maxCalls = maxCalls;
    this.force = force;
    this.takesLine = takesLine;
    if (!t.supportsTools) throw new Error('this tokenizer has no tool tokens');
    if (force !== null && !names.includes(force)) throw new Error(`cannot force ${force}: not one of ${names.join(', ')}`);
    this.codes = new Map(names.map((n) => [n, t.encodeText(n)]));
  }
  endThreshold(): number | null {
    return this.state === 'line' ? null : this.inner.endThreshold();
  }
  private matched(): string | null {
    for (const [n, code] of this.codes) if (code.length === this.prefix.length && code.every((c, i) => c === this.prefix[i])) return n;
    return null;
  }
  /** Follow `out` (the ids so far, inserted ones included). */
  sync(out: number[]) {
    const t = this.t;
    for (let i = this.seen; i < out.length; i++) {
      const id = out[i];
      if (this.state === 'idle') {
        if (id === t.toolId) {
          this.state = 'name';
          this.prefix = [];
          this.name = null;
          this.moves = [];
          this.hasBase = false;
          this.calls++;
        }
      } else if (this.state === 'name') {
        if (id === t.lineId) {
          this.name = this.matched();
          this.base = this.inner.lineStart;
          this.hasBase = true;
          this.state = 'line';
        } else if (id === t.toolResultId) {
          this.name = this.matched();
          this.state = 'wait';
        } else this.prefix.push(id);
      } else if (this.state === 'line') {
        if (t.isMoveId(id)) this.moves.push(t.idToMove(id));
        else if (id === t.endLineId) this.state = 'args';
      } else if (this.state === 'args') {
        if (id === t.toolResultId) this.state = 'wait';
      } else if (this.state === 'wait') {
        if (id === t.endToolId) this.state = 'idle';
      }
      this.inner.sync(out, i + 1);
    }
    this.seen = out.length;
  }
  /** The position a call without a line asks about: the last snapshot shown, else the position under discussion. */
  currentFen(): string {
    return this.inner.lastShown ?? this.under ?? this.inner.lineStart ?? new Chess().fen();
  }
  /** The finished call waiting for its result (after `<|tool_result|>`), else null. */
  pending(): ToolRequestInfo | null {
    if (this.state !== 'wait') return null;
    const name = this.name ?? '';
    if (!this.hasBase) return { name, fen: this.currentFen(), moves: [] };
    const c = new Chess(this.base);
    for (const u of this.moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    return { name, fen: c.fen(), moves: [...this.moves], baseFen: this.base ?? new Chess().fen() };
  }
  allowed(out: number[]): number[] {
    this.sync(out);
    const t = this.t;
    const inner = this.inner.allowed(out);
    if (this.state === 'name') {
      const ids = new Set<number>();
      for (const [n, code] of this.codes) {
        if (this.force !== null && n !== this.force) continue;
        if (code.length > this.prefix.length && this.prefix.every((c, i) => code[i] === c)) ids.add(code[this.prefix.length]);
      }
      const done = this.matched();
      if (done !== null) {
        ids.add(t.toolResultId!);
        if ((this.takesLine[done] ?? true) && this.force === null) ids.add(t.lineId);
      }
      if (!ids.size) ids.add(t.toolResultId!);
      return [...ids].sort((a, b) => a - b);
    }
    if (this.state === 'line') return inner;
    if (this.state === 'args') return [t.toolResultId!];
    if (this.state === 'wait') return [t.endToolId!]; // no runtime inserted a result: close it
    if (this.calls >= this.maxCalls || !this.textState(out, inner)) return inner;
    if (this.force !== null && this.calls === 0) return [t.toolId!];
    return [...inner, t.toolId!];
  }
  private textState(out: number[], mask: number[]): boolean {
    if (this.inner.busy) return false;
    if (mask.length <= 1) return false; // a forced token (<|think|> first, <|end_think|> over budget)
    if (this.force !== null && out.length === 0 && this.inner.think === null && this.t.endThinkId !== null) return false;
    return true;
  }
}
