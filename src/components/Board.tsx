import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chess, Move, PieceSymbol, Color } from 'chess.js';
import type { PieceSet } from '../ui/settings';
import type { Arrow, Highlight, ShapeColor, Square } from '../types';
import { ArrowLayer } from './ArrowLayer';
import { ALL_SQUARES, isLightSquare, squareFromPointer, squareToXY, type Orientation } from './boardGeometry';

type Promotion = 'q' | 'r' | 'b' | 'n';

interface Props {
  chess: Chess;
  orientation: Orientation;
  arrows: Arrow[];
  highlights: Highlight[];
  lastMove?: Move;
  onMove: (from: Square, to: Square, promotion?: Promotion) => void;
  onToggleArrow: (arrow: Arrow) => void;
  onToggleHighlight: (highlight: Highlight) => void;
  pieceSet?: PieceSet;
  coordinates?: boolean;
  legalMoves?: boolean;
}

const PIECE_URLS = import.meta.glob('../assets/pieces/*/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const pieceUrl = (set: PieceSet, color: Color, type: PieceSymbol) => PIECE_URLS[`../assets/pieces/${set}/${color}${type.toUpperCase()}.svg`];

interface Placed {
  id: number;
  square: Square;
  type: PieceSymbol;
  color: Color;
}

const fileRank = (sq: Square) => [sq.charCodeAt(0) - 97, Number(sq[1]) - 1] as const;

/**
 * Give pieces stable ids across positions so a moved piece keeps its DOM node and slides (CSS transition)
 * instead of vanishing and reappearing. Unchanged squares keep their piece; the rest match the nearest
 * disappeared piece of the same kind. Big jumps (navigating far, flipping) are marked instant.
 */
interface Tracked {
  fen: string;
  orientation: Orientation;
  pieces: Placed[];
  next: number;
  instant: boolean;
}

function track(prev: Tracked, chess: Chess, fen: string, orientation: Orientation): Tracked {
  const now = chess.board().flat().filter((p): p is NonNullable<typeof p> => p !== null);
  const unused = [...prev.pieces];
  let next = prev.next;
  const out: (Placed | null)[] = now.map((p) => {
    const i = unused.findIndex((u) => u.square === p.square && u.type === p.type && u.color === p.color);
    return i >= 0 ? unused.splice(i, 1)[0] : null;
  });
  let moved = 0;
  now.forEach((p, k) => {
    if (out[k]) return;
    const [f, r] = fileRank(p.square);
    let best = -1;
    let bestD = Infinity;
    unused.forEach((u, i) => {
      if (u.type !== p.type || u.color !== p.color) return;
      const [uf, ur] = fileRank(u.square);
      const d = Math.hypot(uf - f, ur - r);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      out[k] = { ...unused.splice(best, 1)[0], square: p.square };
      moved++;
    } else {
      out[k] = { id: next++, square: p.square, type: p.type, color: p.color };
    }
  });
  const instant = prev.fen === '' || prev.orientation !== orientation || moved > 3 || unused.length > 2;
  return { fen, orientation, pieces: out as Placed[], next, instant };
}

/**
 * Give pieces stable ids across positions so a moved piece keeps its DOM node and slides (CSS transition)
 * instead of vanishing and reappearing. Unchanged squares keep their piece; the rest match the nearest
 * disappeared piece of the same kind. Big jumps (navigating far, flipping) are marked instant.
 * Uses React's "adjust state while rendering" pattern, so no refs are read during render.
 */
function usePlacedPieces(chess: Chess, orientation: Orientation): { pieces: Placed[]; instant: boolean } {
  const fen = chess.fen();
  const [tracked, setTracked] = useState<Tracked>(() => track({ fen: '', orientation, pieces: [], next: 1, instant: true }, chess, fen, orientation));
  if (tracked.fen !== fen || tracked.orientation !== orientation) {
    const next = track(tracked, chess, fen, orientation);
    setTracked(next);
    return next;
  }
  return tracked;
}

const GLYPH: Record<PieceSymbol, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const PIECE_NAME: Record<PieceSymbol, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

function shapeColorFromEvent(e: React.PointerEvent | PointerEvent): ShapeColor {
  if (e.shiftKey) return 'red';
  if (e.altKey) return 'blue';
  if (e.ctrlKey || e.metaKey) return 'yellow';
  return 'green';
}

interface DragState {
  from: Square;
  startX: number; // pointer position at pointerdown, relative to board, in px
  startY: number;
  x: number; // current pointer position relative to board, in px
  y: number;
  /** True once the pointer has travelled far enough to count as a drag rather than a click. */
  moved: boolean;
  /** Square under the pointer while dragging. */
  over?: Square | null;
}

const DRAG_THRESHOLD_PX = 6;

export function Board({ chess, orientation, arrows, highlights, lastMove, onMove, onToggleArrow, onToggleHighlight, pieceSet = 'cburnett', coordinates = true, legalMoves = true }: Props) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [shapeStart, setShapeStart] = useState<{ from: Square; color: ShapeColor } | null>(null);
  const [preview, setPreview] = useState<Arrow | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);

  const legalTargets: Move[] = selected ? chess.moves({ square: selected, verbose: true }) : [];
  const turn: Color = chess.turn();

  // Clear selection when the position changes.
  const fen = chess.fen();
  useEffect(() => {
    setSelected(null);
    setDrag(null);
    setPendingPromotion(null);
  }, [fen]);

  const tryMove = useCallback(
    (from: Square, to: Square) => {
      const candidates = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
      if (candidates.length === 0) return false;
      if (candidates.some((m) => m.promotion)) {
        setPendingPromotion({ from, to });
      } else {
        onMove(from, to);
      }
      return true;
    },
    [chess, onMove],
  );

  const rect = () => boardRef.current!.getBoundingClientRect();

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pendingPromotion) return;
    const sq = squareFromPointer(e.clientX, e.clientY, rect(), orientation);
    if (!sq) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 2) {
      setShapeStart({ from: sq, color: shapeColorFromEvent(e) });
      setPreview(null);
      return;
    }
    if (e.button !== 0) return;

    const piece = chess.get(sq);
    if (selected && sq !== selected && tryMove(selected, sq)) {
      setSelected(null);
      return;
    }
    if (piece && piece.color === turn) {
      const r = rect();
      setSelected(sq);
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      setDrag({ from: sq, startX: x, startY: y, x, y, moved: false });
    } else {
      setSelected(null);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag) {
      const r = rect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const moved = drag.moved || Math.hypot(x - drag.startX, y - drag.startY) > DRAG_THRESHOLD_PX;
      if (moved) setDrag({ ...drag, x, y, moved, over: squareFromPointer(e.clientX, e.clientY, r, orientation) });
    }
    if (shapeStart) {
      const sq = squareFromPointer(e.clientX, e.clientY, rect(), orientation);
      const color = shapeColorFromEvent(e);
      setPreview(sq ? { from: shapeStart.from, to: sq, color } : null);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const sq = squareFromPointer(e.clientX, e.clientY, rect(), orientation);
    if (shapeStart) {
      const color = shapeColorFromEvent(e);
      if (sq && sq === shapeStart.from) onToggleHighlight({ square: sq, color });
      else if (sq) onToggleArrow({ from: shapeStart.from, to: sq, color });
      setShapeStart(null);
      setPreview(null);
      return;
    }
    if (drag) {
      if (sq && sq !== drag.from) {
        if (tryMove(drag.from, sq)) setSelected(null);
        else setSelected(null);
      }
      // Dropped on origin: keep it selected for click-click moving.
      setDrag(null);
    }
  };

  const handlePromotion = (p: Promotion) => {
    if (!pendingPromotion) return;
    onMove(pendingPromotion.from, pendingPromotion.to, p);
    setPendingPromotion(null);
  };

  const { pieces, instant } = usePlacedPieces(chess, orientation);
  const inCheck = chess.inCheck();
  const kingSquare = pieces.find((p) => p.type === 'k' && p.color === turn)?.square;
  const hoverSquare = drag?.moved ? drag.over : null;
  const glyph = pieceSet === 'glyph';

  return (
    <div className={`board-wrap orientation-${orientation}`}>
      <div
        ref={boardRef}
        className={`board ${drag?.moved ? 'dragging' : ''} ${instant ? 'instant' : ''} ${glyph ? 'glyph-set' : ''}`}
        role="application"
        aria-label={`Chess board, ${turn === 'w' ? 'White' : 'Black'} to move`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          setDrag(null);
          setShapeStart(null);
          setPreview(null);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {ALL_SQUARES.map((sq) => {
          const { x, y } = squareToXY(sq, orientation);
          const classes = ['square', isLightSquare(sq) ? 'light' : 'dark'];
          if (lastMove && (lastMove.from === sq || lastMove.to === sq)) classes.push('last-move');
          if (selected === sq) classes.push('selected');
          if (inCheck && kingSquare === sq) classes.push('check');
          if (hoverSquare === sq && hoverSquare !== drag?.from) classes.push('drag-over');
          const target = legalMoves ? legalTargets.find((m) => m.to === sq) : undefined;
          if (target) classes.push(target.captured ? 'capture-target' : 'move-target');
          return (
            <div
              key={sq}
              className={classes.join(' ')}
              style={{ gridColumn: x + 1, gridRow: y + 1 }}
              data-square={sq}
            >
              {coordinates && x === 0 && <span className="coord rank">{sq[1]}</span>}
              {coordinates && y === 7 && <span className="coord file">{sq[0]}</span>}
            </div>
          );
        })}

        {pieces.map((p) => {
          const { x, y } = squareToXY(p.square, orientation);
          const isDragged = drag?.moved && drag.from === p.square;
          const style: React.CSSProperties = isDragged
            ? { transform: `translate(calc(${drag.x}px - 50%), calc(${drag.y}px - 50%)) scale(1.08)`, transition: 'none', zIndex: 10 }
            : { transform: `translate(${x * 100}%, ${y * 100}%)` };
          if (!glyph) style.backgroundImage = `url("${pieceUrl(pieceSet, p.color, p.type)}")`;
          return (
            <div
              key={p.id}
              className={`piece ${p.color} ${isDragged ? 'dragged' : ''}`}
              style={style}
              data-piece={`${p.color}${p.type}`}
              data-square={p.square}
              aria-label={`${p.color === 'w' ? 'White' : 'Black'} ${PIECE_NAME[p.type]} on ${p.square}`}
            >
              {glyph ? GLYPH[p.type] : null}
            </div>
          );
        })}

        <ArrowLayer arrows={arrows} highlights={highlights} preview={preview} orientation={orientation} />

        {pendingPromotion && (
          <div className="promotion-overlay" onPointerDown={(e) => e.stopPropagation()}>
            <div className="promotion-chooser" role="dialog" aria-label="Choose promotion piece">
              {(['q', 'r', 'b', 'n'] as Promotion[]).map((p) => (
                <button
                  key={p}
                  className={`promo-piece ${turn} ${glyph ? 'glyph' : ''}`}
                  onClick={() => handlePromotion(p)}
                  title={`Promote to ${PIECE_NAME[p]}`}
                  style={glyph ? undefined : { backgroundImage: `url("${pieceUrl(pieceSet, turn, p)}")` }}
                >
                  {glyph ? GLYPH[p] : <span className="sr-only">{PIECE_NAME[p]}</span>}
                </button>
              ))}
              <button className="promotion-cancel btn btn-ghost btn-icon" onClick={() => setPendingPromotion(null)} title="Cancel">
                ×
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
