/**
 * Game review maths, shared with ChessMind's labeller (chessmind/scrape/quality.py): a move is judged by the
 * mover's win-probability loss (Lichess's formula), not raw centipawns, so moves in decided positions are not
 * flagged. loss >= 20 blunder, >= 10 mistake, >= 5 inaccuracy.
 */
import type { MoveClass, ReviewSide, ReviewedMove } from '../types';

export const WIN_K = 0.00368208;
export const MATE_CP = 1000;
export const BLUNDER_WIN = 20;
export const MISTAKE_WIN = 10;
export const INACCURACY_WIN = 5;

/** Engine score from the side to move's point of view. */
export interface Score {
  cp?: number;
  mate?: number;
}

/** Centipawns from the side to move's view, clamped to +-MATE_CP (mate = +-MATE_CP; mate 0 = mated). */
export function scoreCp(s: Score): number {
  if (s.mate !== undefined) return s.mate > 0 ? MATE_CP : -MATE_CP;
  return Math.max(-MATE_CP, Math.min(MATE_CP, s.cp ?? 0));
}

/** Lichess win% (0..100) for a centipawn score from the mover's view. */
export function winPercent(cp: number): number {
  const c = Math.max(-MATE_CP, Math.min(MATE_CP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-WIN_K * c)) - 1);
}

export function classify(loss: number, playedBest: boolean): MoveClass {
  if (loss >= BLUNDER_WIN) return 'blunder';
  if (loss >= MISTAKE_WIN) return 'mistake';
  if (loss >= INACCURACY_WIN) return 'inaccuracy';
  return playedBest ? 'best' : 'good';
}

/** Lichess's per-move accuracy from the win% lost (100 = no loss). */
export function moveAccuracy(loss: number): number {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, loss)) - 3.1669));
}

/**
 * Judge each move of a line from the evaluations of every position on it.
 * `evals[i]` is the score of position i (before move i) from the side to move's view; `evals.length` must be
 * `moves.length + 1`. `best[i]` is the engine's best move (SAN) in position i.
 */
export function judgeMoves(
  moves: { nodeId: string; san: string }[],
  evals: Score[],
  best: (string | undefined)[],
  startPly = 0,
): ReviewedMove[] {
  return moves.map((m, i) => {
    const before = winPercent(scoreCp(evals[i]));
    const after = winPercent(-scoreCp(evals[i + 1]));
    const loss = Math.max(0, before - after);
    const playedBest = !best[i] || best[i] === m.san;
    return {
      nodeId: m.nodeId,
      ply: startPly + i + 1,
      san: m.san,
      before: round1(before),
      after: round1(after),
      loss: round1(loss),
      cls: classify(loss, playedBest),
      ...(playedBest ? {} : { best: best[i] }),
    };
  });
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Accuracy (mean of the arithmetic and harmonic means of move accuracies) and error counts for one side. */
export function sideSummary(moves: ReviewedMove[]): ReviewSide {
  const accs = moves.map((m) => moveAccuracy(m.loss));
  const mean = accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : 100;
  const harmonic = accs.length ? accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 1), 0) : 100;
  return {
    accuracy: round1((mean + harmonic) / 2),
    inaccuracies: moves.filter((m) => m.cls === 'inaccuracy').length,
    mistakes: moves.filter((m) => m.cls === 'mistake').length,
    blunders: moves.filter((m) => m.cls === 'blunder').length,
  };
}

/** Moves of White (odd plies) or Black (even plies). */
export const movesOf = (moves: ReviewedMove[], side: 'white' | 'black') => moves.filter((m) => (m.ply % 2 === 1) === (side === 'white'));

/** Sticky-note text for a flagged move. */
export function reviewNote(m: ReviewedMove): string {
  const label = m.cls === 'blunder' ? 'Blunder' : m.cls === 'mistake' ? 'Mistake' : 'Inaccuracy';
  return `${label} (−${Math.round(m.loss)}% win chance: ${Math.round(m.before)}% → ${Math.round(m.after)}%).${m.best ? ` Best was ${m.best}.` : ''}`;
}
