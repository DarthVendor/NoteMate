/*
 * Setting up a position (the Set position dialog): FEN validation that goes beyond chess.js's structural checks
 * (the side not to move in check, castling rights that match the pieces, pawn and piece counts, a real en-passant
 * square), and the board editor's model (pieces by square, side to move, castling rights, en-passant square), kept
 * convertible to and from FEN so the text field and the editor stay in sync.
 */
import { Chess, DEFAULT_POSITION, validateFen as chessJsValidate, type Color, type PieceSymbol } from 'chess.js';
import type { GameState, Square } from '../types';
import { ROOT_ID } from '../types';

export interface EditorPiece {
  color: Color;
  type: PieceSymbol;
}

export type CastleRight = 'K' | 'Q' | 'k' | 'q';
export const CASTLE_RIGHTS: CastleRight[] = ['K', 'Q', 'k', 'q'];

/** The editor's position: pieces by square plus the FEN's state fields. */
export interface EditorPosition {
  pieces: Partial<Record<Square, EditorPiece>>;
  turn: Color;
  castling: Record<CastleRight, boolean>;
  ep: Square | null;
  halfmove: number;
  fullmove: number;
}

export const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

const FILES = 'abcdefgh';
const sq = (file: number, rank: number) => `${FILES[file]}${rank + 1}` as Square;

/** The squares a castling right needs: the king and the rook on their home squares. */
export const CASTLE_SQUARES: Record<CastleRight, { king: Square; rook: Square; color: Color; label: string }> = {
  K: { king: 'e1', rook: 'h1', color: 'w', label: 'White O-O' },
  Q: { king: 'e1', rook: 'a1', color: 'w', label: 'White O-O-O' },
  k: { king: 'e8', rook: 'h8', color: 'b', label: 'Black O-O' },
  q: { king: 'e8', rook: 'a8', color: 'b', label: 'Black O-O-O' },
};

/** Split a FEN's placement field into pieces by square (no validation beyond the shape). Null if malformed. */
function parsePlacement(placement: string): Partial<Record<Square, EditorPiece>> | null {
  const rows = placement.split('/');
  if (rows.length !== 8) return null;
  const pieces: Partial<Record<Square, EditorPiece>> = {};
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (/[1-8]/.test(ch)) file += Number(ch);
      else if (/[pnbrqkPNBRQK]/.test(ch)) {
        if (file > 7) return null;
        pieces[sq(file, 7 - r)] = { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() as PieceSymbol };
        file++;
      } else return null;
    }
    if (file !== 8) return null;
  }
  return pieces;
}

/** The editor position of a FEN (lenient: missing fields get defaults). Null when the placement is malformed. */
export function parseEditorFen(fen: string): EditorPosition | null {
  const f = fen.trim().split(/\s+/);
  const pieces = parsePlacement(f[0] ?? '');
  if (!pieces) return null;
  const castle = f[2] ?? '-';
  const ep = /^[a-h][36]$/.test(f[3] ?? '') ? (f[3] as Square) : null;
  return {
    pieces,
    turn: f[1] === 'b' ? 'b' : 'w',
    castling: { K: castle.includes('K'), Q: castle.includes('Q'), k: castle.includes('k'), q: castle.includes('q') },
    ep,
    halfmove: Number.isFinite(Number(f[4])) && f[4] !== undefined ? Math.max(0, Math.floor(Number(f[4]))) : 0,
    fullmove: Number.isFinite(Number(f[5])) && f[5] !== undefined ? Math.max(1, Math.floor(Number(f[5]))) : 1,
  };
}

/** FEN of an editor position, exactly as the fields say (see normalizeEditor for dropping impossible rights). */
export function editorFen(p: EditorPosition): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const piece = p.pieces[sq(f, r)];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const castle = CASTLE_RIGHTS.filter((c) => p.castling[c]).join('') || '-';
  return `${rows.join('/')} ${p.turn} ${castle} ${p.ep ?? '-'} ${p.halfmove} ${p.fullmove}`;
}

/** Whether the pieces allow a castling right (the king and that rook on their home squares). */
export function castleAllowed(p: EditorPosition, c: CastleRight): boolean {
  const { king, rook, color } = CASTLE_SQUARES[c];
  const k = p.pieces[king];
  const r = p.pieces[rook];
  return k?.type === 'k' && k.color === color && r?.type === 'r' && r.color === color;
}

/**
 * En-passant squares that make sense for the side to move: the opponent's pawn just made a double step (it stands in
 * front of the square, the square and the one behind it are empty) and a pawn of the side to move can capture it.
 */
export function epCandidates(p: EditorPosition): Square[] {
  const out: Square[] = [];
  const them: Color = p.turn === 'w' ? 'b' : 'w';
  const epRank = p.turn === 'w' ? 5 : 2; // 0-based rank of the ep square (6th / 3rd)
  const pawnRank = p.turn === 'w' ? 4 : 3; // where the double-stepped pawn stands
  const fromRank = p.turn === 'w' ? 6 : 1; // where it came from
  for (let f = 0; f < 8; f++) {
    const pawn = p.pieces[sq(f, pawnRank)];
    if (pawn?.type !== 'p' || pawn.color !== them) continue;
    if (p.pieces[sq(f, epRank)] || p.pieces[sq(f, fromRank)]) continue;
    const capturer = [f - 1, f + 1].some((x) => {
      if (x < 0 || x > 7) return false;
      const q = p.pieces[sq(x, pawnRank)];
      return q?.type === 'p' && q.color === p.turn;
    });
    if (capturer) out.push(sq(f, epRank));
  }
  return out;
}

/** Drop castling rights the pieces no longer allow and an en-passant square that is not possible. */
export function normalizeEditor(p: EditorPosition): EditorPosition {
  const castling = { ...p.castling };
  for (const c of CASTLE_RIGHTS) if (castling[c] && !castleAllowed(p, c)) castling[c] = false;
  const ep = p.ep && epCandidates(p).includes(p.ep) ? p.ep : null;
  return { ...p, castling, ep };
}

export type FenCheck = { ok: true; fen: string; warning?: string } | { ok: false; error: string };

const sideName = (c: Color) => (c === 'w' ? 'White' : 'Black');

/**
 * Validate a FEN as a game's starting position: chess.js's checks (six fields, one king each, no pawns on the edge
 * ranks, a well-formed en-passant square) plus the position being reachable enough to play from: the side not to move
 * is not in check, the castling rights match the pieces, at most 8 pawns and 16 pieces a side, and an en-passant
 * square only behind a pawn that just made a double step. Returns chess.js's normalised FEN; `warning` for a
 * position with no legal moves (checkmate or stalemate), which can still be set up.
 */
export function checkFen(input: string): FenCheck {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, error: 'Enter a FEN, e.g. the standard start: ' + DEFAULT_POSITION };
  // A FEN with only the placement (and maybe the side to move) is completed with the usual defaults.
  const fields = text.split(' ');
  const defaults = ['', 'w', '-', '-', '0', '1'];
  const full = fields.length < 6 ? [...fields, ...defaults.slice(fields.length)].join(' ') : text;
  const placement = parsePlacement(fields[0]);
  if (!placement) return { ok: false, error: 'The piece placement must have 8 ranks separated by "/", each with 8 squares (pieces pnbrqk/PNBRQK or digits 1-8).' };
  const basic = chessJsValidate(full);
  if (!basic.ok) return { ok: false, error: (basic.error ?? 'Invalid FEN').replace(/^Invalid FEN: /, '').replace(/^./, (c) => c.toUpperCase()) + '.' };

  const pos = parseEditorFen(full)!;
  const all = Object.values(pos.pieces) as EditorPiece[];
  for (const c of ['w', 'b'] as Color[]) {
    const mine = all.filter((x) => x.color === c);
    const pawns = mine.filter((x) => x.type === 'p').length;
    if (pawns > 8) return { ok: false, error: `${sideName(c)} has ${pawns} pawns (at most 8).` };
    if (mine.length > 16) return { ok: false, error: `${sideName(c)} has ${mine.length} pieces (at most 16).` };
    // Promoted pieces come from pawns: extra queens, rooks, bishops and knights beyond the starting set each cost one.
    const extra = (['q', 'r', 'b', 'n'] as const).reduce((n, t) => n + Math.max(0, mine.filter((x) => x.type === t).length - (t === 'q' ? 1 : 2)), 0);
    if (pawns + extra > 8) return { ok: false, error: `${sideName(c)} has more promoted pieces than missing pawns allow.` };
  }
  for (const c of CASTLE_RIGHTS) {
    if (pos.castling[c] && !castleAllowed(pos, c)) {
      const { king, rook, label } = CASTLE_SQUARES[c];
      return { ok: false, error: `Castling right "${c}" (${label}) needs the king on ${king} and the rook on ${rook}. Remove "${c}" from the castling field.` };
    }
  }
  if (pos.ep && !epPawnPresent(pos)) {
    return { ok: false, error: `En-passant square ${pos.ep} is not possible: no ${sideName(pos.turn === 'w' ? 'b' : 'w')} pawn just made a double step past it.` };
  }

  let chess: Chess;
  try {
    chess = new Chess(full);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.replace(/^Invalid FEN: /, '') : 'Invalid FEN.' };
  }
  const other: Color = pos.turn === 'w' ? 'b' : 'w';
  const otherKing = (Object.entries(pos.pieces) as [Square, EditorPiece][]).find(([, x]) => x.type === 'k' && x.color === other)?.[0];
  if (otherKing && chess.isAttacked(otherKing, pos.turn)) {
    return { ok: false, error: `${sideName(other)} is in check but it is ${sideName(pos.turn)}'s move. Either switch the side to move or take the check away.` };
  }
  const fen = chess.fen();
  if (chess.isCheckmate()) return { ok: true, fen, warning: `${sideName(pos.turn)} is checkmated: there are no moves to play from here.` };
  if (chess.isStalemate()) return { ok: true, fen, warning: `${sideName(pos.turn)} is stalemated: there are no moves to play from here.` };
  return { ok: true, fen };
}

/** The pawn that made the double step stands in front of the en-passant square (whether or not it can be taken). */
function epPawnPresent(p: EditorPosition): boolean {
  if (!p.ep) return false;
  const f = FILES.indexOf(p.ep[0]);
  const them: Color = p.turn === 'w' ? 'b' : 'w';
  const pawn = p.pieces[sq(f, p.turn === 'w' ? 4 : 3)];
  const rankOk = p.ep[1] === (p.turn === 'w' ? '6' : '3');
  return rankOk && pawn?.type === 'p' && pawn.color === them && !p.pieces[p.ep] && !p.pieces[sq(f, p.turn === 'w' ? 6 : 1)];
}

/**
 * Plies before a game's first move, from its start FEN's move number and side to move (0 for the standard start):
 * a game set up at "... b - - 0 23" numbers its first move 23... . Move number n, White's ply = 2n - 1.
 */
export function plyOffset(fen: string): number {
  const f = fen.split(' ');
  const full = Math.max(1, Math.floor(Number(f[5])) || 1);
  return 2 * (full - 1) + (f[1] === 'b' ? 1 : 0);
}

/** Whether a FEN is the standard starting position (ignoring the move counters). */
export function isStandardStart(fen: string): boolean {
  return fen.split(' ').slice(0, 4).join(' ') === DEFAULT_POSITION.split(' ').slice(0, 4).join(' ');
}

/** A fresh game (no moves, no chat) starting from `fen` (assumed valid; see checkFen). */
export function gameFromFen(fen: string): GameState {
  const startFen = new Chess(fen).fen();
  return {
    version: 2,
    startFen,
    nodes: { [ROOT_ID]: { id: ROOT_ID, san: '', parent: null, children: [] } },
    currentId: ROOT_ID,
    meta: { source: isStandardStart(startFen) ? 'manual' : 'setup' },
    chat: [],
  };
}
