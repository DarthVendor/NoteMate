import { Chess, DEFAULT_POSITION } from 'chess.js';
import type { Annotation, Arrow, ChatMessage, GameReview, GameState, Highlight, MoveNode, Note, NoteColor, Square } from '../types';
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
  | { type: 'ADD_NOTE'; color: NoteColor; text?: string; nodeId?: string; id?: string }
  | { type: 'UPDATE_NOTE'; id: string; text: string }
  | { type: 'DELETE_NOTE'; id: string; nodeId?: string }
  /** Set arrows on a node (default: the current one), replacing any on the same squares. */
  | { type: 'ADD_ARROWS'; arrows: Arrow[]; nodeId?: string }
  /**
   * Insert a line of UCI moves as a branch after `fromId`, reusing existing nodes whose move matches.
   * `newIds[i]` names the node created for move i. Lands on move `gotoIndex` (0 = fromId).
   */
  | { type: 'ADD_LINE'; fromId: string; moves: string[]; newIds: string[]; gotoIndex: number; notes?: { at: 'start' | 'end'; text: string; id: string; color: NoteColor }[] }
  /**
   * Always create a new child of `parentId` for a UCI move (even when a sibling has the same move), so a
   * simulated game gets its own branch. `goto` moves the board there. No-op if the move is illegal.
   */
  | { type: 'APPEND_MOVE'; parentId: string; uci: string; id: string; goto?: boolean }
  | { type: 'CHAT_APPEND'; messages: ChatMessage[] }
  | { type: 'CHAT_PATCH'; id: string; patch: Partial<ChatMessage> }
  | { type: 'CHAT_CLEAR' }
  /**
   * Erase in one go (undo with RESTORE_TREE). 'variations': every side line, keeping the main line with its
   * annotations; the board moves to the nearest main-line ancestor if its node goes. 'shapes': arrows and
   * highlights (including pinned model arrows) on every position; notes stay. 'all': both.
   */
  | { type: 'ERASE'; scope: EraseScope }
  /** Put back a move tree and position saved before an erase (the chat and game details stay as they are now). */
  | { type: 'RESTORE_TREE'; nodes: GameState['nodes']; currentId: string }
  | { type: 'LOAD_PGN'; pgn: string }
  /**
   * Store a game review and replace the review's notes (ids starting with REVIEW_NOTE_PREFIX) with `notes`.
   * `review: null` removes the review and its notes.
   */
  | { type: 'APPLY_REVIEW'; review: GameReview | null; notes: { nodeId: string; text: string; color: NoteColor }[] }
  | { type: 'NEW_GAME' }
  | { type: 'REPLACE'; state: GameState };

export type EraseScope = 'variations' | 'shapes' | 'all';

/** Notes written by the game review start with this id prefix, so a new review replaces them. */
export const REVIEW_NOTE_PREFIX = 'review-';

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

/** Ids of the main line: the root and its first children all the way down. */
export function mainLineIds(state: GameState): Set<string> {
  const keep = new Set<string>([ROOT_ID]);
  let node = state.nodes[ROOT_ID];
  while (node?.children.length) {
    node = state.nodes[node.children[0]];
    if (!node) break;
    keep.add(node.id);
  }
  return keep;
}

/** What an ERASE would remove: side-line moves, and arrows + highlights over all positions. */
export function eraseCounts(state: GameState): { sideMoves: number; shapes: number } {
  const all = Object.values(state.nodes);
  const shapes = all.reduce((n, x) => n + (x.annotation ? x.annotation.arrows.length + x.annotation.highlights.length : 0), 0);
  return { sideMoves: all.length - mainLineIds(state).size, shapes };
}

/**
 * Node ids and SANs for a line of UCI moves played from `fromId`: existing children are reused
 * when their move matches, otherwise `newIds[i]` is used. Null if a move is illegal.
 */
export function resolveLine(
  state: GameState,
  fromId: string,
  moves: string[],
  newIds: string[],
): { ids: string[]; sans: string[]; created: boolean[] } | null {
  if (!state.nodes[fromId]) return null;
  const chess = positionAt(state, fromId);
  const ids: string[] = [];
  const sans: string[] = [];
  const created: boolean[] = [];
  let parent: MoveNode | undefined = state.nodes[fromId];
  for (let i = 0; i < moves.length; i++) {
    const uci = moves[i];
    let san: string;
    try {
      san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      return null;
    }
    const existing: string | undefined = parent?.children.find((c) => state.nodes[c].san === san);
    ids.push(existing ?? newIds[i]);
    sans.push(san);
    created.push(!existing);
    parent = existing ? state.nodes[existing] : undefined;
  }
  return { ids, sans, created };
}

function withAnnotation(state: GameState, update: (a: Annotation) => Annotation, nodeId: string = state.currentId): GameState {
  const node = state.nodes[nodeId];
  if (!node) return state;
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
      const note: Note = { id: action.id ?? newId(), text: action.text ?? '', color: action.color, createdAt: Date.now() };
      return withAnnotation(state, (a) => ({ ...a, notes: [...a.notes, note] }), action.nodeId);
    }
    case 'ADD_ARROWS':
      return withAnnotation(
        state,
        (a) => ({
          ...a,
          arrows: [...a.arrows.filter((x) => !action.arrows.some((y) => y.from === x.from && y.to === x.to)), ...action.arrows],
        }),
        action.nodeId,
      );
    case 'ADD_LINE': {
      const r = resolveLine(state, action.fromId, action.moves, action.newIds);
      if (!r) return state;
      const nodes = { ...state.nodes };
      let parentId = action.fromId;
      r.ids.forEach((id, i) => {
        if (r.created[i]) {
          nodes[id] = { id, san: r.sans[i], parent: parentId, children: [] };
          nodes[parentId] = { ...nodes[parentId], children: [...nodes[parentId].children, id] };
        }
        parentId = id;
      });
      let next: GameState = { ...state, nodes };
      for (const n of action.notes ?? []) {
        const nodeId = n.at === 'start' || r.ids.length === 0 ? action.fromId : r.ids[r.ids.length - 1];
        next = gameReducer(next, { type: 'ADD_NOTE', color: n.color, text: n.text, id: n.id, nodeId });
      }
      const target = action.gotoIndex <= 0 ? action.fromId : r.ids[Math.min(action.gotoIndex, r.ids.length) - 1];
      return { ...next, currentId: target };
    }
    case 'APPEND_MOVE': {
      const parent = state.nodes[action.parentId];
      if (!parent || state.nodes[action.id]) return state;
      let san: string;
      try {
        san = positionAt(state, parent.id).move({ from: action.uci.slice(0, 2), to: action.uci.slice(2, 4), promotion: action.uci[4] }).san;
      } catch {
        return state;
      }
      const node: MoveNode = { id: action.id, san, parent: parent.id, children: [] };
      return {
        ...state,
        nodes: { ...state.nodes, [node.id]: node, [parent.id]: { ...parent, children: [...parent.children, node.id] } },
        currentId: action.goto ? node.id : state.currentId,
      };
    }
    case 'CHAT_APPEND':
      return { ...state, chat: [...(state.chat ?? []), ...action.messages] };
    case 'CHAT_PATCH':
      if (!state.chat?.some((m) => m.id === action.id)) return state;
      return { ...state, chat: state.chat.map((m) => (m.id === action.id ? { ...m, ...action.patch } : m)) };
    case 'CHAT_CLEAR':
      return { ...state, chat: [] };
    case 'UPDATE_NOTE':
      return withAnnotation(state, (a) => ({
        ...a,
        notes: a.notes.map((n) => (n.id === action.id ? { ...n, text: action.text } : n)),
      }));
    case 'DELETE_NOTE':
      return withAnnotation(state, (a) => ({ ...a, notes: a.notes.filter((n) => n.id !== action.id) }), action.nodeId);
    case 'ERASE': {
      let nodes = state.nodes;
      let currentId = state.currentId;
      const keep = mainLineIds(state);
      if (action.scope !== 'shapes' && keep.size < Object.keys(state.nodes).length) {
        nodes = {};
        for (const id of keep) {
          const node = state.nodes[id];
          nodes[id] = node.children.length > 1 ? { ...node, children: node.children.slice(0, 1) } : node;
        }
        while (!keep.has(currentId)) currentId = state.nodes[currentId].parent ?? ROOT_ID;
      }
      const hasShapes = (n: MoveNode) => !!n.annotation && (n.annotation.arrows.length > 0 || n.annotation.highlights.length > 0);
      if (action.scope !== 'variations' && Object.values(nodes).some(hasShapes)) {
        const stripped: GameState['nodes'] = {};
        for (const [id, node] of Object.entries(nodes)) {
          const a = node.annotation;
          if (!a || !hasShapes(node)) {
            stripped[id] = node;
            continue;
          }
          const next: MoveNode = { ...node };
          if (a.notes.length) next.annotation = { ...a, arrows: [], highlights: [] };
          else delete next.annotation;
          stripped[id] = next;
        }
        nodes = stripped;
      }
      return nodes === state.nodes && currentId === state.currentId ? state : { ...state, nodes, currentId };
    }
    case 'RESTORE_TREE':
      if (!action.nodes[ROOT_ID]) return state;
      return { ...state, nodes: action.nodes, currentId: action.nodes[action.currentId] ? action.currentId : ROOT_ID };
    case 'LOAD_PGN': {
      try {
        return gameFromParsed(parsePgn(action.pgn));
      } catch {
        return state;
      }
    }
    case 'APPLY_REVIEW': {
      const nodes = { ...state.nodes };
      for (const [id, node] of Object.entries(nodes)) {
        const a = node.annotation;
        if (!a?.notes.some((n) => n.id.startsWith(REVIEW_NOTE_PREFIX))) continue;
        const notes = a.notes.filter((n) => !n.id.startsWith(REVIEW_NOTE_PREFIX));
        const next: MoveNode = { ...node };
        if (notes.length || a.arrows.length || a.highlights.length) next.annotation = { ...a, notes };
        else delete next.annotation;
        nodes[id] = next;
      }
      let next: GameState = { ...state, nodes };
      if (action.review) next.review = action.review;
      else delete next.review;
      for (const n of action.notes) {
        if (!nodes[n.nodeId]) continue;
        next = gameReducer(next, { type: 'ADD_NOTE', color: n.color, text: n.text, nodeId: n.nodeId, id: `${REVIEW_NOTE_PREFIX}${newId()}` });
      }
      return next;
    }
    case 'NEW_GAME':
      return initialGameState();
    case 'REPLACE':
      return action.state;
  }
}

export { toPgn } from './pgn';
