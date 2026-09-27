import type { EngineLine } from '../engine/EngineClient';
import type { Orientation } from './boardGeometry';

interface Props {
  line?: EngineLine;
  sideToMove: 'w' | 'b';
  orientation: Orientation;
}

/** Percentage of the bar that is white, from White's point of view. */
function whiteShare(line: EngineLine | undefined, sideToMove: 'w' | 'b'): number {
  if (!line) return 50;
  const sign = sideToMove === 'w' ? 1 : -1;
  if (line.mate !== undefined) return line.mate * sign > 0 ? 100 : 0;
  const cp = (line.cp ?? 0) * sign;
  // Logistic curve similar to lichess: ±1000cp ≈ 95%.
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368 * cp)) - 1);
}

export function EvalBar({ line, sideToMove, orientation }: Props) {
  const white = whiteShare(line, sideToMove);
  const sign = sideToMove === 'w' ? 1 : -1;
  let label = '';
  if (line) {
    if (line.mate !== undefined) label = `M${Math.abs(line.mate)}`;
    else label = (Math.abs((line.cp ?? 0) * sign) / 100).toFixed(1);
  }
  const whiteOnTop = orientation === 'black';
  return (
    <div className={`eval-bar ${whiteOnTop ? 'flipped' : ''}`} title="Evaluation">
      <div className="eval-white" style={{ height: `${white}%` }} />
      {line && <span className={`eval-label ${white >= 50 ? 'on-white' : 'on-black'}`}>{label}</span>}
    </div>
  );
}
