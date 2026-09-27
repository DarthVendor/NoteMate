import type { Square } from '../types';

export type Orientation = 'white' | 'black';

const FILES = 'abcdefgh';

/** Convert a square to board-grid coordinates (0..7, x to the right, y downward). */
export function squareToXY(square: Square, orientation: Orientation): { x: number; y: number } {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  return orientation === 'white' ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank };
}

export function xyToSquare(x: number, y: number, orientation: Orientation): Square | null {
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  const file = orientation === 'white' ? x : 7 - x;
  const rank = orientation === 'white' ? 7 - y : y;
  return `${FILES[file]}${rank + 1}` as Square;
}

/** Square under a pointer, given the board's bounding rect. */
export function squareFromPointer(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  orientation: Orientation,
): Square | null {
  const x = Math.floor(((clientX - rect.left) / rect.width) * 8);
  const y = Math.floor(((clientY - rect.top) / rect.height) * 8);
  return xyToSquare(x, y, orientation);
}

export function isLightSquare(square: Square): boolean {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  return (file + rank) % 2 === 1;
}

export const ALL_SQUARES: Square[] = [];
for (let r = 8; r >= 1; r--) for (const f of FILES) ALL_SQUARES.push(`${f}${r}` as Square);
