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
  constructor(fen?: string) {
    this.chess = new Chess(fen);
    const ep = fen?.split(' ')[3];
    this.ep = ep && ep !== '-' ? ep.charCodeAt(0) - 97 : null;
  }
  /** Play `uci` if legal (exact UCI match, promotions included); false otherwise. */
  push(uci: string): boolean {
    const mv = this.chess.moves({ verbose: true }).find((m) => m.lan === uci);
    if (!mv) return false;
    this.chess.move(mv);
    this.ep = mv.flags.includes('b') ? mv.from.charCodeAt(0) - 97 : null;
    return true;
  }
  row(): BoardRow {
    return encodeBoardState(this.chess, this.ep);
  }
}

/**
 * Port of BoardTracker: <|game|> and <|line|> start a fresh board; <|end_line|>, <|eos|>, <|pad|>, <|bos|>,
 * <|user|>, <|assistant|> end it; legal move tokens are pushed; every other token keeps the current row.
 */
export class BoardTracker {
  private board: TrackedBoard | null = null;
  private current: BoardRow = ABSENT_ROW;
  private readonly starts: Set<number>;
  private readonly ends: Set<number>;
  private readonly tok: ChessTokenizer;
  constructor(tok: ChessTokenizer) {
    this.tok = tok;
    this.starts = new Set([tok.gameId, tok.lineId]);
    this.ends = new Set([tok.endLineId, tok.eosId, tok.id('<|pad|>'), tok.id('<|bos|>'), tok.userId, tok.assistantId]);
  }
  feed(id: number): BoardRow {
    if (this.starts.has(id)) {
      this.board = new TrackedBoard();
      this.current = this.board.row();
    } else if (this.ends.has(id)) {
      this.board = null;
      this.current = ABSENT_ROW;
    } else if (this.board && this.tok.isMoveId(id)) {
      if (this.board.push(this.tok.idToMove(id))) this.current = this.board.row();
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
