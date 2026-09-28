/*
 * Inserting a ChessMind answer line with its branches into the move tree: the main line first (so it stays the first
 * child, the main continuation, wherever it is new), then every branch as a real variation from the line start
 * (resolveLine reuses the moves they share). Planned on a local copy of the reducer so the node ids of every
 * variation are known before dispatching.
 */
import type { GameAction } from '../state/gameReducer';
import { gameReducer, resolveLine } from '../state/gameReducer';
import type { ChatLinePart, ChatLineState, GameState } from '../types';
import { lineVariations, movesToPath } from './lines';

export interface LinePlan {
  /** ADD_LINE actions: the main line (carrying `notes`, going to `gotoIndex`), then each branch. */
  actions: GameAction[];
  state: Omit<ChatLineState, 'notes'>;
}

type Notes = Extract<GameAction, { type: 'ADD_LINE' }>['notes'];

/** Plan the insertion of `line` at `fromId`; null when the main line does not apply there. */
export function planLineInsert(state: GameState, fromId: string, line: ChatLinePart, mkId: () => string, gotoIndex: number, notes?: Notes): LinePlan | null {
  const vars = lineVariations(line);
  let s = state;
  const actions: GameAction[] = [];
  const done: { path: number[]; ids: string[]; created: boolean[] }[] = [];
  for (const v of vars) {
    const newIds = v.moves.map(() => mkId());
    const r = resolveLine(s, fromId, v.moves, newIds);
    if (!r) {
      if (!v.path.length) return null;
      continue; // a malformed branch: skip it
    }
    const main = !v.path.length;
    const action: GameAction = main
      ? { type: 'ADD_LINE', fromId, moves: v.moves, newIds, gotoIndex, notes }
      : { type: 'ADD_LINE', fromId, moves: v.moves, newIds, gotoIndex: 0 };
    s = gameReducer(s, action);
    actions.push(action);
    done.push({ path: v.path, ids: r.ids, created: r.created });
  }
  // Branch insertions move the board; end where the main line asked to.
  const [main, ...branches] = done;
  const target = gotoIndex <= 0 ? fromId : main.ids[Math.min(gotoIndex, main.ids.length) - 1];
  if (branches.length && target) actions.push({ type: 'GOTO', id: target });
  return { actions, state: { fromId, ids: main.ids, created: main.created, ...(branches.length ? { branches } : {}) } };
}

/** Node of the move at a chip path (lines.ts LineChip.path) in an inserted line, null when it is not in the tree. */
export function nodeAtPath(line: ChatLinePart, l: Omit<ChatLineState, 'notes'>, path: number[]): string | null {
  const varPath = path.slice(0, -1);
  const ids = varPath.length ? l.branches?.find((b) => b.path.join() === varPath.join())?.ids : l.ids;
  if (!ids) return null;
  return ids[movesToPath(line, path).length - 1] ?? null;
}

/** Every node id an inserted line owns (created by it): the first created node of each variation, for Discard. */
export function createdRoots(l: Omit<ChatLineState, 'notes'>): string[] {
  const out: string[] = [];
  for (const v of [...(l.branches ?? []), { ids: l.ids, created: l.created }]) {
    const k = v.created.indexOf(true);
    if (k >= 0) out.push(v.ids[k]);
  }
  return out;
}
