import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_POSITION } from 'chess.js';
import './panels';
import { PgnImport } from './components/PgnImport';
import { SetPosition } from './components/SetPosition';
import { checkFen } from './state/position';
import { TRAINER_EVENT } from './chessmind/usePuzzle';
import { useEngine } from './engine/useEngine';
import { useChessMind } from './chessmind/useChessMind';
import { useChessMindTools } from './chessmind/useChessMindTools';
import { ROOT_ID, type Square } from './types';
import type { Orientation } from './components/boardGeometry';
import { useGame } from './state/useGame';
import { useSimulate } from './simulate/useSimulate';
import { eraseCounts, toPgn, type EraseScope } from './state/gameReducer';
import { AppContext, GAME_RESET_EVENT, type AppCtx, type ToastAction } from './app/AppContext';
import { BoardStage } from './app/BoardStage';
import { TopBar } from './app/TopBar';
import { CommandPalette } from './app/CommandPalette';
import { ShortcutsSheet } from './app/ShortcutsSheet';
import { buildCommands, eventKey, shortcutKey } from './app/commands';
import { useMediaQuery, useUiSettings } from './ui/settings';
import { useLayout } from './workspace/useLayout';
import { hidePanel, isVisible, showPanel } from './workspace/layout';
import { setDevPanels } from './workspace/registry';
import { Workspace } from './workspace/Workspace';
import { MobileWorkspace } from './workspace/MobileWorkspace';
import { useGameReview } from './review/useGameReview';
import { useExternalImport } from './import/useExternalImport';
import { loadHistory, pushHistory, takeHistory, type SavedGame } from './state/history';

export default function App() {
  const { state, dispatch, chess, annotation, lastMove } = useGame();
  const [orientation, setOrientation] = useState<Orientation>('white');
  const [showImport, setShowImport] = useState(false);
  const [showSetPosition, setShowSetPosition] = useState(false);
  const [overlay, setOverlay] = useState<'palette' | 'shortcuts' | null>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; action?: ToastAction; key: number } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  // Phone: the Analysis panel is the first tab shown (falls back to the first visible panel).
  const [mobileTab, setMobileTab] = useState<string | null>('analysis');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const { ui, updateUi } = useUiSettings();
  // Developer panels (Simulate) are listed only while Settings → Developer tools is on.
  setDevPanels(ui.devTools);
  const layout = useLayout();
  const phone = useMediaQuery('(max-width: 760px)');
  const compact = useMediaQuery('(max-width: 1100px)');

  const hasMoves = state.nodes[ROOT_ID].children.length > 0;
  const fen = chess.fen();
  // Simulate drives its own engine; the analysis engine pauses while a simulation is active (see useEngine).
  const [simActive, setSimActive] = useState(false);
  // ...and while a game review walks the game with its own engine.
  const [reviewBusy, setReviewBusy] = useState(false);
  const engine = useEngine(fen, simActive || reviewBusy);
  const standardStart = state.startFen.split(' ').slice(0, 4).join(' ') === DEFAULT_POSITION.split(' ').slice(0, 4).join(' ');
  const uciMoves = useMemo(() => (standardStart ? chess.history({ verbose: true }).map((m) => m.lan) : null), [chess, standardStart]);
  // Tools ChessMind may call (tool calling): a dedicated engine, separate from the analysis engine
  const chessmindTools = useChessMindTools(engine.settings, engine.available, state);
  const chessmind = useChessMind(uciMoves, state.chat ?? [], dispatch, chessmindTools);
  const sim = useSimulate({ state, dispatch, cm: chessmind, engineSettings: engine.settings, engineAvailable: engine.available });
  useEffect(() => setSimActive(sim.phase === 'loading' || sim.phase === 'running' || sim.phase === 'paused'), [sim.phase]);
  const review = useGameReview({ state, dispatch, engineSettings: engine.settings, engineAvailable: engine.available, onBusy: setReviewBusy });
  const [savedGames, setSavedGames] = useState<SavedGame[]>(loadHistory);
  // Developer tools off (at start, or switched off) removes the Simulate panel and stops a running simulation.
  const { edit: editLayout } = layout;
  const { stop: stopSim } = sim;
  useEffect(() => {
    if (ui.devTools) return;
    editLayout((l) => (isVisible(l, 'simulate') ? hidePanel(l, 'simulate') : l));
    stopSim();
  }, [ui.devTools, editLayout, stopSim]);

  const playUci = useCallback(
    (uci: string) => dispatch({ type: 'MAKE_MOVE', from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined }),
    [dispatch],
  );
  const flip = useCallback(() => setOrientation((o) => (o === 'white' ? 'black' : 'white')), []);

  const toast = useCallback((message: string, action?: ToastAction) => {
    setToastMsg({ text: message, action, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), action ? 6000 : 2400);
  }, []);

  // Erase side lines and/or arrows everywhere at once; the toast offers Undo (the tree and position come back,
  // anything said in the chat meanwhile stays).
  const erase = useCallback(
    (scope: EraseScope) => {
      const { sideMoves, shapes } = eraseCounts(state);
      const lines = scope !== 'shapes' ? sideMoves : 0;
      const marks = scope !== 'variations' ? shapes : 0;
      if (!lines && !marks) {
        toast(scope === 'shapes' ? 'No arrows or highlights to erase' : scope === 'variations' ? 'No side lines to erase' : 'Nothing to erase');
        return;
      }
      const snapshot = { nodes: state.nodes, currentId: state.currentId };
      dispatch({ type: 'ERASE', scope });
      const what = [lines ? `${lines} side-line move${lines === 1 ? '' : 's'}` : '', marks ? `${marks} arrow${marks === 1 ? '' : 's'} and highlight${marks === 1 ? '' : 's'}` : '']
        .filter(Boolean)
        .join(' and ');
      toast(`Erased ${what}`, { label: 'Undo', run: () => dispatch({ type: 'RESTORE_TREE', ...snapshot }) });
    },
    [state, dispatch, toast],
  );

  const exportPgn = useCallback(
    async (text?: string) => {
      const pgn = text ?? toPgn(state);
      try {
        await navigator.clipboard.writeText(pgn);
        toast('PGN copied to clipboard');
      } catch {
        toast('Clipboard unavailable; the PGN was written to the console');
        console.log(pgn);
      }
    },
    [state, toast],
  );

  const newGame = useCallback(() => {
    if (!hasMoves || confirmReset) {
      // no answer keeps streaming into the new game's chat, and an open puzzle session closes (ChessMindPanel)
      chessmind.detach();
      window.dispatchEvent(new Event(GAME_RESET_EVENT));
      dispatch({ type: 'NEW_GAME' });
      setConfirmReset(false);
      clearTimeout(confirmTimer.current);
      if (hasMoves) toast('Started a new game');
    } else {
      setConfirmReset(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmReset(false), 4000);
    }
  }, [hasMoves, confirmReset, dispatch, toast, chessmind]);

  /**
   * A new game from a set-up position (the Set position dialog, /fen): the game on the board goes into the saved
   * games (not a Lichess trainer puzzle, as with the next puzzle), a running ChessMind answer is detached and the next
   * question starts a fresh conversation, a puzzle session closes, a review or simulation stops. False if invalid.
   */
  const setPosition = useCallback(
    (fen: string, orient?: Orientation): boolean => {
      const check = checkFen(fen);
      if (!check.ok) return false;
      if (!(state.meta.event ?? '').startsWith(TRAINER_EVENT)) setSavedGames(pushHistory(state));
      chessmind.newChat();
      review.cancel();
      if (sim.phase !== 'idle') sim.stop();
      window.dispatchEvent(new Event(GAME_RESET_EVENT));
      dispatch({ type: 'NEW_GAME', startFen: check.fen });
      if (orient) setOrientation(orient);
      toast(check.warning ? `New game from the set-up position. ${check.warning}` : 'New game from the set-up position');
      return true;
    },
    [state, chessmind, review, sim, dispatch, toast],
  );

  /** Swap a game from the history onto the board (the current game goes into the history). */
  const restoreGame = useCallback(
    (id: string) => {
      const { game } = takeHistory(id);
      if (!game) return;
      setSavedGames(pushHistory(state));
      chessmind.detach();
      review.cancel();
      dispatch({ type: 'REPLACE', state: game.state });
      toast(`Restored ${game.title}`);
    },
    [state, dispatch, chessmind, review, toast],
  );

  const revealPanel = useCallback(
    (id: string) => {
      layout.edit((l) => showPanel(l, id));
      setMobileTab(id);
      requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    },
    [layout],
  );

  const { update: updateEngine } = engine;
  const enableEngine = useCallback(() => updateEngine({ enabled: true }), [updateEngine]);
  useExternalImport({
    state,
    dispatch,
    setOrientation,
    enableEngine,
    chessmind,
    startReview: (game) => void review.start(undefined, game),
    ui,
    toast,
    revealPanel,
    onHistory: setSavedGames,
  });

  const ctx: AppCtx = {
    state, dispatch, chess, fen, annotation, lastMove, uciMoves, orientation, flip, playUci,
    engine, chessmind, sim, review, savedGames, restoreGame, ui, updateUi, layout, revealPanel, toast, erase, exportPgn, newGame, setPosition,
    openImport: () => setShowImport(true),
    openSetPosition: () => setShowSetPosition(true),
    openPalette: () => setOverlay('palette'),
    openShortcuts: () => setOverlay('shortcuts'),
  };
  const commands = buildCommands(ctx);
  const commandsRef = useRef(commands);
  useEffect(() => {
    commandsRef.current = commands;
  });

  // Global shortcuts, dispatched through the command list (so the palette and the sheet always agree).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = eventKey(e);
      if (key === 'Mod+k') {
        e.preventDefault();
        setOverlay((o) => (o === 'palette' ? null : 'palette'));
        return;
      }
      if (e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      // Let focused tabs, menus and buttons keep their own arrow-key handling.
      if (e.key.startsWith('Arrow') && t?.closest('[role=tablist], [role=menu], [role=separator], [data-separator]')) return;
      const cmd = commandsRef.current.find((c) => c.shortcuts?.some((s) => shortcutKey(s) === key));
      if (!cmd) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <AppContext.Provider value={ctx}>
      <div className={`app ${phone ? 'is-phone' : ''}`}>
        <TopBar confirmingNew={confirmReset} compact={compact} />
        {phone ? (
          <MobileWorkspace api={layout} center={<BoardStage />} active={mobileTab} setActive={setMobileTab} />
        ) : (
          <Workspace api={layout} center={<BoardStage />} />
        )}
      </div>

      {showImport && <PgnImport onImport={(pgn) => dispatch({ type: 'LOAD_PGN', pgn })} onClose={() => setShowImport(false)} />}
      {showSetPosition && (
        <SetPosition
          currentFen={fen}
          orientation={orientation}
          pieceSet={ui.pieceSet}
          boardTheme={ui.boardTheme}
          onApply={(f, o) => setPosition(f, o)}
          onClose={() => setShowSetPosition(false)}
        />
      )}
      {overlay === 'palette' && <CommandPalette commands={commands} onClose={() => setOverlay(null)} />}
      {overlay === 'shortcuts' && <ShortcutsSheet commands={commands} onClose={() => setOverlay(null)} />}
      <div className="toast-region" aria-live="polite">
        {toastMsg && (
          <div className={`toast ${toastMsg.action ? 'has-action' : ''}`} key={toastMsg.key} data-testid="toast">
            <span>{toastMsg.text}</span>
            {toastMsg.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toastMsg.action!.run();
                  setToastMsg(null);
                }}
                data-testid="toast-action"
              >
                {toastMsg.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </AppContext.Provider>
  );
}
