import { useState } from 'react';
import { FileUp, X } from 'lucide-react';
import { gameFromParsed, parsePgn } from '../state/pgn';
import { ROOT_ID } from '../types';

interface Props {
  onImport: (pgn: string) => void;
  onClose: () => void;
}

export function PgnImport({ onImport, onClose }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const submit = () => {
    try {
      const game = gameFromParsed(parsePgn(text));
      if (game.nodes[ROOT_ID].children.length === 0) {
        setError('No legal moves were found in that PGN. Check that it contains a move list such as “1. e4 e5”.');
        return;
      }
    } catch (e) {
      setError(`Could not read that PGN: ${e instanceof Error ? e.message : 'unknown error'}`);
      return;
    }
    onImport(text);
    onClose();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setError(null);
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pgn-title"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) submit();
        }}
        data-testid="pgn-import"
      >
        <header className="modal-head">
          <div>
            <h2 id="pgn-title">Import a game</h2>
            <p className="hint">
              Paste PGN or drop a .pgn file. chess.com (Share → PGN) and ChessBase (File → Export → PGN) both produce it. Variations are kept and comments become sticky notes.
            </p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <textarea
          className={`input pgn-text ${dragOver ? 'drag-over' : ''}`}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onFile(e.dataTransfer.files[0]);
          }}
          placeholder={'[Event "?"]\n\n1. e4 e5 2. Nf3 Nc6 ...'}
          rows={12}
          aria-label="PGN text"
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <label className="btn btn-ghost">
            <FileUp size={15} /> Open .pgn file
            <input type="file" accept=".pgn,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!text.trim()} data-testid="pgn-submit">
            Import game
          </button>
        </div>
      </div>
    </div>
  );
}
