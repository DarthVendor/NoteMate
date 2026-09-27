import { Chess } from 'chess.js';

/** SAN of one UCI move from `fen` (the initial position when undefined); the UCI string when it does not parse. */
export function uciToSan(fen: string | undefined, uci: string): string {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
}
