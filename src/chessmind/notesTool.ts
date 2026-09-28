/*
 * The notes tools (tools.ts; chessmind.model.tools NotesTool / AllNotesTool in Python): the user's own notes on moves
 * of the current game tree, read-only. `notes` answers for the move that led to the position asked about, `all_notes`
 * lists every note (main line first, then variations). Note text is data: sanitised (sanitizeNote) so it can never
 * read as markup, and results are BPE text anyway (no note can produce a tool token). Notes ChessMind wrote itself
 * (colour 'chessmind') are not the user's and are left out.
 */
import { Chess } from 'chess.js';
import { ROOT_ID, type GameState } from '../types';
import { NOTE_CHARS, NOTES_CHARS, errorText, notesResultText, type NoteEntry, type ToolResultData } from './tools';

/** Placement, side, castling, en passant. */
const posKey = (fen: string) => fen.trim().split(/\s+/).slice(0, 4).join(' ');

interface NodeNotes extends NoteEntry {
  key: string;
}

/** Every node with user notes, in game order (depth-first, main continuation first), with its move label. */
export function gameNotes(state: GameState): NodeNotes[] {
  const out: NodeNotes[] = [];
  const walk = (id: string, c: Chess, main: boolean) => {
    const node = state.nodes[id];
    if (!node) return;
    node.children.forEach((childId, i) => {
      const child = state.nodes[childId];
      if (!child) return;
      const b = new Chess(c.fen());
      const label = `${b.moveNumber()}${b.turn() === 'w' ? '.' : '...'}`;
      let san: string;
      try {
        san = b.move(child.san).san;
      } catch {
        return;
      }
      const texts = (child.annotation?.notes ?? []).filter((n) => n.color !== 'chessmind' && n.text.trim()).map((n) => n.text);
      if (texts.length) out.push({ label: label + san, texts, main: main && i === 0, key: posKey(b.fen()) });
      walk(childId, b, main && i === 0);
    });
  };
  let start: Chess;
  try {
    start = new Chess(state.startFen);
  } catch {
    return out;
  }
  const rootNotes = (state.nodes[ROOT_ID]?.annotation?.notes ?? []).filter((n) => n.color !== 'chessmind' && n.text.trim()).map((n) => n.text);
  if (rootNotes.length) out.push({ label: 'the start', texts: rootNotes, main: true, key: posKey(start.fen()) });
  walk(ROOT_ID, start, true);
  return out;
}

/** The move that led to `fen` somewhere in the tree (main line first), else null. */
function labelOf(state: GameState, fen: string): string | null {
  const want = posKey(fen);
  let hit: { label: string; main: boolean } | null = null;
  const walk = (id: string, c: Chess, main: boolean) => {
    state.nodes[id]?.children.forEach((childId, i) => {
      if (hit?.main) return;
      const child = state.nodes[childId];
      if (!child) return;
      const b = new Chess(c.fen());
      const label = `${b.moveNumber()}${b.turn() === 'w' ? '.' : '...'}`;
      try {
        const san = b.move(child.san).san;
        if (posKey(b.fen()) === want && (!hit || (main && i === 0))) hit = { label: label + san, main: main && i === 0 };
      } catch {
        return;
      }
      walk(childId, b, main && i === 0);
    });
  };
  try {
    walk(ROOT_ID, new Chess(state.startFen), true);
  } catch {
    return null;
  }
  return (hit as { label: string } | null)?.label ?? null;
}

/** Run `notes` (the position `fen`) or `all_notes` on the game tree. */
export function runNotesTool(state: GameState | null, name: string, fen: string): ToolResultData {
  if (!state) return { text: errorText('Notes', 'no game'), ok: false };
  const all = gameNotes(state);
  if (name === 'all_notes') {
    const text = notesResultText(all, null, true);
    const compact = [2, 4].map((k) => notesResultText(all, null, true, Math.floor(NOTE_CHARS / k), Math.floor(NOTES_CHARS / k)));
    return { text, ok: true, compact: [...new Set(compact.filter((c) => c !== text))] };
  }
  const key = posKey(fen);
  const hits = all.filter((e) => e.key === key).sort((a, b) => Number(b.main) - Number(a.main)).slice(0, 1);
  let about: string | null = hits[0]?.label ?? labelOf(state, fen);
  if (about === 'the start' || (!about && key === posKey(new Chess(state.startFen).fen()))) about = null;
  if (about === null && !hits.length && key !== posKey(new Chess(state.startFen).fen())) {
    return { text: '[Notes: none on this position]', ok: true };
  }
  const text = notesResultText(hits, about);
  const compact = [2, 4].map((k) => notesResultText(hits, about, false, Math.floor(NOTE_CHARS / k)));
  return { text, ok: true, compact: [...new Set(compact.filter((c) => c !== text))] };
}
