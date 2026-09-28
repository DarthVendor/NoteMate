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
  whiteElo?: string;
  blackElo?: string;
  /** PGN TimeControl, e.g. "600" or "180+2" (seconds + increment). */
  timeControl?: string;
  /** How the game ended, e.g. "Hikaru won by resignation". */
  termination?: string;
  /** The game's page (chess.com "Link" header). */
  link?: string;
  /** Imported from a site for this player: their colour decides the board orientation. */
  player?: string;
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

/** How a line segment ended (format-5 end markers <|mate|> / <|draw|> / <|repetition|>). */
export type LineMark = 'mate' | 'draw' | 'repetition';
/** A variation inside a line (<|branch|> ... <|end_branch|>): replaces the enclosing line's move `at` (0-based), like a
 * PGN parenthesised variation; branches nest. */
export interface LineBranch {
  at: number;
  moves: string[];
  branches?: LineBranch[];
  end?: LineMark;
}
/** A move line: the main line's UCI moves, its branches and its end marker. */
export type ChatLinePart = { kind: 'line'; moves: string[]; branches?: LineBranch[]; end?: LineMark };
/** A tool call of the model (`<|tool|> name [line] <|tool_result|>`) and the result the app inserted (ChessMind
 * docs/tools.md). `moves`: the call's line (the position asked about, from where lines start); `result`: undefined
 * while the call waits for its result; `ok` false for an error result (timeout); `fen`: the position the app ran the
 * tool on (set by the worker). */
export type ChatToolPart = { kind: 'tool'; name: string; moves?: string[]; result?: string; ok?: boolean; fen?: string };
/** One part of a ChessMind chat message: text, a line of UCI moves, a board snapshot, or a tool call. */
export type ChatLeafPart = { kind: 'text'; text: string } | ChatLinePart | { kind: 'fen'; fen: string } | ChatToolPart;
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
  /** The line's branches inserted as variations: `path` (lines.ts lineVariations) and the node ids of the whole
   * variation from the line start (shared moves included). */
  branches?: { path: number[]; ids: string[]; created: boolean[] }[];
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
  /** User questions: the context part sent after the question (position note, engine or candidates block;
   * chessmind/promptContext.ts). Not shown as the message text and not re-sent with later questions. */
  contextText?: string;
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
  /** Engine game review (Review panel): per-move losses and a per-side summary. */
  review?: GameReview;
}

export type MoveClass = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/** One main-line move judged by the engine (win% from the mover's point of view). */
export interface ReviewedMove {
  nodeId: string;
  ply: number;
  san: string;
  /** Win% before the move (best play) and after it. */
  before: number;
  after: number;
  loss: number;
  cls: MoveClass;
  /** Engine's best move (SAN) in the position before, when it differs from the move played. */
  best?: string;
}

export interface ReviewSide {
  accuracy: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
}

export interface GameReview {
  depth: number;
  engine: string;
  moves: ReviewedMove[];
  white: ReviewSide;
  black: ReviewSide;
  /** Main-line length when the review ran (a changed main line makes it stale). */
  plies: number;
  createdAt: number;
}

export const emptyAnnotation = (): Annotation => ({ arrows: [], highlights: [], notes: [] });
