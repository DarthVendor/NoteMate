/*
 * Where a generated move line stops (twin of the line rules in ChessMind's generate.LineConstraint / generate()).
 * The board embedding has no repetition count or halfmove clock, and greedy decoding rarely picks <|end_line|> over
 * the best move, so without these rules lines run until the token budget (long shuffles in drawn positions):
 *   - a finished position ends the line: checkmate, stalemate, insufficient material, the fifty-move rule, or the
 *     first repeated position within the line (a 2-fold repeat inside a line is a perpetual or a shuffle);
 *   - a hard maximum length (training lines: think <= 16 plies, p90 14; answer lines <= 7 in the engine templates);
 *   - P(<|end_line|>) >= a threshold (renormalised over what the line allows: the legal moves + <|end_line|>) ends it.
 */
import { Chess } from 'chess.js';

export type LineEnd = 'checkmate' | 'stalemate' | 'insufficient' | 'fifty-move' | 'repetition';

/** How the UI marks a line that ended in a finished position (checkmate already shows as # in the SAN). */
export const LINE_END_LABEL: Record<LineEnd, string> = {
  checkmate: 'checkmate',
  stalemate: 'stalemate',
  insufficient: 'draw: insufficient material',
  'fifty-move': 'draw: fifty-move rule',
  repetition: 'draw by repetition',
};

export interface LineRules {
  /** End a line once P(<|end_line|>) among the allowed tokens reaches this (1 = only when it is the choice). */
  endP: { think: number; answer: number };
  /** Most plies in one line. */
  maxPlies: { think: number; answer: number };
  /** Stop at checkmate / stalemate / draws / the first repeated position. */
  stopFinished: boolean;
}

/** Chosen from P(<|end_line|>) on teacher-forced training dialogues (v5-250m-s20k): answer lines at 0.2 catch 85% of
 * true ends at 7% early stops per mid-line ply; think-line lengths are random in the data (2-16) so their P(end) is
 * uninformative and the think relies mostly on the length cap (0.5 = stop only when the model is fairly sure). */
export const DEFAULT_LINE_RULES: LineRules = { endP: { think: 0.5, answer: 0.2 }, maxPlies: { think: 16, answer: 12 }, stopFinished: true };

/** Position key for repetition: placement, side, castling, en-passant (FEN fields 1-4). */
const key = (c: Chess) => c.fen().split(' ').slice(0, 4).join(' ');

/** Follows a line from its start and reports when it reached a finished position. */
export class LineWatch {
  readonly board: Chess;
  plies = 0;
  private readonly seen = new Set<string>();
  private repeated = false;
  constructor(fen?: string) {
    this.board = new Chess(fen);
    this.seen.add(key(this.board));
  }
  /** Play a UCI move (false when illegal: the line is left as it was). */
  push(uci: string): boolean {
    try {
      this.board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      return false;
    }
    this.plies++;
    const k = key(this.board);
    if (this.seen.has(k)) this.repeated = true;
    this.seen.add(k);
    return true;
  }
  ended(): LineEnd | null {
    const b = this.board;
    if (b.isCheckmate()) return 'checkmate';
    if (b.isStalemate()) return 'stalemate';
    if (b.isInsufficientMaterial()) return 'insufficient';
    if (b.isDrawByFiftyMoves()) return 'fifty-move';
    if (this.repeated) return 'repetition';
    return null;
  }
}

/** How a finished line ended, from `fen` (undefined = the initial position); null for an open line. */
export function lineEnding(fen: string | undefined, moves: string[]): LineEnd | null {
  let w: LineWatch;
  try {
    w = new LineWatch(fen);
  } catch {
    return null;
  }
  for (const m of moves) if (!w.push(m)) return null;
  return w.ended();
}

/** P(`target`) after a softmax over `allowed` ids of `logits` (temperature 1). */
export function probAmong(logits: ArrayLike<number>, allowed: number[], target: number): number {
  let max = -Infinity;
  for (const i of allowed) if (logits[i] > max) max = logits[i];
  let z = 0;
  for (const i of allowed) z += Math.exp(logits[i] - max);
  return allowed.includes(target) ? Math.exp(logits[target] - max) / z : 0;
}
