import { useState } from 'react';
import { gameFromParsed, parsePgn } from '../state/pgn';
import { ROOT_ID } from '../types';

interface Props {
  onImport: (pgn: string) => void;
  onClose: () => void;
}

export function PgnImport({ onImport, onClose }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    try {
      const game = gameFromParsed(parsePgn(text));
      if (game.nodes[ROOT_ID].children.length === 0) {
        setError('No legal moves found in that PGN.');
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not parse PGN');
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Import game (PGN)</h2>
        <p className="hint">
          Paste a PGN or open a .pgn file. Both chess.com (Share → PGN) and ChessBase (File → Export → PGN)
          can produce these. Variations and comments are imported; comments become sticky notes.
        </p>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder={'[Event "?"]\n\n1. e4 e5 2. Nf3 Nc6 ...'}
          rows={12}
        />
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <label className="button">
            Open .pgn file
            <input type="file" accept=".pgn,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!text.trim()}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
