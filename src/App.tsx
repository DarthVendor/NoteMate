import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_POSITION } from 'chess.js';
import './panels';
import { PgnImport } from './components/PgnImport';
import { useEngine } from './engine/useEngine';
import { useChessMind } from './chessmind/useChessMind';
import { ROOT_ID, type Square } from './types';
import type { Orientation } from './components/boardGeometry';
import { useGame } from './state/useGame';
import { useSimulate } from './simulate/useSimulate';
import { toPgn } from './state/gameReducer';
import { AppContext, type AppCtx } from './app/AppContext';
import { BoardStage } from './app/BoardStage';
import { TopBar } from './app/TopBar';
import { CommandPalette } from './app/CommandPalette';
import { ShortcutsSheet } from './app/ShortcutsSheet';
import { buildCommands, eventKey, shortcutKey } from './app/commands';
import { useMediaQuery, useUiSettings } from './ui/settings';
import { useLayout } from './workspace/useLayout';
import { showPanel } from './workspace/layout';
import { Workspace } from './workspace/Workspace';
import { MobileWorkspace } from './workspace/MobileWorkspace';

export default function App() {
  const { state, dispatch, chess, annotation, lastMove } = useGame();
  const [orientation, setOrientation] = useState<Orientation>('white');
  const [showImport, setShowImport] = useState(false);
  const [overlay, setOverlay] = useState<'palette' | 'shortcuts' | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [mobileTab, setMobileTab] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const { ui, updateUi } = useUiSettings();
  const layout = useLayout();
  const phone = useMediaQuery('(max-width: 760px)');
  const compact = useMediaQuery('(max-width: 1100px)');

  const hasMoves = state.nodes[ROOT_ID].children.length > 0;
  const fen = chess.fen();
  // Simulate drives its own engine; the analysis engine pauses while a simulation is active (see useEngine).
  const [simActive, setSimActive] = useState(false);
  const engine = useEngine(fen, simActive);
  const standardStart = state.startFen.split(' ').slice(0, 4).join(' ') === DEFAULT_POSITION.split(' ').slice(0, 4).join(' ');
  const uciMoves = useMemo(() => (standardStart ? chess.history({ verbose: true }).map((m) => m.lan) : null), [chess, standardStart]);
  const chessmind = useChessMind(uciMoves, state.chat ?? [], dispatch);
  const sim = useSimulate({ state, dispatch, cm: chessmind, engineSettings: engine.settings, engineAvailable: engine.available });
  useEffect(() => setSimActive(sim.phase === 'loading' || sim.phase === 'running' || sim.phase === 'paused'), [sim.phase]);

  const playUci = useCallback(
    (uci: string) => dispatch({ type: 'MAKE_MOVE', from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined }),
    [dispatch],
  );
  const flip = useCallback(() => setOrientation((o) => (o === 'white' ? 'black' : 'white')), []);

  const toast = useCallback((message: string) => {
    setToastMsg(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  }, []);

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
      dispatch({ type: 'NEW_GAME' });
      setConfirmReset(false);
      clearTimeout(confirmTimer.current);
      if (hasMoves) toast('Started a new game');
    } else {
      setConfirmReset(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmReset(false), 4000);
    }
  }, [hasMoves, confirmReset, dispatch, toast]);

  const revealPanel = useCallback(
    (id: string) => {
      layout.edit((l) => showPanel(l, id));
      setMobileTab(id);
      requestAnimationFrame(() => document.getElementById(`tab-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    },
    [layout],
  );

  const ctx: AppCtx = {
    state, dispatch, chess, fen, annotation, lastMove, uciMoves, orientation, flip, playUci,
    engine, chessmind, sim, ui, updateUi, layout, revealPanel, toast, exportPgn, newGame,
    openImport: () => setShowImport(true),
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
      {overlay === 'palette' && <CommandPalette commands={commands} onClose={() => setOverlay(null)} />}
      {overlay === 'shortcuts' && <ShortcutsSheet commands={commands} onClose={() => setOverlay(null)} />}
      <div className="toast-region" aria-live="polite">
        {toastMsg && (
          <div className="toast" key={toastMsg}>
            {toastMsg}
          </div>
        )}
      </div>
    </AppContext.Provider>
  );
}
