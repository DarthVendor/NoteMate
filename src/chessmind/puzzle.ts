/*
 * Puzzle mode: the exact user turns ChessMind was trained on for puzzles (ChessMind chessmind/data/puzzle_goals.py
 * `app_question` / `app_retry`, the Python source of truth; parity: src/chessmind/fixtures/puzzle-prompts.json,
 * scripts/test-puzzle.mjs), goal parsing (the /puzzle command, Lichess themes), the model's answer line and hints.
 *
 * Question: [goal text, snapshot before the opponent's last move, that move, position note] when the last move is
 * known, else [goal text, snapshot of the puzzle position, position note]. No [Engine] / [Candidates] block: it would
 * give the answer away and cue an engine review. A retry after a wrong answer appends the model's try in a canonical
 * short form ("I'd go for 20.Bxe6+.") and the refutation ("That doesn't work: 20.Bxe6+ Kf8.") with the puzzle
 * position again.
 */
import { Chess } from 'chess.js';
import type { DialoguePart, DialogueTurn } from './tokenizer';
import { numberedSan, positionNote } from './promptContext';

export type GoalKind = 'mate' | 'queen' | 'piece' | 'material' | 'win' | 'hold' | 'best';

export interface PuzzleGoal {
  kind: GoalKind;
  /** Mate in n (moves of the solver). */
  n?: number;
}

/** A position to solve. */
export interface PuzzleSpec {
  /** The puzzle position (full FEN), the solver to move. */
  position: string;
  /** The position before the opponent's last move and that move (UCI), when known. */
  start?: string;
  setup?: string;
  goal: PuzzleGoal;
  /** A known solution from `position` (UCI, the solver's move first; Lichess puzzles). */
  solution?: string[];
  /** Lichess puzzle id / rating / themes (trainer puzzles). */
  id?: string;
  rating?: number;
  themes?: string[];
}

export const GOAL_KINDS: { kind: GoalKind; label: string }[] = [
  { kind: 'mate', label: 'Mate in N' },
  { kind: 'queen', label: 'Win the queen' },
  { kind: 'piece', label: 'Win a piece' },
  { kind: 'material', label: 'Win material' },
  { kind: 'win', label: 'Win' },
  { kind: 'hold', label: 'Hold the draw' },
  { kind: 'best', label: 'Best move' },
];
export const MAX_MATE_N = 8;

export const sideName = (fen: string): 'White' | 'Black' => (fen.split(' ')[1] === 'b' ? 'Black' : 'White');
/** 'w' / 'b': the side to move of `fen`. */
export const sideOf = (fen: string): 'w' | 'b' => (fen.split(' ')[1] === 'b' ? 'b' : 'w');

/** The goal sentence (the first template of puzzle_goals.py); `side` is the solver. */
export function goalText(goal: PuzzleGoal, side: 'White' | 'Black'): string {
  switch (goal.kind) {
    case 'mate':
      return `${side} has a forced mate in ${goal.n ?? 1}. Find it.`;
    case 'queen':
      return `${side} can win the queen. How?`;
    case 'piece':
      return `${side} can win a piece. Find the move.`;
    case 'material':
      return `${side} can win material. Find the move.`;
    case 'win':
      return `${side} to play and win.`;
    case 'hold':
      return `${side} is in trouble. Find the move that holds.`;
    default:
      return `Find the best move for ${side}.`;
  }
}

/** The app-set goal of prompt-role models (<|goal|> in the system turn; ChessMind puzzle_goals.app_goal_text):
 * "White mates in 3." / "Black wins the queen." / "White holds the draw."; null for "best move". */
export function appGoalText(goal: PuzzleGoal, side: 'White' | 'Black'): string | null {
  switch (goal.kind) {
    case 'mate':
      return goal.n ? `${side} mates in ${goal.n}.` : `${side} mates.`;
    case 'queen':
      return `${side} wins the queen.`;
    case 'piece':
      return `${side} wins a piece.`;
    case 'material':
      return `${side} wins material.`;
    case 'win':
      return `${side} wins.`;
    case 'hold':
      return `${side} holds the draw.`;
    default:
      return null;
  }
}

/** Short goal label for the UI ("Mate in 2", "Win the queen" ...). */
export function goalLabel(goal: PuzzleGoal): string {
  if (goal.kind === 'mate') return goal.n ? `Mate in ${goal.n}` : 'Mate';
  return GOAL_KINDS.find((g) => g.kind === goal.kind)?.label ?? 'Best move';
}

/** `20.Bxe6+` / `37...Nf3+`: move number, "." (White) or "..." (Black), SAN. */
export function moveLabel(fen: string, uci: string): string {
  return numberedSan(fen, [uci]) || uci;
}

/** `20.Bxe6+ Kf8` / `37...Nf3+ 38.Kf1` (the legal prefix). */
export function sanLine(fen: string, moves: string[]): string {
  return numberedSan(fen, moves);
}

/** The question's user turn (app_question). */
export function questionTurn(spec: Pick<PuzzleSpec, 'position' | 'start' | 'setup' | 'goal'>): DialogueTurn {
  return goalTurn(goalText(spec.goal, sideName(spec.position)), spec);
}

/** The puzzle layout with a given goal sentence (a goal the user typed in the chat: their own words). */
export function goalTurn(text: string, spec: Pick<PuzzleSpec, 'position' | 'start' | 'setup'>): DialogueTurn {
  const parts: DialoguePart[] = [{ kind: 'text', text: text.trim() }];
  if (spec.start && spec.setup) parts.push({ kind: 'fen', fen: spec.start }, { kind: 'line', moves: [spec.setup] });
  else parts.push({ kind: 'fen', fen: spec.position });
  parts.push({ kind: 'text', text: positionNote(spec.position) });
  return { role: 'user', parts };
}

/** The two turns after a wrong answer (app_retry): the try as a short answer, then the refutation. */
export function retryTurns(position: string, tried: string, reply: string | null | undefined): DialogueTurn[] {
  const label = moveLabel(position, tried);
  const line = reply ? [tried, reply] : [tried];
  const refuted = reply ? `That doesn't work: ${sanLine(position, line)}.` : `${label}? That doesn't work.`;
  return [
    { role: 'assistant', parts: [{ kind: 'fen', fen: position }, { kind: 'text', text: `I'd go for ${label}.` }, { kind: 'line', moves: [tried] }] },
    { role: 'user', parts: [{ kind: 'text', text: refuted }, { kind: 'line', moves: line }, { kind: 'fen', fen: position }] },
  ];
}

/** The whole dialogue for attempt k: the question, then one retry pair per earlier wrong try. */
export function puzzleDialogue(spec: PuzzleSpec, tries: { tried: string; reply?: string | null }[]): DialogueTurn[] {
  const turns = [questionTurn(spec)];
  for (const t of tries) turns.push(...retryTurns(spec.position, t.tried, t.reply));
  return turns;
}

/** Plain text of a turn's text parts (what the chat shows for a user turn). */
export function turnText(turn: DialogueTurn): string {
  return turn.parts
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .filter(Boolean)
    .join(' ');
}

// ------------------------------------------------------------------------------------------------ goals

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/** The goal of "/puzzle <args>": "mate 3", "mate in 2", "m1", "win queen", "piece", "material", "win", "draw" /
 * "hold", "best". Empty args -> null (the panel's picker decides); unknown -> undefined. */
export function parseGoal(args: string): PuzzleGoal | null | undefined {
  const t = args.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!t) return null;
  let m = t.match(/^(?:#|m|mate|checkmate|mate ?in)\s*(?:in\s*)?(\d+|one|two|three|four|five|six|seven|eight)?$/);
  if (m) {
    const n = m[1] ? (NUM_WORDS[m[1]] ?? Number(m[1])) : 1;
    return { kind: 'mate', n: Math.max(1, Math.min(MAX_MATE_N, n)) };
  }
  if ((m = t.match(/^mate(\d+)$/))) return { kind: 'mate', n: Math.max(1, Math.min(MAX_MATE_N, Number(m[1]))) };
  if (/^(win (the |a )?)?queen$/.test(t)) return { kind: 'queen' };
  if (/^(win (a |the )?)?piece$/.test(t)) return { kind: 'piece' };
  if (/^(win )?material$/.test(t)) return { kind: 'material' };
  if (/^(win|winning|crush|crushing|decisive)$/.test(t)) return { kind: 'win' };
  if (/^(draw|hold|hold (the )?draw|save|defend|defence|defense|equality)$/.test(t)) return { kind: 'hold' };
  if (/^(best|best move|any|none)$/.test(t)) return { kind: 'best' };
  return undefined;
}

const NUM = '(\\d+|one|two|three|four|five|six|seven|eight)';
const numOf = (w: string) => Math.max(1, Math.min(MAX_MATE_N, NUM_WORDS[w] ?? Number(w)));

/** A puzzle goal stated in a chat message ("White has checkmate in 2", "Black to play and win", "find the mate",
 * "hold the draw"), else null. A mate without a number is any forced mate (`n` unset). Questions that only mention
 * mate ("is mate possible later?") are not goals. */
export function detectGoal(text: string): PuzzleGoal | null {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  let m = new RegExp(`\\b(?:check)?mates? in ${NUM}\\b`).exec(t);
  if (m) return { kind: 'mate', n: numOf(m[1]) };
  if ((m = /(?:^|[\s(])(?:M|#)(\d)\b/.exec(text))) return { kind: 'mate', n: numOf(m[1]) };
  if (
    /\b(?:find|show me|what'?s|where'?s|see) (?:the |a )?(?:forced )?(?:check)?(?:mate|mating (?:line|move|attack|combination|net))\b/.test(t) ||
    /\b(?:to play|to move) and (?:check)?mate\b/.test(t) ||
    /\b(?:has|there'?s|there is) (?:a )?forced (?:check)?mate\b/.test(t)
  )
    return { kind: 'mate' };
  if (/\bwins? (?:the|a|his|her|black'?s|white'?s|their) queen\b/.test(t)) return { kind: 'queen' };
  if (/\bwins? (?:a|the) (?:piece|knight|bishop)\b/.test(t)) return { kind: 'piece' };
  if (/\bwins? (?:a |the )?(?:rook|exchange)\b|\bwins? material\b/.test(t)) return { kind: 'material' };
  if (/\b(?:to play|to move) and win\b|\bfind (?:the )?(?:win|winning (?:move|line|combination|continuation|idea))\b/.test(t)) return { kind: 'win' };
  if (/\b(?:to play|to move) and draw\b|\b(?:hold|save) (?:the )?(?:draw|game|position)\b|\bfind (?:the )?(?:draw|drawing (?:move|line))\b/.test(t)) return { kind: 'hold' };
  return null;
}

/** The goal of a Lichess puzzle from its themes (moves: the full Lichess line, the opponent's move first): mateInN ->
 * mate in N (checked against the solution length), mate -> mate in the solution's moves, crushing / advantage -> win,
 * equality -> hold, else best move. */
export function goalFromThemes(themes: string[], moves: string[]): PuzzleGoal {
  const solverMoves = Math.max(1, Math.ceil((moves.length - 1) / 2));
  const mateIn = themes.map((t) => /^mateIn(\d)$/.exec(t)).find(Boolean);
  if (mateIn || themes.includes('mate')) {
    const n = mateIn ? Number(mateIn[1]) : solverMoves;
    return { kind: 'mate', n: n === solverMoves ? n : solverMoves };
  }
  if (themes.includes('crushing') || themes.includes('advantage')) return { kind: 'win' };
  if (themes.includes('equality')) return { kind: 'hold' };
  return { kind: 'best' };
}

// ------------------------------------------------------------------------------------------------ the answer

const key = (fen: string) => fen.split(' ').slice(0, 2).join(' ');

/** The legal prefix of `moves` from `fen`, as normalised UCI. */
export function legalPrefix(fen: string, moves: string[]): string[] {
  const b = new Chess(fen);
  const out: string[] = [];
  for (const m of moves) {
    try {
      const mv = b.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
      out.push(mv.from + mv.to + (mv.promotion ?? ''));
    } catch {
      break;
    }
  }
  return out;
}

/** Where the lines of the answer start (the dialogue's last snapshot; ChessMind dialogue_position). */
export function dialogueStart(turns: DialogueTurn[]): string | undefined {
  let start: string | undefined;
  for (const t of turns) for (const p of t.parts) if (p.kind === 'fen') start = p.fen;
  return start;
}

/** The lines of `parts` that start at (or pass through, via the opponent's setup move) the puzzle position. */
function linesAt(parts: DialoguePart[], spec: Pick<PuzzleSpec, 'position' | 'start' | 'setup'>, start: string | undefined): string[][] {
  const out: string[][] = [];
  let at = start;
  for (const p of parts) {
    if (p.kind === 'fen') at = p.fen;
    else if (p.kind === 'line' && p.moves.length) {
      let moves: string[] | null = null;
      if (at && key(at) === key(spec.position)) moves = p.moves;
      else if (at && spec.start && spec.setup && key(at) === key(spec.start) && p.moves[0] === spec.setup) moves = p.moves.slice(1);
      if (moves?.length) {
        const legal = legalPrefix(spec.position, moves);
        if (legal.length) out.push(legal);
      }
    }
  }
  return out;
}

/** The model's move line: the first answer line that starts at the puzzle position, else the think's last one.
 * `start`: where the dialogue's lines start (dialogueStart of the prompt turns). */
export function answerLine(parts: DialoguePart[], spec: Pick<PuzzleSpec, 'position' | 'start' | 'setup'>, start: string | undefined): { moves: string[]; where: 'answer' | 'think' } | null {
  const answer = parts.filter((p) => p.kind !== 'think');
  const first = linesAt(answer, spec, start)[0];
  if (first) return { moves: first, where: 'answer' };
  const think = parts.find((p) => p.kind === 'think');
  if (think?.kind === 'think') {
    const all = linesAt(think.parts, spec, start);
    if (all.length) return { moves: all[all.length - 1], where: 'think' };
  }
  return null;
}

/** The answer's text (think left out). */
export function answerText(parts: DialoguePart[], fen?: string): string {
  const words: string[] = [];
  let at = fen;
  for (const p of parts) {
    if (p.kind === 'text') words.push(p.text);
    else if (p.kind === 'fen') at = p.fen;
    else if (p.kind === 'line' && at) words.push(`[${sanLine(at, p.moves) || p.moves.join(' ')}]`);
  }
  return words.join(' ');
}

// ------------------------------------------------------------------------------------------------ hints

const PIECE_NAMES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** Hint `level` (1: the piece, 2: where it goes) for the move `uci` from `fen`. */
export function hintText(fen: string, uci: string, level: 1 | 2): string {
  const b = new Chess(fen);
  const piece = b.get(uci.slice(0, 2) as never) as { type: string } | undefined;
  const name = piece ? PIECE_NAMES[piece.type] : 'piece';
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  if (level === 1) return `Look at your ${name} on ${from}.`;
  let capture = false;
  let check = false;
  try {
    const mv = b.move({ from, to, promotion: uci[4] });
    capture = !!mv.captured;
    check = /[+#]$/.test(mv.san);
  } catch {
    /* an illegal hint move: just the square */
  }
  const how = capture ? `takes on ${to}` : `goes to ${to}`;
  return `The ${name} on ${from} ${how}${check ? ' with check' : ''}.`;
}

// ------------------------------------------------------------------------------------------------ trainer set

/** One trainer puzzle (public/puzzles/lichess.json row). */
export interface TrainerPuzzle {
  id: string;
  /** The position before the opponent's first move. */
  fen: string;
  /** UCI, moves[0] = the opponent's move played before the puzzle starts. */
  moves: string[];
  rating: number;
  themes: string[];
  heldout: boolean;
}

export interface TrainerSet {
  source: string;
  puzzles: TrainerPuzzle[];
  groups: string[];
  bands: [number, number][];
}

/** Parse the trainer JSON (rows with a `fields` header, or objects). */
export function parseTrainerSet(doc: unknown): TrainerSet {
  const d = doc as { source?: string; fields?: string[]; puzzles?: unknown[]; groups?: string[]; bands?: [number, number][] };
  if (!d || !Array.isArray(d.puzzles)) throw new Error('not a puzzle set');
  const fields = d.fields ?? ['id', 'fen', 'moves', 'rating', 'themes', 'heldout'];
  const puzzles = d.puzzles.map((row): TrainerPuzzle => {
    const o = (Array.isArray(row) ? Object.fromEntries(fields.map((f, i) => [f, row[i]])) : row) as Record<string, unknown>;
    const split = (v: unknown) => (Array.isArray(v) ? (v as string[]) : String(v ?? '').split(/\s+/).filter(Boolean));
    return { id: String(o.id), fen: String(o.fen), moves: split(o.moves), rating: Number(o.rating) || 0, themes: split(o.themes), heldout: !!o.heldout };
  });
  return { source: d.source ?? 'Lichess puzzle database, CC0', puzzles, groups: d.groups ?? [], bands: d.bands ?? [] };
}

/** The PuzzleSpec of a trainer puzzle: the position after the opponent's first move, the rest as the solution. */
export function trainerSpec(p: TrainerPuzzle): PuzzleSpec {
  const b = new Chess(p.fen);
  b.move({ from: p.moves[0].slice(0, 2), to: p.moves[0].slice(2, 4), promotion: p.moves[0][4] });
  return { position: b.fen(), start: new Chess(p.fen).fen(), setup: p.moves[0], goal: goalFromThemes(p.themes, p.moves), solution: p.moves.slice(1), id: p.id, rating: p.rating, themes: p.themes };
}

export const RATING_BANDS: { id: string; label: string; lo: number; hi: number }[] = [
  { id: 'any', label: 'Any rating', lo: 0, hi: 10_000 },
  { id: '600', label: '600–1000', lo: 0, hi: 1000 },
  { id: '1000', label: '1000–1400', lo: 1000, hi: 1400 },
  { id: '1400', label: '1400–1800', lo: 1400, hi: 1800 },
  { id: '1800', label: '1800–2200', lo: 1800, hi: 2200 },
  { id: '2200', label: '2200+', lo: 2200, hi: 10_000 },
];

export const TRAINER_THEMES: { id: string; label: string }[] = [
  { id: 'random', label: 'Random' },
  { id: 'mateIn1', label: 'Mate in 1' },
  { id: 'mateIn2', label: 'Mate in 2' },
  { id: 'mateIn3', label: 'Mate in 3' },
  { id: 'mateIn4', label: 'Mate in 4+' },
  { id: 'fork', label: 'Fork' },
  { id: 'pin', label: 'Pin' },
  { id: 'skewer', label: 'Skewer' },
  { id: 'discoveredAttack', label: 'Discovered attack' },
  { id: 'deflection', label: 'Deflection' },
  { id: 'hangingPiece', label: 'Hanging piece' },
  { id: 'sacrifice', label: 'Sacrifice' },
  { id: 'endgame', label: 'Endgame' },
  { id: 'crushing', label: 'Crushing' },
  { id: 'advantage', label: 'Advantage' },
  { id: 'equality', label: 'Equality' },
];

/** Puzzles matching a trainer theme and band ('mateIn4' also takes mateIn5). */
export function filterPuzzles(set: TrainerPuzzle[], theme: string, band: string): TrainerPuzzle[] {
  const b = RATING_BANDS.find((x) => x.id === band) ?? RATING_BANDS[0];
  return set.filter((p) => {
    if (p.rating < b.lo || p.rating >= b.hi) return false;
    if (theme === 'random') return true;
    if (theme === 'mateIn4') return p.themes.includes('mateIn4') || p.themes.includes('mateIn5');
    return p.themes.includes(theme);
  });
}
