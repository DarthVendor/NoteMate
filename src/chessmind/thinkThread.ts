/*
 * The running thread (ChessMind's chessmind.data.think_chain): earlier reasoning stays in the context of the next
 * think, exactly as ChessMind's training data shows it.
 *   - games (think-then-move): the model's earlier thinks sit in the game prompt right before the moves they
 *     preceded; the newest `maxPrior` are candidates, and until the prompt and the think budget fit the context the
 *     OLDEST full think with a plan shrinks to it (<|think|> <side> <|plan|> ... <|end_plan|> <|end_think|>), then
 *     the oldest think goes (training: data.game_thinks.chain drop_oldest / plan_part). Python twin:
 *     chessmind.model.think_move.prompt_with_thinks.
 *   - chat: earlier answers keep their think; when history + question pass the limit the earlier thinks shrink to
 *     their plan (prompt roles), then go (oldest first), then the oldest exchanges. Python twin:
 *     chessmind.model.generate.fit_history.
 * Parity: scripts/test-think-move.mjs (fixture think-move.json `chain` cases from ChessMind's think_move_fixture.py).
 */
import { ChessTokenizer, type DialoguePart, type DialogueTurn } from './tokenizer.ts';
import { anchorUserLines } from './snapshots.ts';

/** think_move.DEFAULT_MAX_PRIOR_THINKS. */
export const MAX_PRIOR_THINKS = 5;

export interface ThinkPrefix {
  ids: number[];
  /** First ply of the prompt (> 0: a cropped history, the board starts at the crop). */
  start: number;
  /** Plies whose thinks were kept. */
  kept: number[];
}

/**
 * `<|bos|> <|game|> <side> m_start ... m_n` (per-side models; `<|game|>` first otherwise) with the thinks of
 * `thinks` ({ply: <|think|> ... <|end_think|> ids}, the side to move's own plies) before their moves. `k` (a history
 * crop, the simulator's): the crop reaches back `k` plies before the oldest kept think (training crops at most 16
 * plies of history before an instance's first think); null = the whole game.
 */
export function thinkPrefixIds(t: ChessTokenizer, moves: string[], thinks: Record<number, number[]>, opts: { k: number | null; reserve: number; limit: number; perspectiveGames: boolean; maxPrior?: number }): ThinkPrefix {
  const perspective = opts.perspectiveGames ? ChessTokenizer.sideToMove(moves.length) : undefined;
  const own = moves.length % 2;
  const maxPrior = opts.maxPrior ?? MAX_PRIOR_THINKS;
  let plies = Object.keys(thinks).map(Number).filter((p) => p >= 0 && p < moves.length && p % 2 === own && thinks[p]?.length).sort((a, b) => a - b);
  plies = maxPrior > 0 ? plies.slice(Math.max(0, plies.length - maxPrior)) : [];
  const carried = new Map<number, number[]>();
  for (;;) {
    const start = opts.k === null ? 0 : Math.max(0, Math.min(moves.length - opts.k, plies.length ? plies[0] - opts.k : Infinity));
    const keep = new Set(plies);
    const ids = perspective ? [t.bosId, t.gameId, t.perspectiveId(perspective)] : [t.gameId];
    for (let i = start; i < moves.length; i++) {
      if (keep.has(i)) ids.push(...(carried.get(i) ?? thinks[i]));
      ids.push(t.moveToId(moves[i]));
    }
    if (ids.length + opts.reserve <= opts.limit || plies.length === 0) return { ids, start, kept: plies };
    // the oldest full think with a plan shrinks to it; once none is left, the oldest think goes
    const full = plies.filter((p) => !carried.has(p)).map((p) => [p, carriedThink(t, thinks[p])] as const).find(([, c]) => c !== null);
    if (full) carried.set(full[0], full[1]!);
    else {
      carried.delete(plies[0]);
      plies = plies.slice(1);
    }
  }
}

/** `<|think|> <side> <|plan|> ... <|end_plan|> <|end_think|>`: an earlier think reduced to its plan (the training's
 * carried plan), null without one (think_move.carried_think). */
export function carriedThink(t: ChessTokenizer, think: number[]): number[] | null {
  const p = t.planId;
  const e = t.endPlanId;
  if (p === null || e === null || t.endThinkId === null) return null;
  const i = think.indexOf(p);
  const j = think.indexOf(e);
  if (i < 0 || j <= i) return null;
  return [think[0], think[1], ...think.slice(i, j + 1), t.endThinkId];
}

/** `history` so that history + the question fit `limit` tokens (module doc). */
export function fitHistory(t: ChessTokenizer, history: DialogueTurn[], userParts: DialoguePart[], limit: number): DialogueTurn[] {
  const out = history.map((h) => ({ ...h, parts: [...h.parts] }));
  const size = () => t.chatPrompt(anchorUserLines([...out, { role: 'user', parts: userParts }])).length;
  // 1. earlier thinks shrink to their plan (prompt roles: the carried plan), oldest first; 2. then they go
  for (const h of out) {
    if (size() <= limit) return out;
    const th = h.parts[0];
    if (h.role === 'assistant' && th?.kind === 'think' && th.plan?.length && th.parts.length) {
      h.parts = [{ ...th, parts: [] }, ...h.parts.slice(1)];  // the carried plan: <|think|> <|plan|> ... <|end_think|>
    }
  }
  for (const h of out) {
    if (size() <= limit) return out;
    if (h.role === 'assistant' && h.parts[0]?.kind === 'think') h.parts = h.parts.slice(1);
  }
  while (out.length && size() > limit) out.splice(0, out[1]?.role === 'assistant' ? 2 : 1);
  return out;
}
