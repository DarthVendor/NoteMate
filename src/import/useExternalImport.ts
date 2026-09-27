import { useCallback, useEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import type { GameAction } from '../state/gameReducer';
import { gameFromParsed, parsePgn } from '../state/pgn';
import { pushHistory, takeHistory, type SavedGame } from '../state/history';
import type { GameState } from '../types';
import { ROOT_ID } from '../types';
import type { Orientation } from '../components/boardGeometry';
import type { ToastAction } from '../app/AppContext';
import type { UiSettings } from '../ui/settings';
import type { useChessMind } from '../chessmind/useChessMind';
import { decodeImportHash, isImportHash, type ImportPayload } from './handoff';
import { mainLine } from '../review/useGameReview';

export const REVIEW_PROMPT = 'Review this game';

/** Build the game to load from an extension payload: chess.com details, and the importing player's name. */
export function gameFromPayload(p: ImportPayload): GameState {
  const game = gameFromParsed(parsePgn(p.pgn));
  if (game.nodes[ROOT_ID].children.length === 0) throw new Error('the PGN has no legal moves');
  if (p.source === 'chesscom') game.meta.source = 'chess.com';
  if (p.url && !game.meta.link) game.meta.link = p.url;
  if (p.user) game.meta.player = p.user;
  return game;
}

/** Board orientation for the importing player: Black if they played Black, otherwise White. */
export function orientationFor(game: GameState): Orientation {
  const u = game.meta.player?.toLowerCase();
  return u && game.meta.black?.toLowerCase() === u && game.meta.white?.toLowerCase() !== u ? 'black' : 'white';
}

/** UCI moves of the main line (null for games from a custom position, which ChessMind cannot follow). */
function mainLineUci(game: GameState): string[] | null {
  const chess = new Chess(game.startFen);
  if (chess.fen() !== new Chess().fen()) return null;
  return mainLine(game).map((m) => {
    const mv = chess.move(m.san);
    return mv.lan;
  });
}

interface Deps {
  state: GameState;
  dispatch: (a: GameAction) => void;
  setOrientation: (o: Orientation) => void;
  enableEngine: () => void;
  chessmind: ReturnType<typeof useChessMind>;
  startReview: (game: GameState) => void;
  ui: UiSettings;
  toast: (message: string, action?: ToastAction) => void;
  revealPanel: (id: string) => void;
  onHistory: (list: SavedGame[]) => void;
}

/**
 * Loads games handed over by the browser extension (see handoff.ts): on start-up and whenever the hash
 * changes (the extension reuses an open NoteMate tab). The current game is kept in the history first, the
 * board turns to the importing player's colour, the engine comes on, and (Settings → chess.com import) the
 * game review runs and ChessMind is asked to review the game.
 */
export function useExternalImport(deps: Deps) {
  const latest = useRef(deps);
  useEffect(() => {
    latest.current = deps;
  });
  /** A "Review this game" question waiting for the model, for the game whose first move has this id. */
  const pendingChat = useRef<string | null>(null);

  const load = useCallback(async (hash: string) => {
    const d = latest.current;
    let game: GameState;
    try {
      const payload = await decodeImportHash(hash);
      if (!payload) return;
      game = gameFromPayload(payload);
    } catch (e) {
      d.toast(`Could not import the game: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const cur = latest.current;
    const previous = cur.state;
    const list = pushHistory(previous);
    cur.onHistory(list);
    const savedId = list[0]?.state === previous ? list[0].id : null;
    cur.chessmind.detach();
    cur.dispatch({ type: 'REPLACE', state: game });
    cur.setOrientation(orientationFor(game));
    cur.enableEngine();
    const from = game.meta.source === 'chess.com' ? 'chess.com' : 'the extension';
    cur.toast(`Imported from ${from}`, {
      label: 'Undo',
      run: () => {
        const now = latest.current;
        now.chessmind.detach();
        now.dispatch({ type: 'REPLACE', state: previous });
        // The game is back on the board, so it no longer needs its history entry.
        if (savedId) now.onHistory(takeHistory(savedId).list);
      },
    });
    if (cur.ui.importReview) {
      cur.revealPanel('review');
      cur.startReview(game);
    }
    pendingChat.current = cur.ui.importChat && cur.chessmind.settings.enabled ? game.nodes[ROOT_ID].children[0] : null;
  }, []);

  // Imports on start-up and on hash changes. The hash is cleared at once so a reload does not import again.
  useEffect(() => {
    const check = () => {
      const hash = location.hash;
      if (!isImportHash(hash)) return;
      history.replaceState(null, '', location.pathname + location.search);
      void load(hash);
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [load]);

  // Ask ChessMind once the model is ready, if the imported game is still on the board.
  const { state, chessmind } = deps;
  useEffect(() => {
    const first = pendingChat.current;
    if (!first) return;
    if (state.nodes[ROOT_ID].children[0] !== first) {
      pendingChat.current = null;
      return;
    }
    if (!chessmind.settings.enabled || chessmind.status === 'error') {
      pendingChat.current = null;
      return;
    }
    if (chessmind.status !== 'ready' || !chessmind.canGenerate || !chessmind.info?.hasText) return;
    pendingChat.current = null;
    const uci = mainLineUci(state);
    if (!uci) return;
    const line = mainLine(state);
    latest.current.revealPanel('analysis');
    chessmind.ask(REVIEW_PROMPT, { originId: line[line.length - 1]?.nodeId ?? ROOT_ID, context: uci });
  }, [state, chessmind]);
}
