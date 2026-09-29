import type { GameState } from '../types';
import { ROOT_ID } from '../types';
import { isStandardStart } from './position';

/**
 * Games put aside when another one is imported (e.g. from chess.com), newest first, so an import never loses
 * the game on the board. Restoring one swaps it with the current game.
 */
const KEY = 'notemate.history.v1';
export const HISTORY_LIMIT = 10;

export interface SavedGame {
  id: string;
  title: string;
  savedAt: number;
  state: GameState;
}

export function gameTitle(state: GameState): string {
  const { white, black, date, event } = state.meta;
  const moves = Math.ceil(countMainLine(state) / 2);
  const who = white || black ? `${white ?? '?'} – ${black ?? '?'}` : event || (isStandardStart(state.startFen) ? 'Analysis board' : 'Custom position');
  return [who, date?.replace(/\.\?\?/g, ''), `${moves} move${moves === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

function countMainLine(state: GameState): number {
  let n = 0;
  let node = state.nodes[ROOT_ID];
  while (node?.children.length) {
    node = state.nodes[node.children[0]];
    n++;
  }
  return n;
}

export function loadHistory(): SavedGame[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedGame[]) : [];
    return Array.isArray(list) ? list.filter((g) => g && g.state && g.state.nodes?.[ROOT_ID]) : [];
  } catch {
    return [];
  }
}

function saveHistory(list: SavedGame[]) {
  // Drop the oldest entries until it fits (a quota error would otherwise lose the whole list).
  for (let n = Math.min(list.length, HISTORY_LIMIT); n >= 0; n--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, n)));
      return;
    } catch {
      /* try with fewer games */
    }
  }
}

/** Keep `state` in the history (unless it has no moves and no notes from the standard start). Returns the new list. */
export function pushHistory(state: GameState): SavedGame[] {
  const list = loadHistory();
  const empty = Object.keys(state.nodes).length <= 1 && !state.nodes[ROOT_ID].annotation && isStandardStart(state.startFen);
  if (empty) return list;
  const entry: SavedGame = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: gameTitle(state), savedAt: Date.now(), state };
  const next = [entry, ...list].slice(0, HISTORY_LIMIT);
  saveHistory(next);
  return next;
}

/** Remove a saved game and return it (with the new list). */
export function takeHistory(id: string): { game: SavedGame | null; list: SavedGame[] } {
  const list = loadHistory();
  const game = list.find((g) => g.id === id) ?? null;
  const next = list.filter((g) => g.id !== id);
  if (game) saveHistory(next);
  return { game, list: next };
}
