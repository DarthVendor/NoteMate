export type Square = `${'a'|'b'|'c'|'d'|'e'|'f'|'g'|'h'}${1|2|3|4|5|6|7|8}`;

/** 'engine' and 'chessmind' are reserved for suggested moves and are never drawn by the user. */
export type ShapeColor = 'green' | 'red' | 'blue' | 'yellow' | 'engine' | 'chessmind';

export interface Arrow {
  from: Square;
  to: Square;
  color: ShapeColor;
  /** Optional opacity override (used to fade less likely ChessMind moves). */
  opacity?: number;
}

export interface Highlight {
  square: Square;
  color: ShapeColor;
}

/** 'chessmind' marks notes written from ChessMind answers. */
export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'chessmind';

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

/** One part of a ChessMind chat message: text, a line of UCI moves, or a board snapshot. */
export type ChatLeafPart = { kind: 'text'; text: string } | { kind: 'line'; moves: string[] } | { kind: 'fen'; fen: string };
/** ...or (first part of an assistant answer, format-4 models) hidden reasoning: `<|think|> parts <|end_think|>`. */
export type ChatPart =
  | ChatLeafPart
  /** `open`: no <|end_think|> yet (streaming); `tokens`: ids generated inside the think (both set by the worker). */
  | { kind: 'think'; parts: ChatLeafPart[]; open?: boolean; tokens?: number };

/** Where an answer's line was inserted into the move tree. */
export interface ChatLineState {
  fromId: string;
  /** Node ids of the line's moves. */
  ids: string[];
  /** True for nodes the insertion created (the rest already existed). */
  created: boolean[];
  /** Notes added with the line (removed again by Discard). */
  notes: { nodeId: string; id: string }[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 'model' = a ChessMind answer, 'command' = a board command handled locally, 'analysis' = top moves + explanation. */
  kind: 'model' | 'command' | 'analysis';
  parts: ChatPart[];
  /** Node the question was asked at. */
  originId?: string;
  /** Set when lines in the answer start from this position instead of the initial one. */
  fen?: string;
  /** Moves (UCI, from the start) sent to the model as context. */
  context?: string[];
  predictions?: { uci: string; p: number }[];
  /** Answer lines already inserted into the tree, by part index. */
  lines?: Record<number, ChatLineState>;
  tokens?: number;
  msPerToken?: number;
  prefillMs?: number;
  done?: boolean;
  stopped?: boolean;
}

/** A single game as a tree of moves, with annotations attached to nodes. */
export interface GameState {
  version: 2;
  startFen: string;
  nodes: Record<string, MoveNode>;
  /** Node whose position is displayed. */
  currentId: string;
  meta: GameMeta;
  /** ChessMind conversation about this game. */
  chat?: ChatMessage[];
}

export const emptyAnnotation = (): Annotation => ({ arrows: [], highlights: [], notes: [] });
