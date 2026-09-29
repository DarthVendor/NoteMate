import { createContext, useContext } from 'react';
import type { Chess, Move } from 'chess.js';
import type { EraseScope, GameAction } from '../state/gameReducer';
import type { Annotation, GameState } from '../types';
import type { Orientation } from '../components/boardGeometry';
import type { useEngine } from '../engine/useEngine';
import type { useChessMind } from '../chessmind/useChessMind';
import type { useSimulate } from '../simulate/useSimulate';
import type { UiSettings } from '../ui/settings';
import type { useGameReview } from '../review/useGameReview';
import type { SavedGame } from '../state/history';
import type { LayoutApi } from '../workspace/useLayout';

export interface ToastAction {
  label: string;
  run: () => void;
}

/** Everything a panel may need. Panels read it with `useApp()` instead of receiving props. */
export interface AppCtx {
  state: GameState;
  dispatch: (a: GameAction) => void;
  chess: Chess;
  fen: string;
  annotation: Annotation;
  lastMove?: Move;
  /** UCI moves from the standard start (null for custom-FEN games). */
  uciMoves: string[] | null;
  orientation: Orientation;
  flip: () => void;
  playUci: (uci: string) => void;
  engine: ReturnType<typeof useEngine>;
  chessmind: ReturnType<typeof useChessMind>;
  sim: ReturnType<typeof useSimulate>;
  /** Engine game review (Review panel). */
  review: ReturnType<typeof useGameReview>;
  /** Games put aside by imports, newest first. */
  savedGames: SavedGame[];
  /** Put a saved game back on the board (the current one is saved in its place). */
  restoreGame: (id: string) => void;
  ui: UiSettings;
  updateUi: (patch: Partial<UiSettings>) => void;
  layout: LayoutApi;
  /** Show a panel (placing it if hidden) and focus its tab. */
  revealPanel: (id: string) => void;
  /** A short message at the bottom; with an action (e.g. Undo) it stays about 6 s. */
  toast: (message: string, action?: ToastAction) => void;
  /** Erase side lines, arrows + highlights everywhere, or both, with an Undo toast. */
  erase: (scope: EraseScope) => void;
  openImport: () => void;
  exportPgn: (text?: string) => void;
  newGame: () => void;
  /** Start a new game from a FEN (validated; false if invalid), optionally shown from `orientation`. */
  setPosition: (fen: string, orientation?: Orientation) => boolean;
  /** Open the Set position dialog (FEN, board editor, current board). */
  openSetPosition: () => void;
  openPalette: () => void;
  openShortcuts: () => void;
}

/** Fired on window when the game is replaced by a new one (New game, Set position): an open puzzle session closes. */
export const GAME_RESET_EVENT = 'notemate:game-reset';

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppContext.Provider>');
  return ctx;
}
