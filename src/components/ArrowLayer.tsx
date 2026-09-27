import type { Arrow, Highlight, ShapeColor } from '../types';
import { squareToXY, type Orientation } from './boardGeometry';

export const SHAPE_COLORS: Record<ShapeColor, string> = {
  green: '#15781B',
  red: '#882020',
  blue: '#003088',
  yellow: '#e68f00',
  engine: '#4a90e2',
  chessmind: '#b04fd8',
};

interface Props {
  arrows: Arrow[];
  highlights: Highlight[];
  preview?: Arrow | null;
  orientation: Orientation;
}

function ArrowShape({ arrow, orientation, faded }: { arrow: Arrow; orientation: Orientation; faded?: boolean }) {
  const a = squareToXY(arrow.from, orientation);
  const b = squareToXY(arrow.to, orientation);
  const x1 = a.x + 0.5;
  const y1 = a.y + 0.5;
  const x2 = b.x + 0.5;
  const y2 = b.y + 0.5;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 0.32;
  const headWidth = 0.22;
  const margin = 0.3; // start a bit away from the origin square's centre
  const sx = x1 + ux * margin;
  const sy = y1 + uy * margin;
  const ex = x2 - ux * headLen;
  const ey = y2 - uy * headLen;
  const px = -uy;
  const py = ux;
  const head = [
    `${x2},${y2}`,
    `${ex + px * headWidth},${ey + py * headWidth}`,
    `${ex - px * headWidth},${ey - py * headWidth}`,
  ].join(' ');
  const color = SHAPE_COLORS[arrow.color];
  return (
    <g opacity={faded ? 0.5 : (arrow.opacity ?? (arrow.color === 'engine' ? 0.6 : 0.85))}>
      <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={color} strokeWidth={0.16} strokeLinecap="round" />
      <polygon points={head} fill={color} />
    </g>
  );
}

export function ArrowLayer({ arrows, highlights, preview, orientation }: Props) {
  return (
    <svg className="arrow-layer" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg">
      {highlights.map((h) => {
        const { x, y } = squareToXY(h.square, orientation);
        return (
          <circle
            key={h.square}
            cx={x + 0.5}
            cy={y + 0.5}
            r={0.42}
            fill="none"
            stroke={SHAPE_COLORS[h.color]}
            strokeWidth={0.1}
            opacity={0.85}
          />
        );
      })}
      {arrows.map((a) => (
        <ArrowShape key={`${a.color}${a.from}${a.to}`} arrow={a} orientation={orientation} />
      ))}
      {preview && preview.from !== preview.to && <ArrowShape arrow={preview} orientation={orientation} faded />}
    </svg>
  );
}
