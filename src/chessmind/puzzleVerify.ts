/*
 * Puzzle verification: is a move (the model's, or the user's on the board) a solution of the goal?
 *
 * - mate in N: the move mates (N = 1), or after it the defender is mated within N-1 (Stockfish: the score from the
 *   defender's view is mate -k, k <= N-1; without an engine a small exhaustive search, N <= 3 and node-budgeted).
 * - win the queen / a piece / material / win: the known solution move, or Stockfish's eval after the move (solver's
 *   view) within 100 cp of the engine's best and at least +150 (win: +250); mate scores count as winning.
 * - hold: the eval after the move is at least -100.   - best move: within 50 cp of the engine's best.
 * `strict` (the Lichess rule, the trainer's user moves): only the solution move counts, or any move that mates.
 *
 * The engine is injected (VerifyEngine): puzzleEngine.ts runs a dedicated Stockfish, the tests stub it.
 */
import { Chess } from 'chess.js';
import type { PuzzleGoal } from './puzzle';
import { moveLabel, sanLine, sideName } from './puzzle';

/** One search result, side to move's point of view (as UCI engines report). */
export interface EngineEval {
  move: string | null;
  cp?: number;
  mate?: number;
  pv: string[];
  depth?: number;
}

export interface VerifyEngine {
  analyse(fen: string, limit: { depth: number; movetime: number }): Promise<EngineEval | null>;
}

export const MATE_SCORE = 100_000;
/** Depth for a mate check with `left` solver moves to go (2N+8, capped). */
export const mateDepth = (left: number) => Math.min(22, 2 * Math.max(1, left) + 8);
export const EVAL_DEPTH = 16;
export const MATE_MS = 5000;
export const EVAL_MS = 3000;

/** A score from the side to move's view, mates as +-(MATE_SCORE - distance); null without a score. */
export function scoreOf(e: EngineEval | null | undefined): number | null {
  if (!e) return null;
  if (e.mate !== undefined && e.mate !== null) {
    if (e.mate > 0) return MATE_SCORE - e.mate;
    return -MATE_SCORE - e.mate; // mate 0 (mated now) = -MATE_SCORE
  }
  return e.cp ?? null;
}

/** "+1.5" / "-0.3" / "mate in 3" / "getting mated in 2" for a solver-view score. */
export function scoreWords(score: number): string {
  if (score >= MATE_SCORE - 1000) return `mate in ${MATE_SCORE - score}`;
  if (score <= -MATE_SCORE + 1000) return `getting mated in ${Math.max(0, score + MATE_SCORE)}`;
  const v = score / 100;
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(1)}`;
}

// ------------------------------------------------------------------------------------------------ JS mate search

/** Search budget: moves played; the search gives up (null) when it runs out. */
export interface Budget {
  nodes: number;
}

const uciOf = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? '');

function ordered(c: Chess) {
  // checks and captures first: mates are usually found early
  const moves = c.moves({ verbose: true });
  const rank = (m: { san: string; captured?: string }) => (m.san.endsWith('#') ? 0 : m.san.endsWith('+') ? 1 : m.captured ? 2 : 3);
  return moves.sort((a, b) => rank(a) - rank(b));
}

/** Side to move mates within `n` moves: true / false, or null when the budget ran out. */
export function attackerMates(c: Chess, n: number, budget: Budget): boolean | null {
  const moves = ordered(c);
  if (moves.some((m) => m.san.endsWith('#'))) return true;
  if (n <= 1) return false;
  let unknown = false;
  for (const m of moves) {
    if (--budget.nodes < 0) return null;
    c.move(m);
    const r = defenderLoses(c, n - 1, budget);
    c.undo();
    if (r === true) return true;
    if (r === null) unknown = true;
  }
  return unknown ? null : false;
}

/** The side to move (the defender) is mated within `n` more attacker moves whatever it plays. */
export function defenderLoses(c: Chess, n: number, budget: Budget): boolean | null {
  if (c.isCheckmate()) return true;
  const moves = c.moves({ verbose: true });
  if (!moves.length || n < 1) return false; // stalemate, or no moves left to mate with
  let unknown = false;
  for (const m of moves) {
    if (--budget.nodes < 0) return null;
    c.move(m);
    const r = attackerMates(c, n, budget);
    c.undo();
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}

/** A defender reply after which the attacker has no mate within `n` (the refutation), if the search finds one. */
export function escapeReply(fen: string, n: number, maxNodes = 40_000): string | null {
  const c = new Chess(fen);
  const budget = { nodes: maxNodes };
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    const r = n < 1 ? false : attackerMates(c, n, budget);
    c.undo();
    if (r === false) return uciOf(m);
    if (budget.nodes < 0) return null;
  }
  return null;
}

/** The mating moves of `fen` within `n` (side to move), by exhaustive search. null = the budget ran out. */
export function findMates(fen: string, n: number, maxNodes = 60_000): string[] | null {
  const c = new Chess(fen);
  const budget = { nodes: maxNodes };
  const out: string[] = [];
  for (const m of ordered(c)) {
    if (m.san.endsWith('#')) {
      out.push(uciOf(m));
      continue;
    }
    if (n <= 1) continue;
    c.move(m);
    const r = defenderLoses(c, n - 1, budget);
    c.undo();
    if (r === null) return null;
    if (r) out.push(uciOf(m));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ verdicts

/** One step of a puzzle: the position (solver to move), the goal, and what is known. */
export interface StepContext {
  fen: string;
  goal: PuzzleGoal;
  /** Mate goals: solver moves left including this one (default goal.n). */
  left?: number;
  /** The known solution move at this step. */
  known?: string;
  /** Lichess rule: only `known`, or any mating move, counts. */
  strict?: boolean;
}

export interface MoveVerdict {
  /** null: could not be checked (no engine). */
  ok: boolean | null;
  move: string;
  /** "20.Bxe6+" */
  label: string;
  reason: string;
  /** The move mates. */
  mates?: boolean;
  /** The defender's best reply after the move (engine PV, the search's escape, or the known solution). */
  reply?: string | null;
  /** The move, the reply and a few more plies of the engine's line (the refutation of a wrong move). */
  line?: string[];
  /** Solver-view score after the move / of the engine's best move. */
  after?: number | null;
  best?: number | null;
  bestMove?: string | null;
}

/** Engine results by position (a puzzle revisits positions: hints, retries, the user's tries). */
export class EvalCache {
  private map = new Map<string, Promise<EngineEval | null>>();
  engine: VerifyEngine | null;
  constructor(engine: VerifyEngine | null) {
    this.engine = engine;
  }
  get(fen: string, depth: number, movetime: number): Promise<EngineEval | null> {
    const k = `${fen}|${depth}`;
    let hit = this.map.get(k);
    if (!hit) {
      const done = finished(fen);
      hit = done ? Promise.resolve(done) : this.engine ? this.engine.analyse(fen, { depth, movetime }).catch(() => null) : Promise.resolve(null);
      this.map.set(k, hit);
      hit.then((r) => {
        if (!r) this.map.delete(k);
      });
    }
    return hit;
  }
}

/** A finished position's "search": mated (mate 0) or drawn (cp 0), else null. */
export function finished(fen: string): EngineEval | null {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { move: null, mate: 0, pv: [] };
  if (c.isStalemate() || c.isInsufficientMaterial() || c.isDraw()) return { move: null, cp: 0, pv: [] };
  return null;
}

const THRESHOLDS: Record<string, number> = { queen: 150, piece: 150, material: 150, win: 250 };

/** Verify one solver move. */
export async function verifyMove(ctx: StepContext, move: string, evals: EvalCache): Promise<MoveVerdict> {
  const c = new Chess(ctx.fen);
  let mv;
  try {
    mv = c.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
  } catch {
    return { ok: false, move, label: move, reason: `${move} is not a legal move here.` };
  }
  const uci = uciOf(mv);
  const label = moveLabel(ctx.fen, uci);
  const after = c.fen();
  const solver = sideName(ctx.fen);
  if (c.isCheckmate()) return { ok: true, move: uci, label, reason: `${label} is checkmate.`, mates: true, after: MATE_SCORE };
  const goal = ctx.goal;
  // a mate goal without a number (a goal typed in the chat: "find the mate"): any forced mate
  const anyMate = goal.kind === 'mate' && !goal.n && ctx.left === undefined;
  const left = anyMate ? 99 : (ctx.left ?? goal.n ?? 1);
  if (ctx.known && uci === ctx.known) return { ok: true, move: uci, label, reason: `${label} is the solution move.` };

  // the refutation from the engine (also for a strict "no")
  const depth = goal.kind === 'mate' ? mateDepth(left) : EVAL_DEPTH;
  const ms = goal.kind === 'mate' ? MATE_MS : EVAL_MS;
  const refute = async (): Promise<{ e: EngineEval | null; line: string[]; reply: string | null }> => {
    const e = await evals.get(after, depth, ms);
    const pv = e?.pv ?? [];
    return { e, line: [uci, ...pv.slice(0, 3)], reply: pv[0] ?? e?.move ?? null };
  };

  if (ctx.strict) {
    const { e, line, reply } = await refute();
    const sc = scoreOf(e);
    const why = reply ? `After ${sanLine(ctx.fen, [uci, reply])}` : `After ${label}`;
    const tail = goal.kind === 'mate' ? ' there is no forced mate in time.' : sc !== null ? ` ${solver} is at ${scoreWords(-sc)}.` : ' that is not the solution.';
    return { ok: false, move: uci, label, reason: `${why}${tail}`, reply, line, after: sc === null ? null : -sc };
  }

  if (goal.kind === 'mate') {
    if (left <= 1) {
      const { reply, line } = await refute();
      return { ok: false, move: uci, label, reason: `${label} is not mate.`, reply, line };
    }
    const { e, line, reply } = await refute();
    if (e && e.mate !== undefined && e.mate !== null && e.mate < 0) {
      const k = -e.mate;
      if (k <= left - 1) return { ok: true, move: uci, label, reason: `${label} keeps a forced mate (${k} more move${k === 1 ? '' : 's'}).`, reply, line, after: MATE_SCORE - k };
      return { ok: false, move: uci, label, reason: `After ${sanLine(ctx.fen, [uci, reply ?? ''].filter(Boolean))} the mate takes ${k} more moves, not ${left - 1}.`, reply, line, after: MATE_SCORE - k };
    }
    if (e) {
      const sc = scoreOf(e);
      return { ok: false, move: uci, label, reason: `After ${sanLine(ctx.fen, [uci, reply ?? ''].filter(Boolean))} there's no mate${sc !== null ? ` (${solver} ${scoreWords(-sc)})` : ''}.`, reply, line, after: sc === null ? null : -sc };
    }
    // no engine: exhaustive search when small
    if (anyMate) {
      if (defenderLoses(new Chess(after), 2, { nodes: 60_000 }) === true) return { ok: true, move: uci, label, reason: `${label} keeps a forced mate.` };
    } else if (left - 1 <= 2) {
      const r = defenderLoses(new Chess(after), left - 1, { nodes: 60_000 });
      if (r === true) return { ok: true, move: uci, label, reason: `${label} keeps a forced mate.` };
      if (r === false) {
        const esc = escapeReply(after, left - 1);
        return { ok: false, move: uci, label, reason: esc ? `After ${sanLine(ctx.fen, [uci, esc])} there's no mate.` : `${label} does not force mate in ${left}.`, reply: esc, line: esc ? [uci, esc] : [uci] };
      }
    }
    return { ok: null, move: uci, label, reason: `Could not check ${label} (no engine).` };
  }

  // eval goals
  const [before, { e, line, reply }] = await Promise.all([evals.get(ctx.fen, depth, ms), refute()]);
  const got = scoreOf(e);
  const best = scoreOf(before);
  if (got === null) return { ok: null, move: uci, label, reason: `Could not check ${label} (no engine).`, reply, line };
  const solverScore = -got;
  const bestMove = before?.move ?? before?.pv[0] ?? null;
  const base = { move: uci, label, reply, line, after: solverScore, best, bestMove };
  const where = `After ${sanLine(ctx.fen, [uci, reply ?? ''].filter(Boolean))}`;
  const winning = solverScore >= MATE_SCORE - 1000;
  if (goal.kind === 'hold') {
    const ok = solverScore >= -100;
    return { ...base, ok, reason: ok ? `${label} holds (${scoreWords(solverScore)}).` : `${where} ${solver} is losing (${scoreWords(solverScore)}).` };
  }
  if (goal.kind === 'best') {
    if (best === null) return { ...base, ok: null, reason: `Could not check ${label} (no engine).` };
    const ok = uci === bestMove || solverScore >= best - 50 || (winning && best >= MATE_SCORE - 1000);
    return { ...base, ok, reason: ok ? `${label} is one of the best moves (${scoreWords(solverScore)}).` : `${where} ${solver} is at ${scoreWords(solverScore)}; the best move keeps ${scoreWords(best)}.` };
  }
  const need = THRESHOLDS[goal.kind] ?? 150;
  const close = best === null || uci === bestMove || solverScore >= best - 100 || (winning && best >= MATE_SCORE - 1000);
  const ok = close && (solverScore >= need || winning);
  return {
    ...base,
    ok,
    reason: ok ? `${label} wins (${scoreWords(solverScore)}).` : `${where} ${solver} is only at ${scoreWords(solverScore)}${best !== null && best > solverScore + 100 ? `; the best move keeps ${scoreWords(best)}` : ''}.`,
  };
}

/** A mate line of the model: every solver move keeps a forced mate in the moves left, and the line ends in mate.
 * `ok` null when a step could not be checked. */
export async function verifyMateLine(fen: string, n: number, line: string[], evals: EvalCache): Promise<{ ok: boolean | null; failedAt?: number; reason?: string }> {
  const c = new Chess(fen);
  let unknown = false;
  for (let i = 0; i < line.length; i++) {
    const at = c.fen();
    if (i % 2 === 0) {
      const left = n - i / 2;
      if (left < 1) return { ok: false, failedAt: i, reason: 'The line goes past the mate.' };
      const v = await verifyMove({ fen: at, goal: { kind: 'mate', n }, left }, line[i], evals);
      if (v.ok === false) return { ok: false, failedAt: i, reason: v.reason };
      if (v.ok === null) unknown = true;
    }
    try {
      c.move({ from: line[i].slice(0, 2), to: line[i].slice(2, 4), promotion: line[i][4] });
    } catch {
      return { ok: false, failedAt: i, reason: 'The line has an illegal move.' };
    }
  }
  if (!c.isCheckmate()) return { ok: unknown ? null : false, reason: 'The line stops before the mate.' };
  return { ok: unknown ? null : true };
}

/** The best move at a step (for hints, the defender's replies and "Show solution"): the known move, else the engine's. */
export async function bestMoveAt(fen: string, goal: PuzzleGoal, evals: EvalCache, known?: string, left?: number): Promise<{ move: string | null; pv: string[] }> {
  if (known) return { move: known, pv: [known] };
  if (goal.kind === 'mate' && !evals.engine && (left ?? goal.n ?? 1) <= 2) {
    const mates = findMates(fen, left ?? goal.n ?? 1);
    if (mates?.length) return { move: mates[0], pv: [mates[0]] };
  }
  const n = left ?? goal.n ?? 1;
  const e = await evals.get(fen, goal.kind === 'mate' ? mateDepth(n) : EVAL_DEPTH, goal.kind === 'mate' ? MATE_MS : EVAL_MS);
  return { move: e?.move ?? e?.pv[0] ?? null, pv: e?.pv ?? [] };
}
