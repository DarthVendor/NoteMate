/**
 * Approximate Elo per Stockfish "Skill Level", copied from ChessMind's chessmind/eval/engine.py (SKILL_ELO).
 * A community table derived from the UCI_Elo <-> skill mapping of older Stockfish releases and calibrated for
 * time-based play; with the short limits used here the real strength is lower. Treat it as a scale, not a rating.
 */
export const SKILL_ELO: Record<number, number> = {
  0: 1347, 1: 1490, 2: 1597, 3: 1694, 4: 1785, 5: 1871, 6: 1954, 7: 2035, 8: 2113, 9: 2189, 10: 2264,
  11: 2337, 12: 2409, 13: 2480, 14: 2550, 15: 2619, 16: 2686, 17: 2754, 18: 2820, 19: 2886, 20: 3190,
};

export const skillElo = (level: number) => SKILL_ELO[Math.max(0, Math.min(20, Math.round(level)))];

/** Elo difference implied by a score fraction (0..1), clamped away from 0 and 1 (same as engine.py). */
export function eloDiffFromScore(score: number, eps = 0.005): number {
  const s = Math.min(Math.max(score, eps), 1 - eps);
  return -400 * Math.log10(1 / s - 1);
}
