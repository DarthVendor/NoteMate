import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chess, Move, PieceSymbol, Color } from 'chess.js';
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
}

const GLYPH: Record<PieceSymbol, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

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
}

const DRAG_THRESHOLD_PX = 6;

export function Board({ chess, orientation, arrows, highlights, lastMove, onMove, onToggleArrow, onToggleHighlight }: Props) {
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
      if (moved) setDrag({ ...drag, x, y, moved });
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

  const board = chess.board().flat().filter((p): p is NonNullable<typeof p> => p !== null);
  const inCheck = chess.inCheck();
  const kingSquare = board.find((p) => p.type === 'k' && p.color === turn)?.square;

  return (
    <div className={`board-wrap orientation-${orientation}`}>
      <div
        ref={boardRef}
        className={`board ${drag?.moved ? 'dragging' : ''}`}
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
          const target = legalTargets.find((m) => m.to === sq);
          if (target) classes.push(target.captured ? 'capture-target' : 'move-target');
          return (
            <div
              key={sq}
              className={classes.join(' ')}
              style={{ gridColumn: x + 1, gridRow: y + 1 }}
              data-square={sq}
            >
              {x === 0 && <span className="coord rank">{sq[1]}</span>}
              {y === 7 && <span className="coord file">{sq[0]}</span>}
            </div>
          );
        })}

        {board.map((p) => {
          const { x, y } = squareToXY(p.square, orientation);
          const isDragged = drag?.moved && drag.from === p.square;
          const style: React.CSSProperties = isDragged
            ? { transform: `translate(calc(${drag.x}px - 50%), calc(${drag.y}px - 50%)) scale(1.1)`, transition: 'none', zIndex: 10 }
            : { transform: `translate(${x * 100}%, ${y * 100}%)` };
          return (
            <div key={p.square} className={`piece ${p.color} ${isDragged ? 'dragged' : ''}`} style={style}>
              {GLYPH[p.type]}
            </div>
          );
        })}

        <ArrowLayer arrows={arrows} highlights={highlights} preview={preview} orientation={orientation} />

        {pendingPromotion && (
          <div className="promotion-overlay" onPointerDown={(e) => e.stopPropagation()}>
            <div className="promotion-chooser">
              {(['q', 'r', 'b', 'n'] as Promotion[]).map((p) => (
                <button key={p} className={`piece ${turn}`} onClick={() => handlePromotion(p)}>
                  {GLYPH[p]}
                </button>
              ))}
              <button className="promotion-cancel" onClick={() => setPendingPromotion(null)}>
                ×
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
