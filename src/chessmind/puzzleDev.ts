/*
 * `__chessmind.puzzle(...)` (devHook.ts): one Ask-ChessMind puzzle flow, headless -- the training layout with think
 * on, each try verified on a dedicated Stockfish and retried with the refutation (puzzleRun.ts, as the panel does).
 *
 *   await __chessmind.puzzle({ fen: 'r1bq3r/pp1nbkp1/2p1p2p/8/2BP4/1PN3P1/P3QP1P/3R1RK1 w - - 0 20', goal: 'mate 2' })
 *   await __chessmind.puzzle({ start: '<FEN before the last move>', setup: 'e8f7', goal: { kind: 'mate', n: 2 }, attempts: 3 })
 */
import { Chess } from 'chess.js';
import { DEFAULT_ENGINE_SETTINGS, resolveEngineSource } from '../engine/engines';
import { goalText, parseGoal, sanLine, sideName, type PuzzleGoal, type PuzzleSpec } from './puzzle';
import { EvalCache } from './puzzleVerify';
import { PuzzleEngine } from './puzzleEngine';
import { modelSolve, PUZZLE_GEN } from './puzzleRun';
import type { DevAnswer, DevAskOptions } from './devHook';

export interface DevPuzzleOptions {
  /** The puzzle position (the snapshot form) ... */
  fen?: string;
  /** ... or the position before the opponent's last move and that move (UCI or SAN; the last-move form). */
  start?: string;
  setup?: string;
  /** { kind, n } or "mate 2" / "win queen" / "piece" / "material" / "win" / "draw" / "best". */
  goal: PuzzleGoal | string;
  attempts?: number;
  /** A known solution from the puzzle position (UCI): counts as correct besides the engine check. */
  solution?: string[];
  /** false: verify without Stockfish (mates by the small search only). */
  engine?: boolean;
  model?: string;
  seed?: number;
  temperature?: number;
  maxThinkTokens?: number;
  maxTokens?: number;
}

let engine: PuzzleEngine | null = null;

export async function devPuzzle(o: DevPuzzleOptions, ask: (a: DevAskOptions) => Promise<DevAnswer>) {
  const goal = typeof o.goal === 'string' ? parseGoal(o.goal) : o.goal;
  if (!goal) throw new Error(`unknown goal ${JSON.stringify(o.goal)}`);
  let spec: PuzzleSpec;
  if (o.start && o.setup) {
    const b = new Chess(o.start);
    const w = o.setup;
    const mv = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(w) ? b.move({ from: w.slice(0, 2), to: w.slice(2, 4), promotion: w[4] }) : b.move(w);
    spec = { position: b.fen(), start: new Chess(o.start).fen(), setup: mv.from + mv.to + (mv.promotion ?? ''), goal };
  } else if (o.fen) spec = { position: new Chess(o.fen).fen(), goal };
  else throw new Error('give `fen`, or `start` + `setup`');
  if (o.solution?.length) spec.solution = o.solution;
  if (o.engine !== false && !engine) engine = new PuzzleEngine(() => resolveEngineSource({ ...DEFAULT_ENGINE_SETTINGS, enabled: true }, null));
  const evals = new EvalCache(o.engine === false ? null : engine);
  const answers: DevAnswer[] = [];
  const t0 = performance.now();
  const res = await modelSolve(spec, {
    attempts: o.attempts ?? 3,
    evals,
    ask: async (req) => {
      const a = await ask({
        prompt: req.label,
        parts: req.parts,
        history: req.history.map((t) => ({ role: t.role, parts: t.parts })),
        think: PUZZLE_GEN.think,
        maxThinkTokens: o.maxThinkTokens ?? PUZZLE_GEN.maxThinkTokens,
        maxTokens: o.maxTokens ?? PUZZLE_GEN.maxTokens,
        temperature: o.temperature ?? PUZZLE_GEN.temperature,
        seed: o.seed !== undefined ? o.seed + req.attempt - 1 : undefined,
        model: o.model,
      });
      answers.push(a);
      return { parts: a.parts, stopped: !!a.error };
    },
  });
  return {
    goal,
    question: goalText(goal, sideName(spec.position)),
    position: spec.position,
    start: spec.start ?? null,
    setup: spec.setup ?? null,
    solved: res.solved,
    ms: Math.round(performance.now() - t0),
    attempts: res.attempts.map((a, i) => ({
      attempt: a.attempt,
      prompt: answers[i]?.prompt,
      think: answers[i]?.think?.text ?? null,
      thinkTokens: answers[i]?.think?.tokens ?? 0,
      answer: answers[i]?.answer ?? a.answer,
      line: a.line ? sanLine(spec.position, a.line) : null,
      lineUci: a.line,
      where: a.where ?? null,
      ok: a.verdict?.ok ?? false,
      reason: a.verdict?.reason ?? a.reason ?? null,
      lineOk: a.lineOk ?? null,
      lineReason: a.lineReason ?? null,
      refutation: a.verdict?.line && a.verdict.line.length > 1 ? sanLine(spec.position, a.verdict.line) : null,
      reply: a.verdict?.reply ?? null,
      error: answers[i]?.error,
    })),
  };
}
