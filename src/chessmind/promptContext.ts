/*
 * App-provided context in a ChessMind user turn (twin of ChessMind's chessmind/data/prompt_context.py, checked against
 * fixtures/prompt_context.json by scripts/test-context.mjs). One text part, the last of the user turn, made of
 * bracketed blocks in a fixed order:
 *
 *   [Position: move 12, White to play] [Engine: Stockfish, depth 20 | eval +0.4 | best 12.Nf3 | line 12.Nf3 Nc6 13.d4 exd4 | also 12.d4 +0.2, 12.h3 +0.1] [Candidates: 12.Nd5 93%, 12.Bxf6 6%]
 *
 * The model sees the board but not the move number, an engine or its own policy; without these blocks it learned to
 * invent evaluations ("Evaluation: +0.4") and move numbers. Evaluations are from White's point of view.
 */
import { Chess } from 'chess.js';

export const MAX_LINE_PLIES = 8;
export const MAX_ALTERNATIVES = 2;
export const MAX_CANDIDATES = 4;
export const DEFAULT_ENGINE = 'Stockfish';

/** One engine line from the position: first move (UCI), score from WHITE's view, PV (UCI). */
export interface ContextEngineLine {
  move: string;
  /** Centipawns, White's view. */
  cp?: number | null;
  /** Moves to mate, White's view (> 0: White mates). */
  mate?: number | null;
  pv?: string[];
}

export interface ContextEngineInfo {
  lines: ContextEngineLine[];
  depth?: number | null;
  name?: string;
}

/** Python's round() (half to even) for a non-negative double. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** `+0.4` / `-1.2` / `0.0` / `#3` / `#-2` (White's view), exactly as Python's format_eval (`{cp / 100:+.1f}`). */
export function formatEval(cp: number | null | undefined, mate?: number | null): string {
  if (mate !== undefined && mate !== null && mate !== 0) return mate > 0 ? `#${mate}` : `#-${-mate}`;
  const c = Math.trunc(cp || 0);
  if (c === 0 || Math.abs(c) < 5) return '0.0';
  const a = Math.abs(c);
  let body: string;
  // |cp|/100 is an exact binary tie only when |cp| % 50 == 25 (x.x5 with 25 | cp): Python rounds those half to even,
  // toFixed rounds them up. Every other value rounds the same way in both (both use the exact double).
  if (a % 50 === 25) {
    let tenths = Math.floor(a / 10);
    if (tenths % 2 === 1) tenths += 1;
    body = `${Math.floor(tenths / 10)}.${tenths % 10}`;
  } else body = (a / 100).toFixed(1);
  return (c > 0 ? '+' : '-') + body;
}

function play(b: Chess, uci: string): string | null {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  try {
    return b.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return null;
  }
}

/** `12.Nf3 Nc6 13.d4` / `12...Nc6 13.d4` (the legal prefix of `moves`); numbers=false: `Nf3 Nc6 d4`. */
export function numberedSan(fen: string, moves: string[], maxPlies?: number, numbers = true): string {
  const b = new Chess(fen);
  const words: string[] = [];
  for (let i = 0; i < moves.length; i++) {
    if (maxPlies !== undefined && i >= maxPlies) break;
    const no = b.moveNumber();
    const white = b.turn() === 'w';
    const san = play(b, moves[i]);
    if (san === null) break;
    if (!numbers) words.push(san);
    else if (white) words.push(`${no}.${san}`);
    else if (i === 0) words.push(`${no}...${san}`);
    else words.push(san);
  }
  return words.join(' ');
}

/** `[Position: move 12, White to play]`. */
export function positionNote(fen: string): string {
  const b = new Chess(fen);
  return `[Position: move ${b.moveNumber()}, ${b.turn() === 'w' ? 'White' : 'Black'} to play]`;
}

export interface EngineBlockOptions {
  maxLinePlies?: number;
  alternatives?: number;
  showBest?: boolean;
  showLine?: boolean;
  numbers?: boolean;
}

/** `[Engine: Stockfish, depth 20 | eval +0.4 | best 12.Nf3 | line ... | also 12.d4 +0.2]` ('' without a scored line). */
export function engineBlock(fen: string, info: ContextEngineInfo, o: EngineBlockOptions = {}): string {
  const { maxLinePlies = MAX_LINE_PLIES, alternatives = MAX_ALTERNATIVES, showBest = true, showLine = true, numbers = true } = o;
  const lines = info.lines;
  if (!lines.length || ((lines[0].cp ?? null) === null && (lines[0].mate ?? null) === null)) return '';
  const head = (info.name ?? DEFAULT_ENGINE) + (info.depth ? `, depth ${Math.trunc(info.depth)}` : '');
  const top = lines[0];
  const fields = [`Engine: ${head}`, `eval ${formatEval(top.cp, top.mate)}`];
  const best = top.move ? numberedSan(fen, [top.move], undefined, numbers) : '';
  if (showBest && best) {
    fields.push(`best ${best}`);
    const pv = top.pv?.length && top.pv[0] === top.move ? [...top.pv] : [top.move, ...(top.pv ?? [])];
    const line = numberedSan(fen, pv, maxLinePlies, numbers);
    if (showLine && line.split(/\s+/).filter(Boolean).length > 1) fields.push(`line ${line}`);
    const alts: string[] = [];
    for (const l of lines.slice(1).filter((l) => l.move).slice(0, alternatives)) {
      const san = numberedSan(fen, [l.move], undefined, numbers);
      if (san) alts.push(`${san} ${formatEval(l.cp, l.mate)}`);
    }
    if (alts.length) fields.push(`also ${alts.join(', ')}`);
  }
  return `[${fields.join(' | ')}]`;
}

/** `[Candidates: 12.Nd5 93%, 12.Bxf6 6%]` from (uci, probability) pairs, best first (below 1% dropped, except the first). */
export function candidatesBlock(fen: string, candidates: [string, number][], limit = MAX_CANDIDATES, numbers = true): string {
  const out: string[] = [];
  for (const [i, [uci, p]] of candidates.slice(0, limit).entries()) {
    const pct = pyRound(100 * Number(p));
    if (i > 0 && pct < 1) break;
    const san = numberedSan(fen, [uci], undefined, numbers);
    if (san) out.push(`${san} ${i === 0 ? Math.max(pct, 1) : pct}%`);
  }
  return out.length ? `[Candidates: ${out.join(', ')}]` : '';
}

export interface ContextOptions extends EngineBlockOptions {
  note?: boolean;
  engine?: ContextEngineInfo | null;
  candidates?: [string, number][] | null;
}

/** The user turn's context part: the blocks that apply, space separated ('' when none). numbers=false: no position
 * note, moves without numbers (training only; NoteMate always knows the move number). */
export function contextText(fen: string, o: ContextOptions = {}): string {
  const { note = true, engine, candidates, numbers = true } = o;
  const blocks: string[] = [];
  if (note && numbers) blocks.push(positionNote(fen));
  if (engine) blocks.push(engineBlock(fen, engine, o));
  if (candidates?.length) blocks.push(candidatesBlock(fen, candidates, MAX_CANDIDATES, numbers));
  return blocks.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------------------------------------ reading back
export interface ParsedEngine {
  name: string;
  depth: number | null;
  eval: string | null;
  best: string | null;
  line: string | null;
  also: [string, string][];
}

export interface ParsedContext {
  move: number | null;
  white_to_play: boolean | null;
  engine: ParsedEngine | null;
  candidates: [string, number][];
}

const BLOCK_RE = /\[(Position|Engine|Candidates): ([^[\]]*)\]/g;

/** Read the blocks of contextText out of any text (missing blocks stay empty). */
export function parseContext(text: string | null | undefined): ParsedContext {
  const out: ParsedContext = { move: null, white_to_play: null, engine: null, candidates: [] };
  for (const [, kind, body] of (text ?? '').matchAll(BLOCK_RE)) {
    if (kind === 'Position') {
      const m = /^move (\d+), (White|Black) to play$/.exec(body.trim());
      if (m) {
        out.move = Number(m[1]);
        out.white_to_play = m[2] === 'White';
      }
    } else if (kind === 'Engine') {
      const fields = body.split('|').map((f) => f.trim());
      const eng: ParsedEngine = { name: fields[0], depth: null, eval: null, best: null, line: null, also: [] };
      const d = /depth (\d+)/.exec(fields[0]);
      if (d) {
        eng.depth = Number(d[1]);
        eng.name = fields[0].split(',')[0].trim();
      }
      for (const f of fields.slice(1)) {
        const sp = f.indexOf(' ');
        const key = sp < 0 ? f : f.slice(0, sp);
        const val = sp < 0 ? '' : f.slice(sp + 1);
        if (key === 'eval') eng.eval = val.trim();
        else if (key === 'best' || key === 'line') eng[key] = val.trim();
        else if (key === 'also') {
          for (const item of val.split(',')) {
            const t = item.trim();
            const k = t.lastIndexOf(' ');
            if (k >= 0) eng.also.push([t.slice(0, k), t.slice(k + 1)]);
          }
        }
      }
      out.engine = eng;
    } else {
      for (const item of body.split(',')) {
        const m = /^\s*(\S+) (\d+)%\s*$/.exec(item);
        if (m) out.candidates.push([m[1], Number(m[2])]);
      }
    }
  }
  return out;
}

/** Every evaluation the engine block of `text` states (the top one first). */
export function contextEvals(p: ParsedContext): string[] {
  if (!p.engine) return [];
  return [...(p.engine.eval ? [p.engine.eval] : []), ...p.engine.also.map(([, e]) => e)];
}

/** `text` without its bracketed context blocks. */
export function stripContext(text: string): string {
  return text.replace(BLOCK_RE, ' ').split(/\s+/).filter(Boolean).join(' ');
}
