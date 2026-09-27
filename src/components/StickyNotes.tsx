import type { GameState, Note, NoteColor } from '../types';
import { nodeLabel, nodePly } from '../state/gameReducer';

interface Props {
  state: GameState;
  notes: Note[];
  onAdd: (color: NoteColor) => void;
  onUpdate: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onGoto: (id: string) => void;
}

const NOTE_COLORS: NoteColor[] = ['yellow', 'pink', 'blue', 'green'];

export function StickyNotes({ state, notes, onAdd, onUpdate, onDelete, onGoto }: Props) {
  const allNotes = Object.values(state.nodes)
    .filter((node) => node.id !== state.currentId && node.annotation?.notes.length)
    .flatMap((node) => node.annotation!.notes.map((n) => ({ id: node.id, ply: nodePly(state, node.id), note: n })))
    .filter((x) => x.note.text.trim())
    .sort((a, b) => a.ply - b.ply);

  return (
    <aside className="notes-panel">
      <header className="notes-header">
        <h2>Notes · {nodeLabel(state, state.currentId)}</h2>
        <div className="note-add">
          {NOTE_COLORS.map((c) => (
            <button
              key={c}
              className={`note-add-btn note-${c}`}
              title={`Add ${c} note`}
              onClick={() => onAdd(c)}
            >
              +
            </button>
          ))}
        </div>
      </header>

      <div className="notes-current">
        {notes.length === 0 && <p className="hint">No notes on this position yet. Click a + to add a sticky.</p>}
        {notes.map((n, i) => (
          <div key={n.id} className={`sticky note-${n.color}`} style={{ '--tilt': `${((i % 3) - 1) * 1.2}deg` } as React.CSSProperties}>
            {n.color === 'chessmind' && <span className="sticky-badge">ChessMind</span>}
            <button className="sticky-delete" title="Delete note" onClick={() => onDelete(n.id)}>
              ×
            </button>
            <textarea
              autoFocus={n.text === ''}
              value={n.text}
              placeholder="Write a note…"
              onChange={(e) => onUpdate(n.id, e.target.value)}
            />
          </div>
        ))}
      </div>

      {allNotes.length > 0 && (
        <section className="notes-all">
          <h3>Elsewhere in this game</h3>
          {allNotes.map(({ id, note }) => (
            <button key={note.id} className={`note-link note-${note.color}`} onClick={() => onGoto(id)}>
              <strong>{nodeLabel(state, id)}</strong>
              <span>{note.text.length > 80 ? note.text.slice(0, 80) + '…' : note.text}</span>
            </button>
          ))}
        </section>
      )}
    </aside>
  );
}
