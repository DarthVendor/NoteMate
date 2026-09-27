/** Thin adapters that connect existing panel components to app state via useApp(). */
import { useApp } from '../app/AppContext';
import { MoveList } from '../components/MoveList';
import { EraseMenu } from '../components/EraseMenu';
import { StickyNotes } from '../components/StickyNotes';
import { EnginePanel } from '../components/EnginePanel';
import { ChessMindPanel } from '../chessmind/ChessMindPanel';
import { SimulatePanel } from '../simulate/SimulatePanel';
import { PredictionChips } from '../chessmind/Predictions';

export function MovesPanel() {
  const { state, dispatch, openImport } = useApp();
  return <MoveList state={state} dispatch={dispatch} onImport={openImport} tools={<EraseMenu />} />;
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
  return (
    <div className="cm-host">
      <ChessMindPanel
        cm={chessmind}
        state={state}
        dispatch={dispatch}
        chess={chess}
        fen={fen}
        uciMoves={uciMoves}
        onFlip={flip}
        above={<PredictionChips cm={chessmind} state={state} dispatch={dispatch} fen={fen} standardStart={uciMoves !== null} onPlayUci={playUci} />}
      />
    </div>
  );
}

export function SimulateHost() {
  const { sim, chessmind, state, dispatch, exportPgn } = useApp();
  return <SimulatePanel sim={sim} cm={chessmind} state={state} dispatch={dispatch} onExport={(pgn) => exportPgn(pgn)} />;
}
