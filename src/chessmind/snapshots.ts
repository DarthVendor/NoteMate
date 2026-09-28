/*
 * Board snapshots an answer may show (twin of ChessMind's chessmind.model.generate: dialogue_position,
 * rewind_candidates, SnapshotPicker). After <|fen|> the side token + 64 piece tokens walk a trie of the candidate
 * boards: a token is allowed when some remaining candidate has it, and once one is left the rest is forced. The
 * candidates are the position under discussion, the one before its last move, the initial position and every
 * position along the user's game, so an answer about an opening asked mid-game can rewind to where it starts.
 */
import { Chess } from 'chess.js';
import type { ChessTokenizer, DialogueTurn } from './tokenizer';

/** The most boards a snapshot may choose between (MAX_SNAPSHOT_CANDIDATES in generate.py). */
export const MAX_SNAPSHOT_CANDIDATES = 160;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** What a snapshot encodes: the placement and the side to move. */
export function snapshotKey(fen: string): string {
  const [placement, side] = fen.split(' ');
  return `${placement} ${side === 'b' ? 'b' : 'w'}`;
}

function play(b: Chess, move: string): void {
  b.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
}

/**
 * Port of generate.dialogue_position: `start` = the last snapshot of the dialogue (lines start there) and
 * `positions` = what the last user turn talks about: the end of its last line and the position before that line's
 * last move (a question about the move just played), else the snapshot. FENs.
 */
export function dialoguePosition(turns: DialogueTurn[]): { start?: string; positions: string[] } {
  let start: string | undefined;
  let positions: string[] = [];
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'fen') {
        start = part.fen;
        positions = [new Chess(part.fen).fen()];
      } else if (part.kind === 'line') {
        const b = new Chess(start);
        let before: string | null = null;
        for (const m of part.moves) {
          before = b.fen();
          play(b, m);
        }
        if (turn.role === 'user') positions = [b.fen(), ...(before !== null ? [before] : [])];
      }
    }
  }
  return { start, positions };
}

/**
 * Port of generate.rewind_candidates: the dialoguePosition candidates, the initial position, then every position
 * along the last user turn's lines (latest ply first, back to where the line starts) and along `gameMoves` (the game
 * from the initial position, for a prompt that only has a snapshot). One per snapshot key, at most `limit`; empty
 * when the dialogue has no position.
 */
export function rewindCandidates(turns: DialogueTurn[], gameMoves?: string[], limit = MAX_SNAPSHOT_CANDIDATES): string[] {
  const { positions } = dialoguePosition(turns);
  if (!positions.length) return [];
  let along: string[] = [];
  let start: string | undefined;
  for (const turn of turns) {
    if (turn.role === 'user') along = [];
    for (const part of turn.parts) {
      if (part.kind === 'fen') {
        start = part.fen;
        if (turn.role === 'user') along.push(new Chess(part.fen).fen());
      } else if (part.kind === 'line' && turn.role === 'user') {
        const b = new Chess(start);
        along.push(b.fen());
        for (const m of part.moves) {
          play(b, m);
          along.push(b.fen());
        }
      }
    }
  }
  const game: string[] = [];
  if (gameMoves?.length) {
    const b = new Chess();
    game.push(b.fen());
    for (const m of gameMoves) {
      play(b, m);
      game.push(b.fen());
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const fen of [...positions, START_FEN, ...along.reverse(), ...game.reverse()]) {
    const key = snapshotKey(fen);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fen);
    if (out.length >= limit) break;
  }
  return out;
}

/** Trie over candidate snapshots: begin() after <|fen|>, allowed() / feed() for the 65 tokens that follow. */
export class SnapshotPicker {
  readonly fens: string[] = [];
  private readonly codes: number[][] = [];
  private live: number[] = [];
  private step = 0;
  active = false;
  constructor(t: ChessTokenizer, fens: string[]) {
    const seen = new Set<string>();
    for (const fen of fens) {
      const key = snapshotKey(fen);
      if (seen.has(key)) continue;
      seen.add(key);
      this.fens.push(fen);
      this.codes.push(t.encodeBoard(fen).slice(1));
    }
  }
  get size(): number {
    return this.fens.length;
  }
  begin(): void {
    this.live = this.codes.map((_, i) => i);
    this.step = 0;
    this.active = this.live.length > 0;
  }
  allowed(): number[] {
    return [...new Set(this.live.map((c) => this.codes[c][this.step]))].sort((a, b) => a - b);
  }
  /** Advance by one snapshot token; the chosen FEN after the last one (else null). */
  feed(id: number): string | null {
    this.live = this.live.filter((c) => this.codes[c][this.step] === id);
    this.step++;
    if (!this.live.length) {
      this.active = false;
      return null;
    }
    if (this.step === this.codes[this.live[0]].length) {
      this.active = false;
      return this.fens[this.live[0]];
    }
    return null;
  }
}
