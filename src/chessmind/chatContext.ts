/*
 * The chat glue of the anti-hallucination context (promptContext.ts) and the board-claim checker (claims.ts):
 * which context text goes with a question (the position note, an engine result for exactly that position, else the
 * model's own candidate moves), and which sentences of an answer contradict the board (marked, never removed).
 */
import { Chess } from 'chess.js';
import type { EngineLine } from '../engine/EngineClient';
import type { ChatLeafPart, ChatMessage, ChatPart } from '../types';
import { contextText, parseContext, type ContextEngineInfo } from './promptContext';
import { Board, doubledFiles, evalSpans, extractClaims, isolatedSquares, kingShelter, looseSquares, materialBalance, mobility, passedSquares, sentences, verify, type Claim } from './claims';
import { lineVariations } from './lines';
import { toolEvals } from './tools';

/** Engine results shallower than this are not sent (the first iterations of a search are noise). */
export const MIN_ENGINE_DEPTH = 10;

/** Placement, side, castling, en passant: the analysis of a position does not depend on the move counters. */
const posKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');

/** The engine's lines as a context engine result (White's view) when they were computed for exactly `fen`. */
export function engineInfoFor(fen: string, engine: { fen: string | null; lines: EngineLine[]; name?: string } | null | undefined, minDepth = MIN_ENGINE_DEPTH): ContextEngineInfo | null {
  if (!engine?.fen || posKey(engine.fen) !== posKey(fen)) return null;
  const sign = fen.trim().split(/\s+/)[1] === 'b' ? -1 : 1;
  const lines = [...engine.lines]
    .sort((a, b) => a.multipv - b.multipv)
    .filter((l) => l.pv.length && (l.cp !== undefined || l.mate !== undefined))
    .map((l) => ({ move: l.pv[0], cp: l.mate === undefined && l.cp !== undefined ? sign * l.cp : null, mate: l.mate !== undefined ? sign * l.mate : null, pv: l.pv }));
  const depth = engine.lines.find((l) => l.multipv === 1)?.depth ?? 0;
  if (!lines.length || depth < minDepth) return null;
  // Training blocks name the engine "Stockfish"; NoteMate's builds are "Stockfish 19 Lite" etc.
  const name = !engine.name || /stockfish/i.test(engine.name) ? 'Stockfish' : engine.name.split(/\s+/)[0];
  return { lines, depth, name };
}

export interface ChatContextInput {
  /** Full FEN of the position under discussion (the end of the question's line, or its snapshot). */
  fen: string;
  engine?: ContextEngineInfo | null;
  /** The model's policy for that position, best first. */
  candidates?: { uci: string; p: number }[] | null;
  sendEngine: boolean;
  sendCandidates: boolean;
}

/** The context part of a question: always the position note, then the engine block when there is a result for the
 * position, else the candidates block. */
export function chatContext(o: ChatContextInput): string {
  try {
    const engine = o.sendEngine && o.engine ? o.engine : null;
    const candidates = !engine && o.sendCandidates && o.candidates?.length ? o.candidates.map((c) => [c.uci, c.p] as [string, number]) : null;
    return contextText(o.fen, { engine, candidates });
  } catch {
    return '';
  }
}

/** Short label of a sent context ("engine +0.4 · d20", "candidates Nf3 71%"), '' when it had neither block. */
export function contextLabel(text: string | undefined): string {
  if (!text) return '';
  const p = parseContext(text);
  if (p.engine) return `engine ${p.engine.eval}${p.engine.depth ? ` · d${p.engine.depth}` : ''}`;
  if (p.candidates.length) return `candidates ${p.candidates[0][0].replace(/^\d+\.+/, '')} ${p.candidates[0][1]}%`;
  return '';
}

// ---------------------------------------------------------------------------------------------- claim scope
function replay(fen: string | undefined, moves: string[], out: string[]): Chess | null {
  let c: Chess;
  try {
    c = new Chess(fen);
  } catch {
    return null;
  }
  for (const u of moves) {
    try {
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch {
      break;
    }
    out.push(c.fen());
  }
  return c;
}

/** The position a question was about: its snapshot, else the end of its game line, else the initial position. */
export function questionFen(user: Pick<ChatMessage, 'fen' | 'context'> | undefined): string {
  if (user?.fen) return user.fen;
  const c = replay(undefined, user?.context ?? [], []);
  return c ? c.fen() : new Chess().fen();
}

/** Every position along parts' lines (all variations) and their snapshots; lines start at the latest snapshot. */
function partPositions(parts: ChatLeafPart[], startFen: string | undefined, out: string[]): void {
  let start = startFen;
  for (const p of parts) {
    if (p.kind === 'fen') {
      start = p.fen;
      out.push(p.fen);
    } else if (p.kind === 'line') {
      for (const v of lineVariations(p)) replay(start, v.moves, out);
    }
  }
}

/** [root, others] for checking answer `m`: the question's position, then the positions of the question's game line
 * and of every line / snapshot the answer and its reasoning show. */
export function claimScope(m: ChatMessage, user: ChatMessage | undefined): { root: Board; others: Board[] } {
  const rootFen = questionFen(user);
  const fens: string[] = [];
  if (!user?.fen && user?.context?.length) replay(undefined, user.context, fens);
  const think = m.parts[0]?.kind === 'think' ? m.parts[0].parts : [];
  partPositions(think, m.fen ?? user?.fen, fens);
  partPositions(m.parts.filter((p): p is ChatLeafPart => p.kind !== 'think'), m.fen ?? user?.fen, fens);
  const others: Board[] = [];
  for (const f of fens) {
    try {
      others.push(new Board(f));
    } catch {
      /* skip */
    }
  }
  return { root: new Board(rootFen), others };
}

// ------------------------------------------------------------------------------------------------- facts
const SIDE = (c: boolean) => (c ? 'White' : 'Black');
const FILES = 'abcdefgh';
const sqName = (s: number) => `${FILES[s & 7]}${(s >> 3) + 1}`;
const PIECE_NAME: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const sidesOf = (c: Claim) => (c.side === null ? [true, false] : [c.side]);
const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');

/** What the board says about a claim's subject (for the marker's tooltip). */
export function describeFact(c: Claim, b: Board): string {
  switch (c.kind) {
    case 'material': {
      const bal = materialBalance(b);
      return bal === 0 ? 'material is level' : `${SIDE(bal > 0)} is up ${Math.abs(bal)} point${Math.abs(bal) === 1 ? '' : 's'} of material`;
    }
    case 'doubled':
      return sidesOf(c)
        .map((s) => {
          const fs = [...doubledFiles(b, s)].sort().map((f) => `${FILES[f]}-file`);
          return fs.length ? `${SIDE(s)} has doubled pawns on the ${fs.join(', ')}` : `${SIDE(s)} has no doubled pawns`;
        })
        .join('; ');
    case 'isolated':
      return sidesOf(c).map((s) => `${SIDE(s)}'s isolated pawns: ${list([...isolatedSquares(b, s)].sort((x, y) => x - y).map(sqName))}`).join('; ');
    case 'passed':
      return sidesOf(c).map((s) => `${SIDE(s)}'s passed pawns: ${list([...passedSquares(b, s)].sort((x, y) => x - y).map(sqName))}`).join('; ');
    case 'piece_on':
    case 'hanging': {
      if (c.kind === 'hanging' && c.args[0] === 'none')
        return sidesOf(c).map((s) => `${SIDE(s)}'s loose pieces: ${list([...looseSquares(b, s)].sort((x, y) => x - y).map((q) => `${PIECE_NAME[b.at(q)!.type]} on ${sqName(q)}`))}`).join('; ');
      const sq = String(c.args[1]);
      const p = b.at(FILES.indexOf(sq[0]) + 8 * (Number(sq[1]) - 1));
      const what = p ? `${sq} has ${SIDE(p.color)}'s ${PIECE_NAME[p.type]}` : `${sq} is empty`;
      if (c.kind === 'piece_on' || !p) return what;
      const loose = looseSquares(b, p.color).has(FILES.indexOf(sq[0]) + 8 * (Number(sq[1]) - 1));
      return `${what}, which is ${loose ? '' : 'not '}loose`;
    }
    case 'check': {
      const k = b.king(b.turn);
      return k !== null && b.isCheck() ? `${SIDE(b.turn)} is in check` : 'no one is in check';
    }
    case 'shield':
      return sidesOf(c).map((s) => `${SIDE(s)}'s king has ${kingShelter(b, s)} pawn${kingShelter(b, s) === 1 ? '' : 's'} in front of it`).join('; ');
    case 'bishops':
      return sidesOf(c).map((s) => `${SIDE(s)} has ${b.squares('b', s).length} bishop${b.squares('b', s).length === 1 ? '' : 's'}`).join('; ');
    case 'to_move':
      return `${SIDE(b.turn)} is to move`;
    case 'mobility':
      return sidesOf(c).map((s) => `${SIDE(s)}'s pieces have ${mobility(b, s)} moves`).join('; ');
    case 'open_file': {
      const f = FILES.indexOf(String(c.args[0]));
      const w = b.squares('p', true).some((q) => (q & 7) === f);
      const bl = b.squares('p', false).some((q) => (q & 7) === f);
      return `the ${c.args[0]}-file is ${!w && !bl ? 'open' : w !== bl ? 'half-open' : 'closed'}`;
    }
  }
  return '';
}

// ------------------------------------------------------------------------------------------------ marking
export interface TextSegment {
  text: string;
  /** The sentence states something the board contradicts (tooltip text). */
  claim?: string;
  /** An engine-style evaluation the model could not have read anywhere (tooltip text). */
  evalNote?: string;
}

export const NO_ENGINE_NOTE = 'No engine result was given to the model: this evaluation is made up';

/** `text` split into segments with the sentences holding a false claim marked (and, when the prompt had no engine
 * block, eval-style numbers). Offsets map back onto the original text (claims.sentences normalises whitespace). */
export function markText(text: string, root: Board, others: Board[], flagEvals: boolean): TextSegment[] {
  // normalised index -> original index
  const map: number[] = [];
  let norm = '';
  for (const m of text.matchAll(/\S+/g)) {
    if (norm) {
      map.push(m.index! - 1);
      norm += ' ';
    }
    for (let k = 0; k < m[0].length; k++) map.push(m.index! + k);
    norm += m[0];
  }
  map.push(text.length);
  const ranges: { start: number; end: number; claim?: string; evalNote?: string }[] = [];
  let cursor = 0;
  for (const s of sentences(text)) {
    const at = norm.indexOf(s, cursor);
    if (at < 0) continue;
    cursor = at + s.length;
    const notes: string[] = [];
    for (const c of extractClaims(s)) {
      if (verify(c, root, others).verdict !== 'false') continue;
      const fact = describeFact(c, root);
      notes.push(`“${c.text}”${fact ? `: ${fact}` : ''}`);
    }
    if (notes.length) ranges.push({ start: map[at], end: map[at + s.length - 1] + 1, claim: `Doesn't match the board: ${notes.join('; ')}` });
  }
  if (flagEvals) for (const e of evalSpans(text)) ranges.push({ start: e.index, end: e.index + e.text.length, evalNote: NO_ENGINE_NOTE });
  if (!ranges.length) return [{ text }];
  // cut points; each piece carries the notes of the ranges covering it
  const cuts = [...new Set([0, text.length, ...ranges.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
  const out: TextSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    if (a >= b) continue;
    const seg: TextSegment = { text: text.slice(a, b) };
    for (const r of ranges) {
      if (r.start <= a && r.end >= b) {
        if (r.claim) seg.claim = r.claim;
        if (r.evalNote) seg.evalNote = r.evalNote;
      }
    }
    const last = out[out.length - 1];
    if (last && last.claim === seg.claim && last.evalNote === seg.evalNote) last.text += seg.text;
    else out.push(seg);
  }
  return out;
}

export interface MessageMarks {
  /** Answer text parts by part index (only parts with a mark). */
  answer: Map<number, TextSegment[]>;
  /** Think text parts by index inside the think part. */
  think: Map<number, TextSegment[]>;
  /** Marked sentences + eval numbers. */
  count: number;
}

/** Marks for every text part of answer `m` (asked by `user`). */
export function messageMarks(m: ChatMessage, user: ChatMessage | undefined): MessageMarks {
  const out: MessageMarks = { answer: new Map(), think: new Map(), count: 0 };
  let scope: ReturnType<typeof claimScope>;
  try {
    scope = claimScope(m, user);
  } catch {
    return out;
  }
  // An engine result in the question or in the answer's own tool calls: its numbers are not made up
  const flagEvals = !parseContext(user?.contextText).engine && !toolEvals(m.parts).length;
  const mark = (parts: ChatPart[], into: Map<number, TextSegment[]>) =>
    parts.forEach((p, i) => {
      if (p.kind !== 'text' || !p.text.trim()) return;
      const segs = markText(p.text, scope.root, scope.others, flagEvals);
      const n = segs.filter((s) => s.claim || s.evalNote).length;
      if (!n) return;
      out.count += n;
      into.set(i, segs);
    });
  if (m.parts[0]?.kind === 'think') mark(m.parts[0].parts, out.think);
  mark(m.parts, out.answer);
  return out;
}
