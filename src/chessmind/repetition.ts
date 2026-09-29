/*
 * Repetition guard of a chat answer (port of ChessMind chessmind/model/repetition.py; parity:
 * scripts/test-repetition.mjs against fixtures/repetition.json from ChessMind's scripts/repetition_fixture.py).
 *
 * A small model sometimes falls into a degenerate loop ("The Queen's Gambit Declined is a Queen's Gambit Declined
 * with 2.c4 d5 [line] The Queen's Gambit Declined is ..." dozens of times) and never emits <|eos|>. Per phase (the
 * think, its running plan, the answer; each has its own history) the guard applies:
 * - a CTRL-style penalty: the logit of every word id (a text id with a letter or digit) among the phase's last
 *   `window` ids is divided by `penalty` when positive, multiplied when negative. Moves, line / branch / end
 *   markers, snapshot and special ids are never penalised;
 * - a no-repeat n-gram block inside runs of text ids (a line, snapshot or special id ends the run);
 * - a loop stop: a sentence (normalised: lower case, words only, lines kept as their ids) seen 3 times in the phase,
 *   the same move line twice in a row (back to back, or with 2+ moves) or 3 times ends the phase: the answer with
 *   <|eos|>, the think (and an open plan) with its close. The repeat is cut from what is shown (`keep`).
 * Tool calls (<|tool|> .. <|end_tool|>, the injected result included) are skipped.
 */
import type { ChessTokenizer } from './tokenizer';

export interface RepetitionRules {
  /** 1 = off. */
  penalty: number;
  /** Ids of the phase the penalty looks back over. */
  window: number;
  /** 0 = off. */
  ngram: number;
  stopLoops: boolean;
  sentenceRepeats: number;
  lineRepeats: number;
  /** A sentence counts toward the loop stop with this many words (or a move line). */
  minSentenceWords: number;
}

export const DEFAULT_REPETITION: RepetitionRules = { penalty: 1.15, window: 200, ngram: 8, stopLoops: true, sentenceRepeats: 3, lineRepeats: 3, minSentenceWords: 4 };

export type LoopPhase = 'think' | 'plan' | 'answer';
export interface LoopEvent {
  kind: 'sentence' | 'line';
  phase: LoopPhase;
  /** Output index where the guard took over. */
  at: number;
}

interface Phase {
  ids: number[];
  run: number[];
  ngrams: Map<string, Set<number>>;
  sentences: Map<string, number>;
  sent: number[];
  sentStart: number;
  pending: boolean;
  line: number[] | null;
  lines: Map<string, number>;
  lastLine: string | null;
  wordsSinceLine: number;
  afterLine: number;
}

const newPhase = (): Phase => ({ ids: [], run: [], ngrams: new Map(), sentences: new Map(), sent: [], sentStart: 0, pending: false, line: null, lines: new Map(), lastLine: null, wordsSinceLine: 0, afterLine: 0 });

/** Per-id flags from the raw byte-level BPE strings (as TokenClasses in Python). */
export interface TokenClasses {
  word: Uint8Array;
  space: Uint8Array;
  puncEnd: Uint8Array;
  newline: Uint8Array;
}

const classCache = new WeakMap<ChessTokenizer, TokenClasses>();

export function tokenClasses(t: ChessTokenizer): TokenClasses {
  const hit = classCache.get(t);
  if (hit) return hit;
  const n = t.size;
  const c: TokenClasses = { word: new Uint8Array(n), space: new Uint8Array(n), puncEnd: new Uint8Array(n), newline: new Uint8Array(n) };
  if (t.hasText) {
    for (let i = t.textOffset; i < t.extraOffset; i++) {
      const s = t.textTokenString(i);
      if (/[A-Za-z0-9]/.test(s)) c.word[i] = 1;
      if (/^[ĠĊĉ]/.test(s)) c.space[i] = 1;
      if (s.includes('Ċ')) c.newline[i] = 1;
      if (/[.!?]$/.test(s.replace(/[Ġ"')\]]+$/, ''))) c.puncEnd[i] = 1;
    }
  }
  classCache.set(t, c);
  return c;
}

export class RepetitionGuard {
  readonly rules: RepetitionRules;
  readonly cls: TokenClasses;
  private readonly t: ChessTokenizer;
  private readonly phases = new Map<string, Phase>();
  phase: 'start' | LoopPhase = 'start';
  private inTool = false;
  /** The phase a detected loop is closing. */
  private closing: string | null = null;
  readonly loops: LoopEvent[] = [];
  readonly cuts: [number, number][] = [];
  answerTokens = 0;
  private seen = 0;
  private k = -1;

  constructor(t: ChessTokenizer, rules: RepetitionRules = DEFAULT_REPETITION) {
    this.t = t;
    this.rules = rules;
    this.cls = tokenClasses(t);
  }

  private p(): Phase {
    let ph = this.phases.get(this.phase);
    if (!ph) this.phases.set(this.phase, (ph = newPhase()));
    return ph;
  }
  private isText(i: number): boolean {
    return i >= this.t.textOffset && i < this.t.extraOffset;
  }

  sync(out: number[]) {
    for (let k = this.seen; k < out.length; k++) {
      this.k = k;
      this.feed(out[k], k);
    }
    this.seen = Math.max(this.seen, out.length);
  }

  private feed(i: number, k: number) {
    const t = this.t;
    if (this.phase === 'start') {
      if (i === t.thinkId && t.endThinkId !== null) {
        this.phase = 'think';
        this.p().sentStart = k + 1;
        return;
      }
      this.phase = 'answer';
      this.p().sentStart = k;
    }
    if (this.inTool) {
      if (i === t.endToolId) this.inTool = false;
      return;
    }
    if (t.toolId !== null && i === t.toolId) {
      this.inTool = true;
      this.p().run = [];
      return;
    }
    if (this.phase === 'think' || this.phase === 'plan') {
      const noLine = this.p().line === null;
      if (i === t.endThinkId && noLine) {
        this.phase = 'answer';
        this.closing = null;
        this.p().sentStart = k + 1;
        return;
      }
      if (t.planId !== null && i === t.planId && this.phase === 'think' && noLine) {
        this.phase = 'plan';
        this.p().sentStart = k + 1;
        return;
      }
      if (t.endPlanId !== null && i === t.endPlanId && this.phase === 'plan' && noLine) {
        this.phase = 'think';
        return;
      }
    }
    if (this.phase === 'answer') this.answerTokens++;
    this.step(this.p(), i, k);
  }

  private step(p: Phase, i: number, k: number) {
    const t = this.t;
    const text = this.isText(i);
    if (p.pending) {
      p.pending = false;
      if (!text || this.cls.space[i]) this.endSentence(p, k);
    }
    p.ids.push(i);
    p.sent.push(i);
    if (p.line !== null) {
      p.line.push(i);
      if (i === t.endLineId) {
        this.endLine(p, p.line);
        p.line = null;
        p.afterLine = k + 1;
      }
      return;
    }
    if (i === t.lineId) {
      p.line = [i];
      p.run = [];
      return;
    }
    if (!text) {
      p.run = [];
      return;
    }
    if (this.cls.word[i]) p.wordsSinceLine++;
    const n = this.rules.ngram;
    if (n > 1) {
      if (p.run.length >= n - 1) {
        const key = p.run.slice(p.run.length - (n - 1)).join(',');
        let set = p.ngrams.get(key);
        if (!set) p.ngrams.set(key, (set = new Set()));
        set.add(i);
      }
      p.run.push(i);
    }
    if (this.cls.newline[i]) this.endSentence(p, k + 1);
    else if (this.cls.puncEnd[i]) p.pending = true;
  }

  private endSentence(p: Phase, startNext: number) {
    const sent = p.sent;
    const start = p.sentStart;
    p.sent = [];
    p.sentStart = startNext;
    const { key, words, hasLine } = this.normalise(sent);
    if (!key || (words < this.rules.minSentenceWords && !hasLine)) return;
    const c = (p.sentences.get(key) ?? 0) + 1;
    p.sentences.set(key, c);
    if (c >= this.rules.sentenceRepeats) this.loop('sentence', start);
  }

  private endLine(p: Phase, ids: number[]) {
    const key = ids.join(',');
    const moves = ids.filter((x) => this.t.isMoveId(x)).length;
    const backToBack = p.lastLine === key && (moves >= 2 || p.wordsSinceLine === 0);
    const c = (p.lines.get(key) ?? 0) + 1;
    p.lines.set(key, c);
    p.lastLine = key;
    p.wordsSinceLine = 0;
    if (backToBack || c >= this.rules.lineRepeats) this.loop('line', Math.max(p.sentStart, p.afterLine));
  }

  private normalise(ids: number[]): { key: string; words: number; hasLine: boolean } {
    const pieces: string[] = [];
    let run: number[] = [];
    let words = 0;
    let hasLine = false;
    const flush = () => {
      if (!run.length) return;
      const ws = this.t
        .decodeText(run)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(Boolean);
      words += ws.length;
      pieces.push(...ws);
      run = [];
    };
    for (const i of ids) {
      if (this.isText(i)) run.push(i);
      else {
        flush();
        pieces.push(`#${i}`);
        hasLine = hasLine || i === this.t.lineId;
      }
    }
    flush();
    return { key: pieces.join(' '), words, hasLine };
  }

  private loop(kind: LoopEvent['kind'], start: number) {
    if (!this.rules.stopLoops || this.closing !== null) return;
    this.closing = this.phase;
    this.loops.push({ kind, phase: this.phase as LoopPhase, at: this.k + 1 });
    this.cuts.push([start, this.k + 1]);
  }

  /** Word ids the penalty applies to at the next step (sorted). */
  penalized(): number[] {
    const p = this.phases.get(this.phase);
    if (this.rules.penalty === 1 || this.rules.window <= 0 || this.inTool || !p) return [];
    const set = new Set<number>();
    for (const i of p.ids.slice(-this.rules.window)) if (this.cls.word[i]) set.add(i);
    return [...set].sort((a, b) => a - b);
  }

  /** Text ids the n-gram block forbids at the next step (sorted). */
  banned(): number[] {
    const n = this.rules.ngram;
    const p = this.phases.get(this.phase);
    if (n <= 1 || this.inTool || !p || p.run.length < n - 1) return [];
    const set = p.ngrams.get(p.run.slice(p.run.length - (n - 1)).join(','));
    return set ? [...set].sort((a, b) => a - b) : [];
  }

  /** The id a detected loop forces next (<|eos|> / the think or plan close), else null. */
  forced(allowed?: Set<number> | null): number | null {
    if (this.closing === null) return null;
    const t = this.t;
    const ok = (x: number | null): x is number => x !== null && (!allowed || allowed.has(x));
    if (this.closing === 'answer') return ok(t.eosId) ? t.eosId : null;
    if (this.phase === 'plan' && ok(t.endPlanId)) return t.endPlanId;
    if (ok(t.endThinkId)) return t.endThinkId;
    return null;
  }

  /** One step: the penalty applied to `logits` in place, `allowed` without the banned ids (never empty), and the
   * forced id of a detected loop (or null). */
  shape(out: number[], logits: Float32Array, allowed: number[]): { allowed: number[]; forced: number | null } {
    this.sync(out);
    const f = this.forced(new Set(allowed));
    if (f !== null) return { allowed: [f], forced: f };
    const pen = this.rules.penalty;
    for (const i of this.penalized()) {
      const v = logits[i];
      logits[i] = v > 0 ? v / pen : v * pen;
    }
    const ban = this.banned();
    if (ban.length) {
      const b = new Set(ban);
      const left = allowed.filter((i) => !b.has(i));
      if (left.length) return { allowed: left, forced: null };
    }
    return { allowed, forced: null };
  }

  /** 'loop' when a loop ended the answer. */
  get stop(): 'loop' | null {
    return this.loops.some((e) => e.phase === 'answer') ? 'loop' : null;
  }

  /** `out` without the cut repeats. */
  keep(out: number[]): number[] {
    if (!this.cuts.length) return out;
    return out.filter((_, k) => !this.cuts.some(([a, b]) => a <= k && k < b));
  }
}
