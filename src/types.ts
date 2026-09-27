export type Square = `${'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'}${1|2|3|4|5|6|7|8}`;

/** 'engine' is reserved for the engine's suggested move and is never drawn by the user. */
export type ShapeColor = 'green' | 'red' | 'blue' | 'yellow' | 'engine';

export interface Arrow {
  from: Square;
  to: Square;
  color: ShapeColor;
}

export interface Highlight {
  square: Square;
  color: ShapeColor;
}

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green';

export interface Note {
  id: string;
  text: string;
  color: NoteColor;
  createdAt: number;
}

export interface Annotation {
  arrows: Arrow[];
  highlights: Highlight[];
  notes: Note[];
}

export interface GameMeta {
  white?: string;
  black?: string;
  event?: string;
  date?: string;
  result?: string;
  source?: 'manual' | 'pgn' | 'chess.com' | 'chessbase';
}

/** One position in the move tree. The root node has no move and represents startFen. */
export interface MoveNode {
  id: string;
  /** SAN of the move that led here. Empty for the root. */
  san: string;
  parent: string | null;
  /** Child ids. The first child is the main continuation; the rest are variations. */
  children: string[];
  annotation?: Annotation;
}

export const ROOT_ID = 'root';

/** A single game as a tree of moves, with annotations attached to nodes. */
export interface GameState {
  version: 2;
  startFen: string;
  nodes: Record<string, MoveNode>;
  /** Node whose position is displayed. */
  currentId: string;
  meta: GameMeta;
}

export const emptyAnnotation = (): Annotation => ({ arrows: [], highlights: [], notes: [] });
