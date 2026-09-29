/*
 * Set position dialog: start a new game from a FEN, the standard start, the current board, or a position built in the
 * board editor (place / remove pieces, side to move, castling rights, en passant). The FEN field and the editor stay in
 * sync both ways; validation (state/position.ts checkFen) goes beyond chess.js (side not to move in check, castling
 * rights vs pieces, pawn counts). Apply hands the normalised FEN to the app (App.tsx setPosition).
 */
import { useMemo, useRef, useState } from 'react';
import { DEFAULT_POSITION, type Color, type PieceSymbol } from 'chess.js';
import { Eraser, FlipVertical2, Trash2, X } from 'lucide-react';
import type { PieceSet } from '../ui/settings';
import type { Square } from '../types';
import { ALL_SQUARES, isLightSquare, squareFromPointer, squareToXY, type Orientation } from './boardGeometry';
import { GLYPH, PIECE_NAME, pieceUrl } from './Board';
import { Segmented } from '../ui/primitives';
import {
  CASTLE_RIGHTS, CASTLE_SQUARES, EMPTY_FEN, castleAllowed, checkFen, editorFen, epCandidates, normalizeEditor, parseEditorFen, type EditorPiece, type EditorPosition,
} from '../state/position';

interface Props {
  /** The position on the board now (the dialog starts from it). */
  currentFen: string;
  orientation: Orientation;
  pieceSet: PieceSet;
  boardTheme: string;
  /** Start a new game from this (validated, normalised) FEN, shown from `orientation`. */
  onApply: (fen: string, orientation: Orientation) => void;
  onClose: () => void;
}

type Tool = { kind: 'piece'; color: Color; type: PieceSymbol } | { kind: 'erase' };
const TYPES: PieceSymbol[] = ['k', 'q', 'r', 'b', 'n', 'p'];
const toolId = (t: Tool) => (t.kind === 'erase' ? 'erase' : `${t.color}${t.type.toUpperCase()}`);

export function SetPosition({ currentFen, orientation: initialOrientation, pieceSet, boardTheme, onApply, onClose }: Props) {
  const [text, setText] = useState(currentFen);
  const [pos, setPos] = useState<EditorPosition>(() => parseEditorFen(currentFen) ?? parseEditorFen(DEFAULT_POSITION)!);
  const [tool, setTool] = useState<Tool>({ kind: 'piece', color: 'w', type: 'q' });
  const [orientation, setOrientation] = useState<Orientation>(initialOrientation);
  const [dragFrom, setDragFrom] = useState<Square | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const check = useMemo(() => checkFen(text), [text]);
  const glyph = pieceSet === 'glyph';
  const eps = epCandidates(pos);

  /** An editor change: the position is normalised (impossible castling / en passant dropped) and the FEN follows. */
  const edit = (next: EditorPosition) => {
    const n = normalizeEditor(next);
    setPos(n);
    setText(editorFen(n));
  };
  /** A FEN typed or loaded: the editor follows whenever the placement parses (the rest is validated as typed). */
  const loadText = (fen: string) => {
    setText(fen);
    const p = parseEditorFen(fen);
    if (p) setPos(p);
  };

  const setPiece = (square: Square, piece: EditorPiece | null) => {
    const pieces = { ...pos.pieces };
    if (piece) pieces[square] = piece;
    else delete pieces[square];
    edit({ ...pos, pieces });
  };
  const applyTool = (square: Square) => {
    if (tool.kind === 'erase') return setPiece(square, null);
    const cur = pos.pieces[square];
    // tapping the same piece again removes it
    if (cur && cur.color === tool.color && cur.type === tool.type) return setPiece(square, null);
    setPiece(square, { color: tool.color, type: tool.type });
  };
  const squareAt = (e: React.PointerEvent) => (boardRef.current ? squareFromPointer(e.clientX, e.clientY, boardRef.current.getBoundingClientRect(), orientation) : null);

  const apply = () => {
    if (!check.ok) return;
    onApply(check.fen, orientation);
    onClose();
  };

  const pieceStyle = (color: Color, type: PieceSymbol): React.CSSProperties | undefined => (glyph ? undefined : { backgroundImage: `url("${pieceUrl(pieceSet, color, type)}")` });

  const palette = (color: Color) => (
    <div className="setpos-palette-row" role="group" aria-label={`${color === 'w' ? 'White' : 'Black'} pieces`}>
      {TYPES.map((type) => {
        const t: Tool = { kind: 'piece', color, type };
        const on = toolId(tool) === toolId(t);
        return (
          <button
            key={type}
            type="button"
            className={`setpos-tool ${color} ${glyph ? 'glyph' : ''}`}
            aria-pressed={on}
            onClick={() => setTool(t)}
            title={`Place a ${color === 'w' ? 'white' : 'black'} ${PIECE_NAME[type]}`}
            data-testid={`setpos-tool-${toolId(t)}`}
          >
            <span className="setpos-tool-piece" style={pieceStyle(color, type)}>
              {glyph ? GLYPH[type] : <span className="sr-only">{`${color === 'w' ? 'White' : 'Black'} ${PIECE_NAME[type]}`}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        className="modal setpos-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setpos-title"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) apply();
        }}
        data-testid="set-position"
      >
        <header className="modal-head">
          <div>
            <h2 id="setpos-title">Set up a position</h2>
            <p className="hint">Start a new game from a FEN, the current board or a position you build. The game on the board now is kept in the saved games.</p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="setpos-quick">
          <button className="btn btn-sm" onClick={() => loadText(currentFen)} title="The position on the board now (e.g. after a puzzle, or mid-game)" data-testid="setpos-current">
            Current board
          </button>
          <button className="btn btn-sm" onClick={() => loadText(DEFAULT_POSITION)} data-testid="setpos-standard">
            Standard start
          </button>
          <button className="btn btn-sm" onClick={() => loadText(EMPTY_FEN)} data-testid="setpos-clear">
            <Trash2 size={12} /> Clear board
          </button>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))} title="Flip the board" data-testid="setpos-flip">
            <FlipVertical2 size={13} /> Flip
          </button>
        </div>

        <div className="setpos-body">
          <div className="setpos-editor board-theme-scope" data-board-theme={boardTheme}>
            {palette(orientation === 'white' ? 'b' : 'w')}
            <div
              ref={boardRef}
              className={`board setpos-board ${glyph ? 'glyph-set' : ''}`}
              role="application"
              aria-label="Board editor: tap a square to place the selected piece, tap it again to remove it, drag a piece to move it"
              data-testid="setpos-board"
              data-orientation={orientation}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const s = squareAt(e);
                if (!s) return;
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                setDragFrom(s);
              }}
              onPointerUp={(e) => {
                const from = dragFrom;
                setDragFrom(null);
                if (!from) return;
                const to = squareAt(e);
                const piece = pos.pieces[from];
                if (to === from || !piece) {
                  if (to) applyTool(to);
                  return;
                }
                // drag: move the piece (off the board: remove it)
                const pieces = { ...pos.pieces };
                delete pieces[from];
                if (to) pieces[to] = piece;
                edit({ ...pos, pieces });
              }}
              onPointerCancel={() => setDragFrom(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                const s = squareAt(e as unknown as React.PointerEvent);
                if (s) setPiece(s, null);
              }}
            >
              {ALL_SQUARES.map((s) => {
                const { x, y } = squareToXY(s, orientation);
                const p = pos.pieces[s];
                return (
                  <div
                    key={s}
                    className={`square ${isLightSquare(s) ? 'light' : 'dark'} ${dragFrom === s && p ? 'selected' : ''}`}
                    style={{ gridColumn: x + 1, gridRow: y + 1 }}
                    data-square={s}
                    data-piece={p ? `${p.color}${p.type}` : undefined}
                  >
                    {x === 0 && <span className="coord rank">{s[1]}</span>}
                    {y === 7 && <span className="coord file">{s[0]}</span>}
                    {p && (
                      <span className={`setpos-piece ${p.color}`} style={pieceStyle(p.color, p.type)} aria-label={`${p.color === 'w' ? 'White' : 'Black'} ${PIECE_NAME[p.type]} on ${s}`}>
                        {glyph ? GLYPH[p.type] : null}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {palette(orientation === 'white' ? 'w' : 'b')}
            <div className="setpos-palette-row">
              <button type="button" className="btn btn-sm setpos-eraser" aria-pressed={tool.kind === 'erase'} onClick={() => setTool({ kind: 'erase' })} title="Eraser: tap pieces to remove them" data-testid="setpos-tool-erase">
                <Eraser size={13} /> Eraser
              </button>
              <span className="faint setpos-tip">Tap to place · tap again to remove · drag to move</span>
            </div>
          </div>

          <div className="setpos-side">
            <div className="field">
              <span className="field-label">Side to move</span>
              <Segmented
                label="Side to move"
                value={pos.turn}
                onChange={(turn) => edit({ ...pos, turn })}
                options={[
                  { value: 'w', label: <span data-testid="setpos-turn-w">White</span> },
                  { value: 'b', label: <span data-testid="setpos-turn-b">Black</span> },
                ]}
              />
            </div>
            <div className="field">
              <span className="field-label">Castling rights</span>
              {CASTLE_RIGHTS.map((c) => {
                const allowed = castleAllowed(pos, c);
                return (
                  <label key={c} className={`check-row ${!allowed ? 'is-disabled' : ''}`} title={allowed ? undefined : `Needs the king on ${CASTLE_SQUARES[c].king} and the rook on ${CASTLE_SQUARES[c].rook}`}>
                    <span>{CASTLE_SQUARES[c].label}</span>
                    <input
                      type="checkbox"
                      checked={pos.castling[c]}
                      disabled={!allowed && !pos.castling[c]}
                      onChange={(e) => edit({ ...pos, castling: { ...pos.castling, [c]: e.target.checked } })}
                      data-testid={`setpos-castle-${c}`}
                    />
                  </label>
                );
              })}
            </div>
            {(eps.length > 0 || pos.ep) && (
              <label className="field">
                <span className="field-label">En passant</span>
                <select className="select" value={pos.ep ?? ''} onChange={(e) => edit({ ...pos, ep: (e.target.value || null) as Square | null })} data-testid="setpos-ep">
                  <option value="">none</option>
                  {[...new Set([...eps, ...(pos.ep ? [pos.ep] : [])])].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        <label className="field">
          <span className="field-label">FEN</span>
          <input
            className="input setpos-fen"
            value={text}
            onChange={(e) => loadText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!check.ok}
            aria-describedby="setpos-status"
            data-testid="setpos-fen"
          />
        </label>
        <div id="setpos-status" aria-live="polite">
          {!check.ok ? (
            <p className="error" role="alert" data-testid="setpos-error">
              {check.error}
            </p>
          ) : check.warning ? (
            <p className="hint setpos-warning" data-testid="setpos-warning">
              {check.warning}
            </p>
          ) : null}
        </div>

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={apply} disabled={!check.ok} data-testid="setpos-apply">
            Start new game here
          </button>
        </div>
      </div>
    </div>
  );
}
