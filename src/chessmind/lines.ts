/*
 * Move lines with branches and end markers: port of ChessMind's chessmind/model/lines.py (tokenizer format 5, the
 * named format-4 extras). Inside `<|line|> ... <|end_line|>`:
 *   - `<|branch|> ... <|end_branch|>` is a variation from the position BEFORE the last move of the enclosing line (or
 *     branch), replacing that move, like a PGN parenthesised variation; branches nest, and <|end_branch|> returns to the
 *     enclosing line's position;
 *   - right after a move (before branches replacing it): <|check|> when it gives check, <|mate|> when it mates;
 *   - after a segment's final move (after its <|check|>, before its branches) the segment's end marker when that
 *     position is finished: <|draw|> (stalemate, insufficient material, fifty-move rule) or <|repetition|> (the
 *     position already occurred on the segment's path: the line's start and every position after each move, a
 *     branch's path going through its enclosing line).
 * Markers are computed from the moves (encodeLineTokens) and forced in generation (LineWalker). Positions compare by
 * FEN placement / side / castling / en passant (chess.js prints the square only when a capture is legal, like
 * python-chess `fen(en_passant="legal")`). Checked against Python by scripts/test-chessmind.mjs.
 */
import { Chess } from 'chess.js';
import type { Arrow, ChatLeafPart, ChatLinePart, LineBranch, LineMark, Square } from '../types';
import type { ChessTokenizer } from './tokenizer';

export const MAX_BRANCH_DEPTH = 3;
export const MARKER_TOKENS: Record<LineMark, string> = { mate: '<|mate|>', draw: '<|draw|>', repetition: '<|repetition|>' };
export const CHECK_TOKEN = '<|check|>';
/** How the UI labels a line's end marker. */
export const MARK_LABEL: Record<LineMark, string> = { mate: 'mate', draw: 'draw', repetition: 'draw by repetition' };
/** Markers shown as a label after a line; check and mate show as "+" / "#" in the SAN instead. */
export const LABELLED_MARKS: LineMark[] = ['draw', 'repetition'];

/** A line or a branch: moves plus nested branches. */
export type LineSegment = Pick<ChatLinePart, 'moves' | 'branches' | 'end'>;

/** Repetition identity: placement, side, castling, en-passant square (when a capture is legal). */
export function positionKey(c: Chess): string {
  return c.fen().split(' ').slice(0, 4).join(' ');
}

/** The marker a segment ending in `c` gets (lines.line_end). */
export function lineEndOf(c: Chess, repeated: boolean): LineMark | null {
  if (c.isCheckmate()) return 'mate';
  if (c.isStalemate() || c.isInsufficientMaterial() || c.isDrawByFiftyMoves()) return 'draw';
  return repeated ? 'repetition' : null;
}

function play(c: Chess, uci: string): boolean {
  try {
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Token strings inside a line (moves, <|branch|> / <|end_branch|>, markers), lines.walk in Python. Throws on an
 * illegal move or a branch without a move to replace. `markers` false: no end markers (older tokenizers).
 */
export function encodeLineTokens(line: LineSegment, startFen?: string, markers = true, checks = markers): string[] {
  const board = new Chess(startFen);
  const out: string[] = [];
  walkSegment(line, board, [positionKey(board)], out, markers, checks);
  return out;
}

/** Markers after a move that reached `c` (`keys` ends with its key): mate, or check and (final move) draw / repetition. */
function moveMarks(c: Chess, keys: string[], last: boolean, checks: boolean): string[] {
  if (c.isCheckmate()) return [MARKER_TOKENS.mate];
  const out = checks && c.inCheck() ? [CHECK_TOKEN] : [];
  if (last) {
    const end = lineEndOf(c, keys.slice(0, -1).includes(keys[keys.length - 1]));
    if (end) out.push(MARKER_TOKENS[end]);
  }
  return out;
}

function walkSegment(seg: LineSegment, board: Chess, keys: string[], out: string[], markers: boolean, checks: boolean) {
  const byAt = new Map<number, LineBranch[]>();
  for (const b of seg.branches ?? []) {
    if (b.at < 0 || b.at >= seg.moves.length) throw new Error(`branch at move ${b.at} of a ${seg.moves.length}-move line`);
    byAt.set(b.at, [...(byAt.get(b.at) ?? []), b]);
  }
  seg.moves.forEach((uci, i) => {
    const before = board.fen();
    const beforeKeys = [...keys];
    if (!play(board, uci)) throw new Error(`illegal move ${uci} in ${before}`);
    keys.push(positionKey(board));
    out.push(uci);
    if (markers) out.push(...moveMarks(board, keys, i === seg.moves.length - 1, checks));
    for (const b of byAt.get(i) ?? []) {
      out.push('<|branch|>');
      walkSegment(b, new Chess(before), beforeKeys, out, markers, checks);
      out.push('<|end_branch|>');
    }
  });
}

/** Branches at every depth. */
export function countBranches(seg: LineSegment): number {
  return (seg.branches ?? []).reduce((n, b) => n + 1 + countBranches(b), 0);
}

export interface WalkerOptions {
  maxDepth?: number;
  maxBranches?: number;
  maxBranchPlies?: number;
}

interface Frame {
  board: Chess;
  keys: string[];
  fens: string[];
  segMoves: number;
  ended: boolean;
}

/**
 * Port of lines.LineWalker: the tokens allowed next inside a line being generated. Legal moves always; <|branch|>
 * after a move of the current segment (depth < maxDepth, fewer than maxBranches opened in this line); <|end_branch|>
 * in a branch once it has a move (forced after maxBranchPlies); <|end_line|> outside branches. After a move its
 * markers are forced in order: <|mate|>, or <|check|> then, at a finished position, <|draw|> / <|repetition|> (the
 * repetition guard); a segment with an end marker or mate takes only its end or a <|branch|> replacing its last
 * move. Tokenizers without the named extras get the old mask: legal moves + <|end_line|>.
 */
export class LineWalker {
  board: Chess;
  private keys: string[];
  /** FENs before each move on the current path (a branch restarts from the last one). */
  private fens: string[] = [];
  segMoves = 0;
  /** Main-line moves (outside branches). */
  plies = 0;
  private ended = false;
  private readonly frames: Frame[] = [];
  private nBranches = 0;
  private readonly t: ChessTokenizer;
  private readonly branchesOn: boolean;
  private readonly maxDepth: number;
  private readonly maxBranches: number;
  private readonly maxBranchPlies: number;
  private readonly markerIds: Partial<Record<LineMark, number>>;
  private readonly markerOf = new Map<number, LineMark>();
  private readonly checkId: number | null;
  /** Markers the last move calls for, forced in order. */
  private pending: number[] = [];
  constructor(t: ChessTokenizer, startFen?: string, o: WalkerOptions = {}) {
    this.t = t;
    this.board = new Chess(startFen);
    this.keys = [positionKey(this.board)];
    this.branchesOn = t.supportsBranches;
    this.maxDepth = this.branchesOn ? (o.maxDepth ?? MAX_BRANCH_DEPTH) : 0;
    this.maxBranches = o.maxBranches ?? 4;
    this.maxBranchPlies = o.maxBranchPlies ?? 12;
    this.markerIds = this.branchesOn ? t.markerIds : {};
    for (const [name, id] of Object.entries(this.markerIds)) this.markerOf.set(id, name as LineMark);
    this.checkId = this.branchesOn ? t.checkId : null;
  }
  private marksAfterMove(): number[] {
    if (!this.markerOf.size) return [];
    if (this.board.isCheckmate()) return [this.markerIds.mate!];
    const out = this.checkId !== null && this.board.inCheck() ? [this.checkId] : [];
    const end = lineEndOf(this.board, this.keys.slice(0, -1).includes(this.keys[this.keys.length - 1]));
    if (end) out.push(this.markerIds[end]!);
    return out;
  }
  get depth(): number {
    return this.frames.length;
  }
  get inBranch(): boolean {
    return this.frames.length > 0;
  }
  /** The token that closes the current segment. */
  endId(): number {
    return this.frames.length ? this.t.endBranchId! : this.t.endLineId;
  }
  /** Marker the current position calls for (null before the segment's first move, after its marker, without markers). */
  finished(): LineMark | null {
    if (!this.markerOf.size || this.segMoves === 0 || this.ended) return null;
    const last = this.keys[this.keys.length - 1];
    return lineEndOf(this.board, this.keys.slice(0, -1).includes(last));
  }
  feed(id: number) {
    const t = this.t;
    if (t.isMoveId(id)) {
      const fen = this.board.fen();
      if (!play(this.board, t.idToMove(id))) return;
      this.fens.push(fen);
      this.keys.push(positionKey(this.board));
      this.segMoves++;
      if (!this.frames.length) this.plies++;
      this.pending = this.marksAfterMove();
    } else if (this.pending.length && id === this.pending[0]) {
      this.pending.shift();
      if (this.markerOf.has(id)) this.ended = true; // mate / draw / repetition end the segment
    } else if (this.branchesOn && id === t.branchId) {
      this.pending = [];
      this.frames.push({ board: this.board, keys: this.keys, fens: this.fens, segMoves: this.segMoves, ended: this.ended });
      this.keys = [...this.keys];
      this.fens = [...this.fens];
      if (this.segMoves > 0) {
        this.board = new Chess(this.fens.pop());
        this.keys.pop();
      } else this.board = new Chess(this.board.fen());
      this.segMoves = 0;
      this.ended = false;
      this.nBranches++;
    } else if (this.branchesOn && id === t.endBranchId && this.frames.length) {
      const f = this.frames.pop()!;
      this.board = f.board;
      this.keys = f.keys;
      this.fens = f.fens;
      this.segMoves = f.segMoves;
      this.ended = f.ended;
      this.pending = [];
    } else if (this.markerOf.has(id)) this.ended = true;
  }
  /** Ids allowed next; `close`: the caller wants the line closed (budget spent), only the end token. */
  allowed(close = false): number[] {
    const end = this.endId();
    if (this.pending.length) return [this.pending[0]]; // <|check|> / <|mate|> / an end marker right after the move
    const canBranch = this.segMoves > 0 && this.frames.length < this.maxDepth && this.nBranches < this.maxBranches;
    if (this.ended) return canBranch && !close ? [end, this.t.branchId!] : [end]; // close, or branch off the last move
    if (close) return [end];
    if (this.frames.length && this.segMoves >= this.maxBranchPlies) return [end];
    const ids = this.board.moves({ verbose: true }).map((m) => this.t.moveToId(m.lan));
    if (!this.frames.length || this.segMoves > 0) ids.push(end);
    if (canBranch) ids.push(this.t.branchId!);
    return ids;
  }
}

/** One move of a flattened line for display: SAN with its move number, the depth and where it sits. */
export interface LineChip {
  /** "12." / "12…" when due (the first move of a segment, or after a branch closes), else "". */
  num: string;
  san: string;
  uci: string;
  depth: number;
  /** Path of move indices from the line start: [i] on the main line, [i, b, j] = move j of branch b at move i, ... */
  path: number[];
}

/** A segment's rows for display: its moves as chips, each branch rendered right after the move it replaces. */
export interface DisplaySegment {
  depth: number;
  chips: LineChip[];
  end?: LineMark;
  /** Sub-segments after each chip index (the branches replacing that move). */
  branches: Map<number, DisplaySegment[]>;
}

/** Display tree of a line from `fen` (undefined = initial position); illegal moves stop a segment. */
export function displayLine(line: LineSegment, fen?: string): DisplaySegment {
  return displaySegment(line, fen, 0, []);
}

function displaySegment(seg: LineSegment, fen: string | undefined, depth: number, path: number[]): DisplaySegment {
  const c = new Chess(fen);
  const out: DisplaySegment = { depth, chips: [], end: seg.end, branches: new Map() };
  const byAt = new Map<number, LineBranch[]>();
  (seg.branches ?? []).forEach((b) => byAt.set(b.at, [...(byAt.get(b.at) ?? []), b]));
  let needNumber = true;
  for (let i = 0; i < seg.moves.length; i++) {
    const before = c.fen();
    const no = c.moveNumber();
    const white = c.turn() === 'w';
    let san: string;
    try {
      san = c.move({ from: seg.moves[i].slice(0, 2), to: seg.moves[i].slice(2, 4), promotion: seg.moves[i][4] }).san;
    } catch {
      break;
    }
    out.chips.push({ num: white ? `${no}.` : needNumber ? `${no}…` : '', san, uci: seg.moves[i], depth, path: [...path, i] });
    needNumber = false;
    const subs = byAt.get(i);
    if (subs?.length) {
      out.branches.set(
        i,
        subs.map((b, k) => displaySegment(b, before, depth + 1, [...path, i, k])),
      );
      needNumber = true;
    }
  }
  return out;
}

/** The moves (UCI) from the line start to the move at `path` (see LineChip.path). */
export function movesToPath(line: LineSegment, path: number[]): string[] {
  const out: string[] = [];
  let seg: LineSegment = line;
  for (let k = 0; k < path.length; k += 2) {
    const i = path[k];
    if (k + 1 >= path.length) {
      out.push(...seg.moves.slice(0, i + 1));
      break;
    }
    out.push(...seg.moves.slice(0, i)); // the branch replaces move i
    const subs = (seg.branches ?? []).filter((b) => b.at === i);
    seg = subs[path[k + 1]];
    if (!seg) break;
  }
  return out;
}

/** Every variation of a line as a full move list from the line start: the main line first, then each branch
 * (its enclosing moves up to the replaced one, then the branch), depth first, in token order. */
export function lineVariations(line: LineSegment): { path: number[]; moves: string[] }[] {
  const out: { path: number[]; moves: string[] }[] = [];
  const visit = (seg: LineSegment, prefix: string[], path: number[]) => {
    out.push({ path, moves: [...prefix, ...seg.moves] });
    const counts = new Map<number, number>();
    for (const b of seg.branches ?? []) {
      const k = counts.get(b.at) ?? 0;
      counts.set(b.at, k + 1);
      visit(b, [...prefix, ...seg.moves.slice(0, b.at)], [...path, b.at, k]);
    }
  };
  visit(line, [], []);
  return out;
}

/**
 * Board arrows for a think's currently predicted line: the LAST `{kind:'line'}` part in `parts` (its live, still-
 * growing moves while the think streams), main line only (branches are display-only text, never drawn). Starts from
 * `startFen` (the position under thought), unless a `{kind:'fen'}` snapshot appears in `parts` before that line,
 * which repositions it (mirrors ThinkingBlock's lineFens walk, so the arrows agree with the think's own text).
 * Opacity fades by ply index (first move most opaque), not by probability. Stops at the first illegal move (a
 * partial line still mid-stream, its last move not yet fully decoded).
 */
export function thinkLineArrows(parts: ChatLeafPart[], startFen?: string): Arrow[] {
  let fen = startFen;
  let lineFen = startFen;
  let moves: string[] | null = null;
  for (const p of parts) {
    if (p.kind === 'fen') fen = p.fen;
    else if (p.kind === 'line' && p.moves.length) {
      moves = p.moves;
      lineFen = fen;
    }
  }
  if (!moves) return [];
  let board: Chess;
  try {
    board = new Chess(lineFen);
  } catch {
    return [];
  }
  const arrows: Arrow[] = [];
  for (let i = 0; i < moves.length; i++) {
    const uci = moves[i];
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    if (!play(board, uci)) break;
    arrows.push({ from, to, color: 'chessmind', opacity: Math.max(0.15, Math.round(0.85 * 0.72 ** i * 100) / 100) });
  }
  return arrows;
}

/** PGN-style text of a line: "1.e4 e5 (1...c5 2.Nf3) 2.Nf3", end markers in brackets ("[draw by repetition]"). */
export function lineText(line: LineSegment, fen?: string): string {
  const seg = (d: DisplaySegment): string => {
    const words: string[] = [];
    d.chips.forEach((c, k) => {
      words.push(`${c.num.replace('…', '...')}${c.san}`);
      for (const b of d.branches.get(k) ?? []) words.push(`(${seg(b)})`);
    });
    if (d.end && LABELLED_MARKS.includes(d.end)) words.push(`[${MARK_LABEL[d.end]}]`);
    return words.join(' ');
  };
  return seg(displayLine(line, fen));
}
