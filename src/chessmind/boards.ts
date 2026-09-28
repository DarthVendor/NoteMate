/*
 * Port of ChessMind's board-embedding codes (chessmind/data/boards.py). Each token gets a row of 68 codes:
 *   slots 0..63  piece on a1..h8: 0 empty, 1..6 white P N B R Q K, 7..12 black
 *   slot 64      side to move (0 white, 1 black)
 *   slot 65      castling rights mask (K=1, Q=2, k=4, q=8)
 *   slot 66      en-passant file + 1 (0 = none; set after every double pawn push, like python-chess ep_square)
 *   slot 67      1 = a board is present
 * Tokens without a board get a row of ABSENT. The row of a move token is the position after that move.
 * Checked against Python by scripts/test-chessmind.mjs (fixture from ChessMind's scripts/board_codes_fixture.py).
 */
import { Chess } from 'chess.js';
import type { ChessTokenizer, Perspective } from './tokenizer';

export const N_SLOTS = 68;
export const ABSENT = 16;
const PIECE_CODE: Record<string, number> = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

export type BoardRow = number[];
export const ABSENT_ROW: BoardRow = new Array(N_SLOTS).fill(ABSENT);

/** Row for a chess.js position; `epFile` is 0..7 or null. */
export function encodeBoardState(chess: Chess, epFile: number | null): BoardRow {
  const row: BoardRow = new Array(N_SLOTS).fill(0);
  const grid = chess.board(); // grid[0] is rank 8
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = grid[r][f];
      if (p) row[(7 - r) * 8 + f] = PIECE_CODE[p.type] + (p.color === 'w' ? 0 : 6);
    }
  }
  row[64] = chess.turn() === 'w' ? 0 : 1;
  const w = chess.getCastlingRights('w');
  const b = chess.getCastlingRights('b');
  row[65] = (w.k ? 1 : 0) | (w.q ? 2 : 0) | (b.k ? 4 : 0) | (b.q ? 8 : 0);
  row[66] = epFile === null ? 0 : epFile + 1;
  row[67] = 1;
  return row;
}

/** Row for a FEN (en-passant square taken verbatim from the FEN, as python-chess does). */
export function encodeFen(fen: string): BoardRow {
  const ep = fen.split(' ')[3];
  return encodeBoardState(new Chess(fen), ep && ep !== '-' ? ep.charCodeAt(0) - 97 : null);
}

/** A board that follows UCI moves and knows its en-passant file. */
export class TrackedBoard {
  readonly chess: Chess;
  ep: number | null = null;
  /** The position before each push (FEN + en-passant file), for pop(); copies keep it. */
  private prev: { fen: string; ep: number | null }[] = [];
  constructor(fen?: string, skipValidation = false) {
    this.chess = new Chess(fen, { skipValidation });
    const ep = fen?.split(' ')[3];
    this.ep = ep && ep !== '-' ? ep.charCodeAt(0) - 97 : null;
  }
  /** Play `uci` if legal (exact UCI match, promotions included); false otherwise. */
  push(uci: string): boolean {
    const mv = this.chess.moves({ verbose: true }).find((m) => m.lan === uci);
    if (!mv) return false;
    this.prev.push({ fen: this.chess.fen(), ep: this.ep });
    this.chess.move(mv);
    this.ep = mv.flags.includes('b') ? mv.from.charCodeAt(0) - 97 : null;
    return true;
  }
  row(): BoardRow {
    return encodeBoardState(this.chess, this.ep);
  }
  /** Take back the last push (false when there is none). */
  pop(): boolean {
    const p = this.prev.pop();
    if (!p) return false;
    this.chess.load(p.fen, { skipValidation: true });
    this.ep = p.ep;
    return true;
  }
  copy(): TrackedBoard {
    const b = new TrackedBoard(this.chess.fen(), true);
    b.ep = this.ep;
    b.prev = [...this.prev];
    return b;
  }
}

/**
 * Board of a `<side> + 64 piece tokens (a8..h1)` snapshot, null if malformed (boards._board_from_snapshot): no
 * en-passant square, castling rights = those consistent with king and rook placement.
 */
export function boardFromSnapshot(tok: ChessTokenizer, ids: number[]): TrackedBoard | null {
  const fen = tok.snapshotFen(ids);
  if (fen === null) return null;
  const [placement, side] = fen.split(' ');
  const grid = placement.split('/').map((r) => r.replace(/\d/g, (d) => '.'.repeat(Number(d))));
  const at = (sq: string) => grid[8 - Number(sq[1])][sq.charCodeAt(0) - 97];
  let castling = '';
  if (at('e1') === 'K' && at('h1') === 'R') castling += 'K';
  if (at('e1') === 'K' && at('a1') === 'R') castling += 'Q';
  if (at('e8') === 'k' && at('h8') === 'r') castling += 'k';
  if (at('e8') === 'k' && at('a8') === 'r') castling += 'q';
  try {
    return new TrackedBoard(`${placement} ${side} ${castling || '-'} - 0 1`, true);
  } catch {
    return null;
  }
}

/**
 * Port of BoardTracker (chessmind/data/boards.py): <|game|> and <|line|> start a fresh board; <|end_line|>, <|eos|>,
 * <|pad|>, <|bos|>, <|user|>, <|assistant|> end it; legal move tokens are pushed; every other token keeps the
 * current row. `<|fen|> <side> <64 pieces>` snapshots are parsed: the board shows from the snapshot's last token and
 * later <|line|>s start from it (until the next snapshot or <|bos|> / <|eos|> / <|pad|>). Hidden reasoning
 * (format 4): a snapshot taken inside `<|think|> ... <|end_think|>` applies until <|end_think|> only, which shows no
 * board. In-game calculation: a <|line|> while a <|game|> board is active starts from a copy of that board and
 * <|end_line|> returns to it. Think-then-move (`<|game|> ... <|think|> <side> text / lines <|end_think|> move`): inside
 * a game <|end_think|> shows the game position again (closing a line left open) instead of ending the board, so the
 * move after it is played on the game board. `startFen`: the first <|game|> starts there (a cropped game).
 * Line branches (format 5): inside a line <|branch|> starts from the position before the last move of the current
 * segment (the current position when it has no move yet) and <|end_branch|> returns to the enclosing segment's board;
 * outside a line (or without an open branch) they keep the row. End markers keep the row; ending the line drops open
 * branches.
 */
export class BoardTracker {
  private board: TrackedBoard | null = null;
  private current: BoardRow = ABSENT_ROW;
  private readonly starts: Set<number>;
  private readonly ends: Set<number>;
  private readonly tok: ChessTokenizer;
  private readonly endThink: number | null;
  private startFen: string | null;
  /** Start position for later <|line|>s. */
  private snapshot: TrackedBoard | null = null;
  /** Collecting <side> + 64 pieces after <|fen|>. */
  private fenTokens: number[] | null = null;
  /** The snapshot before <|think|> (boxed: null = not in a think). */
  private thinkSaved: { snapshot: TrackedBoard | null } | null = null;
  /** A <|game|> board is being followed. */
  private inGame = false;
  /** The game board while an in-game <|line|> runs. */
  private gameBoard: TrackedBoard | null = null;
  private readonly branch: number | null;
  private readonly endBranch: number | null;
  /** Enclosing (board, moves in its segment) per open branch. */
  private frames: { board: TrackedBoard; segMoves: number }[] = [];
  /** Moves pushed in the current line segment. */
  private segMoves = 0;
  constructor(tok: ChessTokenizer, startFen?: string) {
    this.tok = tok;
    this.startFen = startFen ?? null;
    this.endThink = tok.endThinkId;
    this.branch = tok.branchId;
    this.endBranch = tok.endBranchId;
    this.starts = new Set([tok.gameId, tok.lineId]);
    this.ends = new Set([tok.endLineId, tok.eosId, tok.id('<|pad|>'), tok.bosId, tok.userId, tok.assistantId]);
  }
  feed(id: number): BoardRow {
    const row = this.feedOne(id);
    if (this.board === null || this.starts.has(id)) {
      this.frames = [];
      this.segMoves = 0;
    }
    return row;
  }
  private inLine(): boolean {
    return this.board !== null && (!this.inGame || this.gameBoard !== null);
  }
  private feedOne(id: number): BoardRow {
    const tok = this.tok;
    if (this.fenTokens !== null) {
      this.fenTokens.push(id);
      if (this.fenTokens.length === 65) {
        this.snapshot = boardFromSnapshot(tok, this.fenTokens);
        this.fenTokens = null;
        if (this.snapshot) this.current = this.snapshot.row();
      }
      return this.current;
    }
    if (this.branch !== null && id === this.branch) {
      if (this.inLine()) {
        this.frames.push({ board: this.board!, segMoves: this.segMoves });
        this.board = this.board!.copy();
        if (this.segMoves > 0) this.board.pop();
        this.segMoves = 0;
        this.current = this.board.row();
      }
      return this.current;
    }
    if (this.endBranch !== null && id === this.endBranch) {
      if (this.inLine() && this.frames.length) {
        const f = this.frames.pop()!;
        this.board = f.board;
        this.segMoves = f.segMoves;
        this.current = this.board.row();
      }
      return this.current;
    }
    if (id === tok.fenId) {
      this.fenTokens = [];
      this.board = null;
      this.current = ABSENT_ROW;
      return this.current;
    }
    if (id === tok.bosId || id === tok.eosId || id === tok.id('<|pad|>')) {
      this.snapshot = null; // a new sequence / dialogue
      this.thinkSaved = null;
    }
    if (id === tok.thinkId && !this.inGame) {
      this.thinkSaved = { snapshot: this.snapshot };
    } else if (this.endThink !== null && id === this.endThink) {
      if (this.inGame && this.board) {
        // think-then-move: back to the game position (a line left open closes with the think), so the move after
        // <|end_think|> is played on the game board
        if (this.gameBoard) {
          this.board = this.gameBoard;
          this.gameBoard = null;
        }
        this.frames = [];
        this.current = this.board.row();
        return this.current;
      }
      if (this.thinkSaved) {
        this.snapshot = this.thinkSaved.snapshot;
        this.thinkSaved = null;
      }
      this.board = null;
      this.current = ABSENT_ROW;
      return this.current;
    }
    if (id === tok.lineId && this.inGame && this.board) {
      this.gameBoard = this.board; // calculation inside a game: the line starts from the game position
      this.board = this.gameBoard.copy();
      this.current = this.board.row();
    } else if (id === tok.endLineId && this.gameBoard) {
      this.board = this.gameBoard; // back to the game after the calculated line
      this.gameBoard = null;
      this.current = this.board.row();
    } else if (this.starts.has(id)) {
      if (this.startFen !== null && id === tok.gameId) {
        this.board = new TrackedBoard(this.startFen);
        this.startFen = null; // only the first game of the sequence
      } else if (id === tok.lineId && this.snapshot) this.board = this.snapshot.copy();
      else this.board = new TrackedBoard();
      this.inGame = id === tok.gameId;
      this.current = this.board.row();
    } else if (this.ends.has(id)) {
      this.board = null;
      this.inGame = false;
      this.gameBoard = null;
      this.current = ABSENT_ROW;
    } else if (this.board && tok.isMoveId(id)) {
      if (this.board.push(tok.idToMove(id))) {
        this.segMoves++;
        this.current = this.board.row();
      }
    }
    return this.current;
  }
  rows(ids: number[]): BoardRow[] {
    return ids.map((i) => this.feed(i));
  }
}

/**
 * `<|game|>` + the last `k` moves, the game token carrying the board at the crop point (so the model sees
 * the real position while attending over k + 1 tokens). k = null: the whole game. With a perspective
 * (per-side models) the prefix is `<|bos|> <|game|> <side>`: <|bos|> has no board, the side token keeps the
 * game token's board -- exactly the rows ChessMind's BoardTracker gives a cropped training instance.
 */
export function encodeGameWithBoards(
  tok: ChessTokenizer,
  moves: string[],
  k: number | null,
  perspective?: Perspective,
): { ids: number[]; rows: BoardRow[] } {
  const start = k === null ? 0 : Math.max(0, moves.length - k);
  const board = new TrackedBoard();
  for (let i = 0; i < start; i++) if (!board.push(moves[i])) throw new Error(`illegal move ${moves[i]}`);
  const ids: number[] = [];
  const rows: BoardRow[] = [];
  if (perspective) {
    ids.push(tok.bosId);
    rows.push(ABSENT_ROW);
  }
  ids.push(tok.gameId);
  rows.push(board.row());
  if (perspective) {
    ids.push(tok.perspectiveId(perspective));
    rows.push(rows[rows.length - 1]);
  }
  for (let i = start; i < moves.length; i++) {
    if (!board.push(moves[i])) throw new Error(`illegal move ${moves[i]}`);
    ids.push(tok.moveToId(moves[i]));
    rows.push(board.row());
  }
  return { ids, rows };
}
