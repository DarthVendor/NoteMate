/*
 * Port of ChessMind's board-embedding codes (chessmind/data/boards.py). Each token gets a row of 68 codes:
 *   slots 0..63  piece on a1..h8: 0 empty, 1..6 white P N B R Q K, 7..12 black
 *   slot 64      side to move (0 white, 1 black)
 *   slot 65      castling rights mask (K=1, Q=2, k=4, q=8)
 *   slot 66      en-passant file + 1 (0 = none; set after every double pawn push, like python-chess ep_square)
 *   slot 67      1 = a board is present
 * Tokens without a board get a row of ABSENT. The row of a move token is the position after that move.
 * Checked against Python by scripts/test-chessmind.mjs (fixture from ChessMind's scripts/board_codes_fixture.py).
 *
 * v6 board design (ChessMind docs/board-embedding.md; manifest `board_sync` / `board_features`): feature planes after
 * slot 67 (FEATURE_ORDER: state, material, pawns, attacks, flags) and the "pod" tracker (text sees the position
 * under discussion). Checked by scripts/test-board-v6.mjs (fixture from ChessMind's scripts/board_v6_fixture.py).
 */
import { Chess } from 'chess.js';
import type { ChessTokenizer, Perspective } from './tokenizer';

export const N_SLOTS = 68;
export const ABSENT = 16;
const PIECE_CODE: Record<string, number> = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

export type BoardRow = number[];
export const ABSENT_ROW: BoardRow = new Array(N_SLOTS).fill(ABSENT);

/** Extra planes after slot 67 and their widths, always in this order (boards.FEATURE_SLOTS). */
export const FEATURE_SLOTS: Record<string, number> = { state: 5, material: 10, pawns: 16, attacks: 64, flags: 64 };
export const FEATURE_ORDER = ['state', 'material', 'pawns', 'attacks', 'flags'] as const;
export type BoardSync = 'legacy' | 'pod';
/** Row kinds (state plane): the live game position, a line / branch position, the position under discussion. */
export const KIND_GAME = 0;
export const KIND_LINE = 1;
export const KIND_DISCUSSED = 2;
const HALFMOVE_BUCKETS = [0, 1, 2, 3, 4, 5, 7, 9, 14, 19, 29, 39, 59, 79, 99];
const FULLMOVE_BUCKETS = [2, 4, 6, 8, 10, 12, 15, 18, 21, 25, 30, 35, 40, 50, 60];
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** `features` in FEATURE_ORDER (unknown names throw). */
export function normalizeFeatures(features?: readonly string[] | null): string[] {
  const set = new Set(features ?? []);
  for (const f of set) if (!(f in FEATURE_SLOTS)) throw new Error(`unknown board feature ${f}`);
  return FEATURE_ORDER.filter((f) => set.has(f));
}

/** Row width for `features` (68 without any). */
export function nSlots(features?: readonly string[] | null): number {
  return N_SLOTS + normalizeFeatures(features).reduce((a, f) => a + FEATURE_SLOTS[f], 0);
}

function bucket(v: number, bounds: number[]): number {
  for (let i = 0; i < bounds.length; i++) if (v <= bounds[i]) return i;
  return bounds.length;
}

const FILES = 'abcdefgh';
const sqName = (sq: number) => `${FILES[sq % 8]}${Math.floor(sq / 8) + 1}`;

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

/** The FEN of every `fen` part of a dialogue's turns in encoding order (think parts included): boards.dialogue_snapshot_fens. */
export function dialogueSnapshotFens(turns: { parts: { kind: string; fen?: string; parts?: unknown[] }[] }[]): string[] {
  const out: string[] = [];
  const walk = (parts: { kind: string; fen?: string; parts?: unknown[] }[]) => {
    for (const p of parts) {
      if (p.kind === 'fen' && p.fen) out.push(p.fen);
      else if (p.kind === 'think' && p.parts) walk(p.parts as { kind: string; fen?: string; parts?: unknown[] }[]);
    }
  };
  for (const t of turns) walk(t.parts);
  return out;
}

/** Row for a FEN (en-passant square taken verbatim from the FEN, as python-chess does). */
export function encodeFen(fen: string): BoardRow {
  const ep = fen.split(' ')[3];
  return encodeBoardState(new Chess(fen), ep && ep !== '-' ? ep.charCodeAt(0) - 97 : null);
}

/** The position before a push: FEN + en-passant file (pop), its repetition key, whether the move was irreversible. */
interface PrevEntry {
  fen: string;
  ep: number | null;
  key: string;
  irreversible: boolean;
  from: number;
  to: number;
}

/** A board that follows UCI moves and knows its en-passant file. */
export class TrackedBoard {
  readonly chess: Chess;
  ep: number | null = null;
  /** The position before each push, for pop() and repetition counts; copies keep it (copy(false) does not). */
  private prev: PrevEntry[] = [];
  constructor(fen?: string, skipValidation = false) {
    this.chess = new Chess(fen, { skipValidation });
    const ep = fen?.split(' ')[3];
    this.ep = ep && ep !== '-' ? ep.charCodeAt(0) - 97 : null;
  }
  /** python-chess's transposition key: placement, side, castling, and the en-passant square only if a legal capture. */
  private key(moves?: { flags: string }[]): string {
    const [placement, side, castling, ep] = this.chess.fen().split(' ');
    const legalEp = (moves ?? this.chess.moves({ verbose: true })).some((m) => m.flags.includes('e'));
    return `${placement} ${side} ${castling} ${legalEp ? ep : '-'}`;
  }
  /** Play `uci` if legal (exact UCI match, promotions included); false otherwise. */
  push(uci: string): boolean {
    const moves = this.chess.moves({ verbose: true });
    const mv = moves.find((m) => m.lan === uci);
    if (!mv) return false;
    const castling = this.chess.fen().split(' ')[2];
    const legalEp = moves.some((m) => m.flags.includes('e'));
    const fen = this.chess.fen();
    const entry: PrevEntry = { fen, ep: this.ep, key: this.key(moves), irreversible: false, from: sqIndex(mv.from), to: sqIndex(mv.to) };
    this.chess.move(mv);
    // python-chess is_irreversible: a zeroing move, a castling-rights loss, or a legal en passant before the move
    entry.irreversible = mv.piece === 'p' || !!mv.captured || this.chess.fen().split(' ')[2] !== castling || legalEp;
    this.prev.push(entry);
    this.ep = mv.flags.includes('b') ? mv.from.charCodeAt(0) - 97 : null;
    return true;
  }
  row(): BoardRow {
    return encodeBoardState(this.chess, this.ep);
  }
  /** Earlier occurrences of this position (python-chess is_repetition: back to the last irreversible move), max 2. */
  repetitions(): number {
    if (!this.prev.length) return 0;
    const key = this.key();
    let n = 0;
    for (let i = this.prev.length - 1; i >= 0 && n < 2; i--) {
      if (this.prev[i].irreversible) break;
      if (this.prev[i].key === key) n++;
    }
    return n;
  }
  /** The last move (from, to square indices), null without one. */
  lastMove(): { from: number; to: number } | null {
    const p = this.prev[this.prev.length - 1];
    return p ? { from: p.from, to: p.to } : null;
  }
  hasHistory(): boolean {
    return this.prev.length > 0;
  }
  /** Take back the last push (false when there is none). */
  pop(): boolean {
    const p = this.prev.pop();
    if (!p) return false;
    this.chess.load(p.fen, { skipValidation: true });
    this.ep = p.ep;
    return true;
  }
  /** `keepHistory = false`: python-chess `copy(stack=False)` (no pops, repetitions or last move before it). */
  copy(keepHistory = true): TrackedBoard {
    const b = new TrackedBoard(this.chess.fen(), true);
    b.ep = this.ep;
    b.prev = keepHistory ? [...this.prev] : [];
    return b;
  }
}

function sqIndex(sq: string): number {
  return (Number(sq[1]) - 1) * 8 + (sq.charCodeAt(0) - 97);
}

/** Per square: White / Black attacker counts and the value of the cheapest White / Black attacker (99 = none). */
function attackMaps(c: Chess): { count: [number[], number[]]; cheapest: [number[], number[]] } {
  const count: [number[], number[]] = [new Array(64).fill(0), new Array(64).fill(0)];
  const cheapest: [number[], number[]] = [new Array(64).fill(99), new Array(64).fill(99)];
  for (let sq = 0; sq < 64; sq++) {
    (['w', 'b'] as const).forEach((color, ci) => {
      const att = c.attackers(sqName(sq) as never, color);
      count[ci][sq] = att.length;
      for (const a of att) cheapest[ci][sq] = Math.min(cheapest[ci][sq], VALUE[c.get(a)!.type]);
    });
  }
  return { count, cheapest };
}

/** python-chess board.is_pinned: the own piece on `sq` shields its king from an enemy slider on the same line. */
function isPinned(c: Chess, sq: number, color: 'w' | 'b'): boolean {
  let king = -1;
  for (let s = 0; s < 64; s++) {
    const p = c.get(sqName(s) as never);
    if (p && p.type === 'k' && p.color === color) king = s;
  }
  if (king < 0) return false;
  const df = Math.sign((sq % 8) - (king % 8));
  const dr = Math.sign(Math.floor(sq / 8) - Math.floor(king / 8));
  const fileDist = Math.abs((sq % 8) - (king % 8));
  const rankDist = Math.abs(Math.floor(sq / 8) - Math.floor(king / 8));
  if (!(fileDist === 0 || rankDist === 0 || fileDist === rankDist) || sq === king) return false;
  const diagonal = df !== 0 && dr !== 0;
  let f = (king % 8) + df;
  let r = Math.floor(king / 8) + dr;
  let passed = false;
  while (f >= 0 && f < 8 && r >= 0 && r < 8) {
    const s = r * 8 + f;
    const p = c.get(sqName(s) as never);
    if (p) {
      if (!passed) {
        if (s !== sq) return false;
        passed = true;
      } else {
        return p.color !== color && (p.type === 'q' || p.type === (diagonal ? 'b' : 'r'));
      }
    }
    f += df;
    r += dr;
  }
  return false;
}

/** The extra slots of a row for (normalised) `features` (boards.feature_planes). */
export function featurePlanes(
  tb: TrackedBoard,
  features: string[],
  kind: number,
  counters: boolean,
  repetition: number | null,
): number[] {
  const c = tb.chess;
  const out: number[] = [];
  const fen = c.fen().split(' ');
  let maps: ReturnType<typeof attackMaps> | null = null;
  const pieces: { sq: number; type: string; color: 'w' | 'b' }[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = c.get(sqName(sq) as never);
    if (p) pieces.push({ sq, type: p.type, color: p.color });
  }
  for (const f of features) {
    if (f === 'state') {
      out.push(
        counters ? bucket(Number(fen[4]), HALFMOVE_BUCKETS) : ABSENT,
        counters ? bucket(Number(fen[5]), FULLMOVE_BUCKETS) : ABSENT,
        repetition === null ? ABSENT : Math.min(repetition, 2),
        c.inCheck() ? 1 : 0,
        kind,
      );
    } else if (f === 'material') {
      for (const color of ['w', 'b'] as const)
        for (const t of ['p', 'n', 'b', 'r', 'q']) out.push(Math.min(15, pieces.filter((p) => p.color === color && p.type === t).length));
    } else if (f === 'pawns') {
      for (const color of ['w', 'b'] as const) {
        const own = pieces.filter((p) => p.type === 'p' && p.color === color);
        const opp = pieces.filter((p) => p.type === 'p' && p.color !== color);
        const files = new Array(8).fill(0);
        for (const p of own) files[p.sq % 8]++;
        for (let fl = 0; fl < 8; fl++) {
          if (!files[fl]) {
            out.push(0);
            continue;
          }
          const iso = (fl === 0 || !files[fl - 1]) && (fl === 7 || !files[fl + 1]);
          const passed = own.some(
            (p) =>
              p.sq % 8 === fl &&
              !opp.some((o) => Math.abs((o.sq % 8) - fl) <= 1 && (color === 'w' ? o.sq >> 3 > p.sq >> 3 : o.sq >> 3 < p.sq >> 3)),
          );
          out.push(Math.min(files[fl], 3) + 4 * (iso ? 1 : 0) + 8 * (passed ? 1 : 0));
        }
      }
    } else if (f === 'attacks') {
      maps ??= attackMaps(c);
      for (let sq = 0; sq < 64; sq++) out.push(4 * Math.min(maps.count[0][sq], 3) + Math.min(maps.count[1][sq], 3));
    } else if (f === 'flags') {
      maps ??= attackMaps(c);
      const row = new Array(64).fill(0);
      const last = tb.lastMove();
      if (last) {
        row[last.from] |= 1;
        row[last.to] |= 2;
      }
      for (const p of pieces) {
        if (p.type === 'k') continue;
        if (isPinned(c, p.sq, p.color)) row[p.sq] |= 4;
        const [own, opp] = p.color === 'w' ? [0, 1] : [1, 0];
        if (maps.count[opp][p.sq] && (!maps.count[own][p.sq] || maps.cheapest[opp][p.sq] < VALUE[p.type])) row[p.sq] |= 8;
      }
      out.push(...row);
    }
  }
  return out;
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
  private current: BoardRow;
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
  /** v6: text sees the position under discussion ("pod"); feature planes after slot 67. */
  private readonly pod: boolean;
  private readonly features: string[];
  readonly absent: BoardRow;
  /** pod: the <|user|> / <|assistant|> turn we are in, and the position under discussion. */
  private role: number | null = null;
  private podRow: BoardRow | null = null;
  /** The pod before <|think|> (with the snapshot in thinkSaved). */
  private thinkPod: BoardRow | null = null;
  /** The current board descends from a snapshot: no history (repetitions before it). */
  private blind = false;
  /** Its halfmove clock / move number are real (a snapshot without its FEN: unknown). */
  private clocks = true;
  /** v6: the full FENs of the snapshots in order (boards.dialogue_snapshot_fens); ignored by legacy rows. */
  private readonly fens: (string | null)[];
  private nSnapshots = 0;
  constructor(
    tok: ChessTokenizer,
    startFen?: string,
    opts: { sync?: BoardSync; features?: readonly string[]; snapshotFens?: (string | null)[] } = {},
  ) {
    this.tok = tok;
    this.startFen = startFen ?? null;
    this.pod = (opts.sync ?? 'legacy') === 'pod';
    this.features = normalizeFeatures(opts.features);
    this.absent = this.features.length ? new Array(nSlots(this.features)).fill(ABSENT) : ABSENT_ROW;
    this.current = this.absent;
    this.fens = this.pod || this.features.length ? [...(opts.snapshotFens ?? [])] : [];
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
  private enc(b: TrackedBoard, kind: number): BoardRow {
    const row = b.row();
    if (!this.features.length) return row;
    const rep = !this.blind || b.hasHistory() ? b.repetitions() : null;
    return row.concat(featurePlanes(b, this.features, kind, this.clocks, rep));
  }
  private lineKind(): number {
    return this.inGame && this.gameBoard === null ? KIND_GAME : KIND_LINE;
  }
  private outside(): BoardRow {
    return this.pod && this.podRow ? this.podRow : this.absent;
  }
  private feedOne(id: number): BoardRow {
    const tok = this.tok;
    if (this.fenTokens !== null) {
      this.fenTokens.push(id);
      if (this.fenTokens.length === 65) {
        this.snapshot = boardFromSnapshot(tok, this.fenTokens);
        this.fenTokens = null;
        const fen = this.fens[this.nSnapshots] ?? null;
        this.nSnapshots++;
        this.clocks = false;
        if (this.snapshot && fen) {
          try {
            const full = new TrackedBoard(fen);
            const key = (f: string) => f.split(' ').slice(0, 2).join(' ');
            if (key(full.chess.fen()) === key(this.snapshot.chess.fen())) {
              this.snapshot = full;
              this.clocks = true;
            }
          } catch {
            // a malformed FEN: the snapshot keeps unknown clocks
          }
        }
        if (this.snapshot) {
          this.blind = true;
          this.current = this.enc(this.snapshot, KIND_DISCUSSED);
          if (this.pod) this.podRow = this.current;
        }
      }
      return this.current;
    }
    if (this.branch !== null && id === this.branch) {
      if (this.inLine()) {
        this.frames.push({ board: this.board!, segMoves: this.segMoves });
        this.board = this.board!.copy();
        if (this.segMoves > 0) this.board.pop();
        this.segMoves = 0;
        this.current = this.enc(this.board, KIND_LINE);
      }
      return this.current;
    }
    if (this.endBranch !== null && id === this.endBranch) {
      if (this.inLine() && this.frames.length) {
        const f = this.frames.pop()!;
        this.board = f.board;
        this.segMoves = f.segMoves;
        this.current = this.enc(this.board, KIND_LINE);
      }
      return this.current;
    }
    if (id === tok.fenId) {
      this.fenTokens = [];
      this.board = null;
      this.current = this.absent;
      return this.current;
    }
    if (id === tok.bosId || id === tok.eosId || id === tok.id('<|pad|>')) {
      this.snapshot = null; // a new sequence / dialogue
      this.thinkSaved = null;
      this.podRow = null;
      this.role = null;
    }
    if (id === tok.thinkId && !this.inGame) {
      this.thinkSaved = { snapshot: this.snapshot };
      this.thinkPod = this.podRow;
    } else if (this.endThink !== null && id === this.endThink) {
      if (this.inGame && this.board) {
        // think-then-move: back to the game position (a line left open closes with the think), so the move after
        // <|end_think|> is played on the game board
        if (this.gameBoard) {
          this.board = this.gameBoard;
          this.gameBoard = null;
        }
        this.frames = [];
        this.current = this.enc(this.board, KIND_GAME);
        return this.current;
      }
      if (this.thinkSaved) {
        this.snapshot = this.thinkSaved.snapshot;
        this.podRow = this.thinkPod;
        this.thinkSaved = null;
      }
      this.board = null;
      this.current = this.outside();
      return this.current;
    }
    if (id === tok.lineId && this.inGame && this.board) {
      this.gameBoard = this.board; // calculation inside a game: the line starts from the game position
      this.board = this.gameBoard.copy(false);
      this.current = this.enc(this.board, KIND_LINE);
    } else if (id === tok.endLineId && this.gameBoard) {
      this.board = this.gameBoard; // back to the game after the calculated line
      this.gameBoard = null;
      this.current = this.enc(this.board, KIND_GAME);
    } else if (this.starts.has(id)) {
      if (this.startFen !== null && id === tok.gameId) {
        this.board = new TrackedBoard(this.startFen);
        this.startFen = null; // only the first game of the sequence
        this.blind = false;
        this.clocks = true;
      } else if (id === tok.lineId && this.snapshot) {
        this.board = this.snapshot.copy(false);
        this.blind = true;
      } else {
        this.board = new TrackedBoard();
        this.blind = false;
        this.clocks = true;
      }
      this.inGame = id === tok.gameId;
      this.current = this.enc(this.board, this.inGame ? KIND_GAME : KIND_LINE);
    } else if (this.ends.has(id)) {
      if (this.pod && id === tok.endLineId && this.board && this.role !== tok.assistantId)
        this.podRow = this.enc(this.board, KIND_DISCUSSED); // a user / document line: discussed from its end
      if (this.pod && (id === tok.userId || id === tok.assistantId)) this.role = id;
      this.board = null;
      this.inGame = false;
      this.gameBoard = null;
      this.current = this.outside();
    } else if (this.board && tok.isMoveId(id)) {
      if (this.board.push(tok.idToMove(id))) {
        this.segMoves++;
        this.current = this.enc(this.board, this.lineKind());
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
  opts?: { sync?: BoardSync; features?: readonly string[] },
): { ids: number[]; rows: BoardRow[] } {
  const start = k === null ? 0 : Math.max(0, moves.length - k);
  const board = new TrackedBoard();
  for (let i = 0; i < start; i++) if (!board.push(moves[i])) throw new Error(`illegal move ${moves[i]}`);
  if (opts?.features?.length || (opts?.sync ?? 'legacy') !== 'legacy') {
    // v6 rows: exactly the training tracker's (a cropped instance starts from the crop FEN, without history)
    const ids = perspective ? [tok.bosId, tok.gameId, tok.perspectiveId(perspective)] : [tok.gameId];
    for (let i = start; i < moves.length; i++) ids.push(tok.moveToId(moves[i]));
    let startFen: string | undefined;
    if (start > 0) {
      const f = board.chess.fen().split(' ');
      f[3] = board.ep === null ? '-' : `${FILES[board.ep]}${board.chess.turn() === 'w' ? 6 : 3}`;
      startFen = f.join(' ');
    }
    return { ids, rows: new BoardTracker(tok, startFen, opts).rows(ids) };
  }
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
