import { Plus, StickyNote, X } from 'lucide-react';
import type { GameState, Note, NoteColor } from '../types';
import { nodeLabel, nodePly } from '../state/gameReducer';
import { ROOT_ID } from '../types';
import { EmptyState } from '../ui/primitives';

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
  const where = state.currentId === ROOT_ID ? 'Starting position' : nodeLabel(state, state.currentId);

  return (
    <div className="notes-panel">
      <header className="notes-header">
        <div className="notes-where">
          <span className="section-label">This position</span>
          <span className="notes-pos">{where}</span>
        </div>
        <div className="note-add" role="group" aria-label="Add a note">
          {NOTE_COLORS.map((c) => (
            <button key={c} className={`note-add-btn note-${c}`} title={`Add a ${c} note (N)`} aria-label={`Add ${c} note`} onClick={() => onAdd(c)}>
              <Plus size={12} strokeWidth={2.4} />
            </button>
          ))}
        </div>
      </header>

      <div className="notes-current">
        {notes.length === 0 && (
          <EmptyState
            icon={StickyNote}
            title="No notes here yet"
            actions={
              <button className="btn btn-sm" onClick={() => onAdd('yellow')}>
                <Plus size={13} /> Add a note
              </button>
            }
          >
            Notes belong to this position and follow it through variations. They are exported as PGN comments.
          </EmptyState>
        )}
        {notes.map((n) => (
          <div key={n.id} className={`sticky note-${n.color}`}>
            {n.color === 'chessmind' && <span className="sticky-badge">ChessMind</span>}
            <button className="sticky-delete" title="Delete note" aria-label="Delete note" onClick={() => onDelete(n.id)}>
              <X size={13} />
            </button>
            <textarea
              autoFocus={n.text === ''}
              value={n.text}
              placeholder="Write a note…"
              aria-label="Note text"
              onChange={(e) => onUpdate(n.id, e.target.value)}
            />
          </div>
        ))}
      </div>

      {allNotes.length > 0 && (
        <section className="notes-all">
          <h3 className="section-label">Elsewhere in this game</h3>
          {allNotes.map(({ id, note }) => (
            <button key={note.id} className={`note-link note-${note.color}`} onClick={() => onGoto(id)}>
              <strong>{nodeLabel(state, id)}</strong>
              <span>{note.text.length > 90 ? note.text.slice(0, 90) + '…' : note.text}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
