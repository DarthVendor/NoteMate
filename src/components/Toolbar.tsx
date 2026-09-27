import type { GameState } from '../types';

interface Props {
  state: GameState;
  fen: string;
  onNewGame: () => void;
  confirmingReset: boolean;
  onFlip: () => void;
  onClearShapes: () => void;
  onImport: () => void;
  onExport: () => void;
}

export function Toolbar({ state, fen, onNewGame, confirmingReset, onFlip, onClearShapes, onImport, onExport }: Props) {
  const { white, black, event, result } = state.meta;
  const title = white || black ? `${white ?? '?'} – ${black ?? '?'}` : 'Analysis board';
  return (
    <div className="toolbar">
      <div className="game-title">
        <strong>{title}</strong>
        {(event || result) && (
          <span className="game-sub">
            {[event, result].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
      <div className="toolbar-buttons">
        <button onClick={onNewGame} className={confirmingReset ? 'danger' : ''} title="Reset to the starting position">
          {confirmingReset ? 'Discard game?' : 'New'}
        </button>
        <button onClick={onFlip} title="Flip board (F)">Flip</button>
        <button onClick={onClearShapes} title="Remove arrows and highlights on this position">Clear arrows</button>
        <button onClick={onImport}>Import PGN</button>
        <button onClick={onExport}>Copy PGN</button>
      </div>
      <input className="fen" readOnly value={fen} onFocus={(e) => e.target.select()} title="FEN of the current position" />
      <p className="help">
        Drag or click to move. Right-drag to draw arrows, right-click to circle a square.
        Hold <kbd>Shift</kbd> red, <kbd>Alt</kbd> blue, <kbd>Ctrl</kbd> yellow. Drawing the same shape again removes it.
      </p>
    </div>
  );
}
