import { useEffect, useState } from 'react';
import { Board } from './components/Board';
import { MoveList } from './components/MoveList';
import { StickyNotes } from './components/StickyNotes';
import { Toolbar } from './components/Toolbar';
import { PgnImport } from './components/PgnImport';
import { EnginePanel } from './components/EnginePanel';
import { EvalBar } from './components/EvalBar';
import { useEngine } from './engine/useEngine';
import { ROOT_ID, type Arrow, type Square } from './types';
import type { Orientation } from './components/boardGeometry';
import { useGame } from './state/useGame';
import { toPgn } from './state/gameReducer';

export default function App() {
  const { state, dispatch, chess, annotation, lastMove } = useGame();
  const [orientation, setOrientation] = useState<Orientation>('white');
  const [showImport, setShowImport] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const hasMoves = state.nodes[ROOT_ID].children.length > 0;
  const fen = chess.fen();
  const engine = useEngine(fen);

  const engineArrows: Arrow[] = engine.settings.enabled
    ? engine.lines.slice(0, 1).flatMap((l) =>
        l.pv[0] ? [{ from: l.pv[0].slice(0, 2) as Square, to: l.pv[0].slice(2, 4) as Square, color: 'engine' as const }] : [],
      )
    : [];
  const playUci = (uci: string) =>
    dispatch({ type: 'MAKE_MOVE', from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined });

  const flip = () => setOrientation((o) => (o === 'white' ? 'black' : 'white'));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      switch (e.key) {
        case 'ArrowLeft': dispatch({ type: 'BACK' }); break;
        case 'ArrowRight': dispatch({ type: 'FORWARD' }); break;
        case 'ArrowUp': dispatch({ type: 'SIBLING', delta: -1 }); break;
        case 'ArrowDown': dispatch({ type: 'SIBLING', delta: 1 }); break;
        case 'Home': dispatch({ type: 'START' }); break;
        case 'End': dispatch({ type: 'END' }); break;
        case 'f': case 'F': flip(); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const exportPgn = async () => {
    const pgn = toPgn(state);
    try {
      await navigator.clipboard.writeText(pgn);
      setToast('PGN copied to clipboard');
    } catch {
      setToast('Clipboard unavailable; PGN logged to console');
      console.log(pgn);
    }
    setTimeout(() => setToast(null), 2000);
  };

  return (
    <div className="app">
      <section className="board-column">
        <div className="board-with-eval">
          {engine.settings.enabled && (
            <EvalBar line={engine.lines[0]} sideToMove={chess.turn()} orientation={orientation} />
          )}
          <Board
          chess={chess}
          orientation={orientation}
          arrows={[...engineArrows, ...annotation.arrows]}
          highlights={annotation.highlights}
          lastMove={lastMove}
          onMove={(from, to, promotion) => dispatch({ type: 'MAKE_MOVE', from, to, promotion })}
          onToggleArrow={(arrow) => dispatch({ type: 'TOGGLE_ARROW', arrow })}
            onToggleHighlight={(highlight) => dispatch({ type: 'TOGGLE_HIGHLIGHT', highlight })}
          />
        </div>
      </section>

      <section className="side-column">
        <Toolbar
          state={state}
          fen={fen}
          confirmingReset={confirmReset}
          onNewGame={() => {
            if (!hasMoves || confirmReset) {
              dispatch({ type: 'NEW_GAME' });
              setConfirmReset(false);
            } else {
              setConfirmReset(true);
              setTimeout(() => setConfirmReset(false), 4000);
            }
          }}
          onFlip={flip}
          onClearShapes={() => dispatch({ type: 'CLEAR_SHAPES' })}
          onImport={() => setShowImport(true)}
          onExport={exportPgn}
        />
        <EnginePanel
          fen={fen}
          settings={engine.settings}
          update={engine.update}
          status={engine.status}
          engineName={engine.engineName}
          error={engine.error}
          lines={engine.lines}
          available={engine.available}
          progress={engine.progress}
          onPlayUci={playUci}
        />
        <MoveList state={state} dispatch={dispatch} />
      </section>

      <StickyNotes
        state={state}
        notes={annotation.notes}
        onAdd={(color) => dispatch({ type: 'ADD_NOTE', color })}
        onUpdate={(id, text) => dispatch({ type: 'UPDATE_NOTE', id, text })}
        onDelete={(id) => dispatch({ type: 'DELETE_NOTE', id })}
        onGoto={(id) => dispatch({ type: 'GOTO', id })}
      />

      {showImport && (
        <PgnImport onImport={(pgn) => dispatch({ type: 'LOAD_PGN', pgn })} onClose={() => setShowImport(false)} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
