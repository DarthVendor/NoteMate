import { Chess } from 'chess.js';
import type { EngineLine } from './EngineClient';

/** Score from White's point of view, formatted like "+0.35" or "#-3". */
export function formatScore(line: EngineLine, sideToMove: 'w' | 'b'): string {
  const sign = sideToMove === 'w' ? 1 : -1;
  if (line.mate !== undefined) {
    const m = line.mate * sign;
    return m > 0 ? `#${m}` : `#-${Math.abs(m)}`;
  }
  const pawns = ((line.cp ?? 0) * sign) / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(2);
}

/** A UCI principal variation as SAN tokens with move numbers, from `fen`. */
export function pvTokens(fen: string, pv: string[]): { num: string; san: string }[] {
  const chess = new Chess(fen);
  const out: { num: string; san: string }[] = [];
  for (const uci of pv) {
    const moveNo = chess.moveNumber();
    const white = chess.turn() === 'w';
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined });
      out.push({ num: white ? `${moveNo}.` : out.length === 0 ? `${moveNo}…` : '', san: m.san });
    } catch {
      break;
    }
  }
  return out;
}
