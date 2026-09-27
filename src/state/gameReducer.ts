import { Chess, DEFAULT_POSITION } from 'chess.js';
import type { Annotation, Arrow, GameState, Highlight, MoveNode, Note, NoteColor, Square } from '../types';
import { emptyAnnotation, ROOT_ID } from '../types';
import { gameFromParsed, newId, parsePgn } from './pgn';

export type GameAction =
  | { type: 'MAKE_MOVE'; from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' }
  | { type: 'GOTO'; id: string }
  | { type: 'BACK' }
  | { type: 'FORWARD' }
  | { type: 'START' }
  | { type: 'END' }
  | { type: 'SIBLING'; delta: 1 | -1 }
  | { type: 'PROMOTE'; id: string }
  | { type: 'DELETE_FROM'; id: string }
  | { type: 'TOGGLE_ARROW'; arrow: Arrow }
  | { type: 'TOGGLE_HIGHLIGHT'; highlight: Highlight }
  | { type: 'CLEAR_SHAPES' }
  | { type: 'ADD_NOTE'; color: NoteColor }
  | { type: 'UPDATE_NOTE'; id: string; text: string }
  | { type: 'DELETE_NOTE'; id: string }
  | { type: 'LOAD_PGN'; pgn: string }
  | { type: 'NEW_GAME' }
  | { type: 'REPLACE'; state: GameState };

export const initialGameState = (): GameState => ({
  version: 2,
  startFen: DEFAULT_POSITION,
  nodes: { [ROOT_ID]: { id: ROOT_ID, san: '', parent: null, children: [] } },
  currentId: ROOT_ID,
  meta: { source: 'manual' },
});

/** Ids from the root (exclusive) down to `id` (inclusive). */
export function pathTo(state: GameState, id: string): MoveNode[] {
  const path: MoveNode[] = [];
  let node: MoveNode | undefined = state.nodes[id];
  while (node && node.parent !== null) {
    path.push(node);
    node = state.nodes[node.parent];
  }
  return path.reverse();
}

export function nodePly(state: GameState, id: string): number {
  return pathTo(state, id).length;
}

/** Replay the moves leading to `id` and return the resulting Chess instance. */
export function positionAt(state: GameState, id: string): Chess {
  const chess = new Chess(state.startFen);
  for (const node of pathTo(state, id)) chess.move(node.san);
  return chess;
}

/** Human label for a node, e.g. "12. Nf3" or "12... Nf6". */
export function nodeLabel(state: GameState, id: string): string {
  if (id === ROOT_ID) return 'Start';
  const ply = nodePly(state, id);
  const moveNumber = Math.ceil(ply / 2);
  return `${moveNumber}${ply % 2 === 1 ? '.' : '...'} ${state.nodes[id].san}`;
}

/** Last node when following main continuations from `id`. */
export function lineEnd(state: GameState, id: string): string {
  let cur = id;
  while (state.nodes[cur].children.length) cur = state.nodes[cur].children[0];
  return cur;
}

export function isMainLine(state: GameState, id: string): boolean {
  let node = state.nodes[id];
  while (node.parent !== null) {
    const parent = state.nodes[node.parent];
    if (parent.children[0] !== node.id) return false;
    node = parent;
  }
  return true;
}

function withAnnotation(state: GameState, update: (a: Annotation) => Annotation): GameState {
  const node = state.nodes[state.currentId];
  const next = update(node.annotation ?? emptyAnnotation());
  const empty = next.arrows.length === 0 && next.highlights.length === 0 && next.notes.length === 0;
  const updated: MoveNode = { ...node };
  if (empty) delete updated.annotation;
  else updated.annotation = next;
  return { ...state, nodes: { ...state.nodes, [node.id]: updated } };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'MAKE_MOVE': {
      const chess = positionAt(state, state.currentId);
      let san: string;
      try {
        san = chess.move({ from: action.from, to: action.to, promotion: action.promotion }).san;
      } catch {
        return state;
      }
      const current = state.nodes[state.currentId];
      const existing = current.children.find((c) => state.nodes[c].san === san);
      if (existing) return { ...state, currentId: existing };
      const id = newId();
      const node: MoveNode = { id, san, parent: current.id, children: [] };
      return {
        ...state,
        nodes: { ...state.nodes, [id]: node, [current.id]: { ...current, children: [...current.children, id] } },
        currentId: id,
      };
    }
    case 'GOTO':
      return state.nodes[action.id] && action.id !== state.currentId ? { ...state, currentId: action.id } : state;
    case 'BACK': {
      const parent = state.nodes[state.currentId].parent;
      return parent === null ? state : { ...state, currentId: parent };
    }
    case 'FORWARD': {
      const child = state.nodes[state.currentId].children[0];
      return child ? { ...state, currentId: child } : state;
    }
    case 'START':
      return { ...state, currentId: ROOT_ID };
    case 'END':
      return { ...state, currentId: lineEnd(state, state.currentId) };
    case 'SIBLING': {
      const node = state.nodes[state.currentId];
      if (node.parent === null) return state;
      const siblings = state.nodes[node.parent].children;
      if (siblings.length < 2) return state;
      const i = (siblings.indexOf(node.id) + action.delta + siblings.length) % siblings.length;
      return { ...state, currentId: siblings[i] };
    }
    case 'PROMOTE': {
      // Move this line to the front among its siblings at every level up to the root.
      const nodes = { ...state.nodes };
      let node = nodes[action.id];
      while (node && node.parent !== null) {
        const parent = nodes[node.parent];
        if (parent.children[0] !== node.id) {
          nodes[parent.id] = { ...parent, children: [node.id, ...parent.children.filter((c) => c !== node.id)] };
        }
        node = nodes[parent.id];
      }
      return { ...state, nodes };
    }
    case 'DELETE_FROM': {
      const target = state.nodes[action.id];
      if (!target || target.parent === null) return state;
      const nodes = { ...state.nodes };
      const stack = [action.id];
      while (stack.length) {
        const id = stack.pop()!;
        stack.push(...nodes[id].children);
        delete nodes[id];
      }
      const parent = nodes[target.parent];
      nodes[parent.id] = { ...parent, children: parent.children.filter((c) => c !== action.id) };
      const currentGone = !nodes[state.currentId];
      return { ...state, nodes, currentId: currentGone ? parent.id : state.currentId };
    }
    case 'TOGGLE_ARROW':
      return withAnnotation(state, (a) => {
        const same = (x: Arrow) => x.from === action.arrow.from && x.to === action.arrow.to;
        const existing = a.arrows.find(same);
        if (existing && existing.color === action.arrow.color) {
          return { ...a, arrows: a.arrows.filter((x) => !same(x)) };
        }
        return { ...a, arrows: [...a.arrows.filter((x) => !same(x)), action.arrow] };
      });
    case 'TOGGLE_HIGHLIGHT':
      return withAnnotation(state, (a) => {
        const same = (x: Highlight) => x.square === action.highlight.square;
        const existing = a.highlights.find(same);
        if (existing && existing.color === action.highlight.color) {
          return { ...a, highlights: a.highlights.filter((x) => !same(x)) };
        }
        return { ...a, highlights: [...a.highlights.filter((x) => !same(x)), action.highlight] };
      });
    case 'CLEAR_SHAPES':
      return withAnnotation(state, (a) => ({ ...a, arrows: [], highlights: [] }));
    case 'ADD_NOTE': {
      const note: Note = { id: newId(), text: '', color: action.color, createdAt: Date.now() };
      return withAnnotation(state, (a) => ({ ...a, notes: [...a.notes, note] }));
    }
    case 'UPDATE_NOTE':
      return withAnnotation(state, (a) => ({
        ...a,
        notes: a.notes.map((n) => (n.id === action.id ? { ...n, text: action.text } : n)),
      }));
    case 'DELETE_NOTE':
      return withAnnotation(state, (a) => ({ ...a, notes: a.notes.filter((n) => n.id !== action.id) }));
    case 'LOAD_PGN': {
      try {
        return gameFromParsed(parsePgn(action.pgn));
      } catch {
        return state;
      }
    }
    case 'NEW_GAME':
      return initialGameState();
    case 'REPLACE':
      return action.state;
  }
}

export { toPgn } from './pgn';
