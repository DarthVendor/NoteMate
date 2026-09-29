/*
 * "Ask ChessMind" for a puzzle: ask with the training layout (think on), verify the model's line, and on a wrong try
 * retry with the refutation (puzzle.ts retryTurns), up to `attempts`. Shared by the panel (usePuzzle.ts: the answers
 * stream into the chat) and the dev hook (devHook.ts `puzzle`: headless, for batch runs).
 */
import type { DialoguePart, DialogueTurn } from './tokenizer';
import { answerLine, answerText, dialogueStart, puzzleDialogue, turnText, type PuzzleSpec } from './puzzle';
import { verifyMateLine, verifyMove, type EvalCache, type MoveVerdict } from './puzzleVerify';

/** Generation settings of a puzzle question (think forced on; the answer starts with the solution line). */
export const PUZZLE_GEN = { think: 'on' as const, maxThinkTokens: 1024, maxTokens: 160, temperature: 0.4 };

export interface PuzzleAsk {
  /** The question's user turn (exact parts) and the dialogue before it. */
  parts: DialoguePart[];
  history: DialogueTurn[];
  /** What the chat shows as the user message (the turn's text). */
  label: string;
  attempt: number;
}
export type PuzzleAskFn = (req: PuzzleAsk) => Promise<{ parts: DialoguePart[]; stopped?: boolean }>;

export interface PuzzleAttempt {
  attempt: number;
  /** The answer parts (think included) and its text. */
  parts: DialoguePart[];
  answer: string;
  /** The model's line from the puzzle position (answer's first line, else the think's last), or null. */
  line: string[] | null;
  where?: 'answer' | 'think';
  verdict: MoveVerdict | null;
  /** Mate goals: the whole line checks out (every solver move keeps the mate, it ends in mate). */
  lineOk?: boolean | null;
  lineReason?: string;
  /** Why the attempt failed without a verdict ("No move given"). */
  reason?: string;
  stopped?: boolean;
}

export interface PuzzleRunResult {
  solved: boolean | null;
  attempts: PuzzleAttempt[];
}

/** Run the model on a puzzle; `onAttempt` sees each attempt as soon as it is verified. `cancelled` stops early. */
export async function modelSolve(
  spec: PuzzleSpec,
  o: { ask: PuzzleAskFn; evals: EvalCache; attempts: number; onAttempt?: (a: PuzzleAttempt) => void; cancelled?: () => boolean; retries?: boolean },
): Promise<PuzzleRunResult> {
  const tries: { tried: string; reply?: string | null }[] = [];
  const out: PuzzleAttempt[] = [];
  let solved: boolean | null = false;
  for (let k = 1; k <= Math.max(1, o.attempts); k++) {
    if (o.cancelled?.()) break;
    const turns = puzzleDialogue(spec, tries);
    const last = turns[turns.length - 1];
    const res = await o.ask({ parts: last.parts, history: turns.slice(0, -1), label: turnText(last), attempt: k });
    const found = answerLine(res.parts, spec, dialogueStart(turns));
    const a: PuzzleAttempt = { attempt: k, parts: res.parts, answer: answerText(res.parts.filter((p) => p.kind !== 'think'), spec.position), line: found?.moves ?? null, where: found?.where, verdict: null, stopped: res.stopped };
    if (res.stopped && !found) {
      out.push({ ...a, reason: 'Stopped' });
      o.onAttempt?.(out[out.length - 1]);
      solved = null;
      break;
    }
    if (!found) {
      a.reason = 'No move given';
      out.push(a);
      o.onAttempt?.(a);
      if (o.retries === false) break;
      continue;
    }
    a.verdict = await verifyMove({ fen: spec.position, goal: spec.goal, known: spec.solution?.[0] }, found.moves[0], o.evals);
    if (spec.goal.kind === 'mate' && a.verdict.ok) {
      const lv = await verifyMateLine(spec.position, spec.goal.n ?? 1, found.moves, o.evals);
      a.lineOk = lv.ok;
      a.lineReason = lv.reason;
    }
    out.push(a);
    o.onAttempt?.(a);
    if (a.verdict.ok === true) {
      solved = true;
      break;
    }
    if (a.verdict.ok === null) {
      solved = null;
      break;
    }
    if (o.retries === false || res.stopped) break;
    // the same wrong try again gets the same refutation: keep one pair per distinct try
    if (!tries.some((t) => t.tried === a.verdict!.move)) tries.push({ tried: a.verdict.move, reply: a.verdict.reply ?? null });
  }
  return { solved, attempts: out };
}
