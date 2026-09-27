/** Thin adapters that connect existing panel components to app state via useApp(). */
import { Bot } from 'lucide-react';
import { useApp } from '../app/AppContext';
import { MoveList } from '../components/MoveList';
import { StickyNotes } from '../components/StickyNotes';
import { EnginePanel } from '../components/EnginePanel';
import { ChessMindPanel } from '../chessmind/ChessMindPanel';
import { SimulatePanel } from '../simulate/SimulatePanel';
import { EmptyState } from '../ui/primitives';

export function MovesPanel() {
  const { state, dispatch, openImport } = useApp();
  return <MoveList state={state} dispatch={dispatch} onImport={openImport} />;
}

export function NotesPanel() {
  const { state, dispatch, annotation } = useApp();
  return (
    <StickyNotes
      state={state}
      notes={annotation.notes}
      onAdd={(color) => dispatch({ type: 'ADD_NOTE', color })}
      onUpdate={(id, text) => dispatch({ type: 'UPDATE_NOTE', id, text })}
      onDelete={(id) => dispatch({ type: 'DELETE_NOTE', id })}
      onGoto={(id) => dispatch({ type: 'GOTO', id })}
    />
  );
}

export function EngineHost() {
  const { engine, fen, playUci } = useApp();
  return (
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
  );
}

export function ChessMindHost() {
  const { chessmind, state, dispatch, chess, fen, uciMoves, playUci, flip } = useApp();
  const model = chessmind.models?.find((m) => m.id === chessmind.modelId) ?? chessmind.models?.[0];
  return (
    <div className="cm-host">
      <ChessMindPanel cm={chessmind} state={state} dispatch={dispatch} chess={chess} fen={fen} uciMoves={uciMoves} onPlayUci={playUci} onFlip={flip} />
      {!chessmind.settings.enabled && (
        <EmptyState
          icon={Bot}
          title="Chat with ChessMind"
          actions={
            <button className="btn btn-sm btn-primary" onClick={() => chessmind.update({ enabled: true })} data-testid="chessmind-enable">
              Load {model ? `${model.name} · ${model.sizeMb} MB` : 'the model'}
            </button>
          }
        >
          Our chess language model runs entirely in this browser. It predicts moves, answers questions about the game, and can drive the board: try “back 2”, “arrow e2 e4” or “what should I play?”. The first load downloads the model; later loads come from the cache.
        </EmptyState>
      )}
    </div>
  );
}

export function SimulateHost() {
  const { sim, chessmind, state, dispatch, exportPgn } = useApp();
  return <SimulatePanel sim={sim} cm={chessmind} state={state} dispatch={dispatch} onExport={(pgn) => exportPgn(pgn)} />;
}
