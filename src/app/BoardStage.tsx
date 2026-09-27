import { useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Copy, Eraser, FlipVertical2 } from 'lucide-react';
import { Board } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import type { Arrow, Square } from '../types';
import { ROOT_ID } from '../types';
import { nodeLabel } from '../state/gameReducer';
import { useApp } from './AppContext';
import { Onboarding } from './Onboarding';

function statusLine(chess: ReturnType<typeof useApp>['chess']): { text: string; tone: 'normal' | 'check' | 'over' } {
  const side = chess.turn() === 'w' ? 'White' : 'Black';
  if (chess.isCheckmate()) return { text: `Checkmate · ${side === 'White' ? 'Black' : 'White'} wins`, tone: 'over' };
  if (chess.isStalemate()) return { text: 'Stalemate', tone: 'over' };
  if (chess.isInsufficientMaterial()) return { text: 'Draw · insufficient material', tone: 'over' };
  if (chess.isThreefoldRepetition()) return { text: 'Draw · threefold repetition', tone: 'over' };
  if (chess.isDrawByFiftyMoves()) return { text: 'Draw · fifty-move rule', tone: 'over' };
  if (chess.inCheck()) return { text: `${side} to move · check`, tone: 'check' };
  return { text: `${side} to move`, tone: 'normal' };
}

/** The primary surface: game header, eval bar + board, and the navigation strip. */
export function BoardStage() {
  const app = useApp();
  const { state, dispatch, chess, fen, annotation, lastMove, orientation, engine, chessmind, ui } = app;
  const [copied, setCopied] = useState(false);

  const pinnedCm = annotation.arrows.filter((a) => a.color === 'chessmind');
  const cmMoves = chessmind.settings.enabled && chessmind.settings.arrows && pinnedCm.length === 0 ? (chessmind.prediction?.moves ?? []) : [];
  const chessmindArrows: Arrow[] = cmMoves.map((m) => ({
    from: m.uci.slice(0, 2) as Square,
    to: m.uci.slice(2, 4) as Square,
    color: 'chessmind' as const,
    opacity: 0.25 + 0.6 * (m.p / (cmMoves[0]?.p || 1)),
  }));
  const engineArrows: Arrow[] = engine.settings.enabled
    ? engine.lines.slice(0, 1).flatMap((l) => (l.pv[0] ? [{ from: l.pv[0].slice(0, 2) as Square, to: l.pv[0].slice(2, 4) as Square, color: 'engine' as const }] : []))
    : [];

  const { white, black, event, result, date } = state.meta;
  const hasPlayers = !!(white || black);
  const top = orientation === 'white' ? black : white;
  const bottom = orientation === 'white' ? white : black;
  const status = statusLine(chess);
  const atStart = state.currentId === ROOT_ID;
  const atEnd = state.nodes[state.currentId].children.length === 0;
  const hasShapes = annotation.arrows.length > 0 || annotation.highlights.length > 0;

  const copyFen = async () => {
    try {
      await navigator.clipboard.writeText(fen);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      app.toast('Clipboard unavailable');
    }
  };

  return (
    <div className="stage" data-board-theme={ui.boardTheme}>
      <header className="stage-head">
        <div className="stage-title">
          <h1 className="game-title">
            {hasPlayers ? (
              <>
                <span>{white ?? '?'}</span>
                <span className="vs">–</span>
                <span>{black ?? '?'}</span>
              </>
            ) : (
              'Analysis board'
            )}
          </h1>
          {(event || date || (result && result !== '*')) && <p className="game-sub">{[event, date?.replace(/\.\?\?/g, ''), result !== '*' ? result : null].filter(Boolean).join(' · ')}</p>}
        </div>
        <div className={`stage-status tone-${status.tone}`} aria-live="polite">
          <span className={`turn-dot ${chess.turn()}`} aria-hidden />
          {status.text}
          <span className="stage-ply">{atStart ? 'Start' : nodeLabel(state, state.currentId)}</span>
        </div>
      </header>

      <Onboarding />

      <div className={`stage-board ${hasPlayers ? 'has-players' : ''} ${engine.settings.enabled ? 'has-eval' : ''}`}>
        <div className="board-frame">
          {hasPlayers && <div className="player player-top">{top ?? '?'}</div>}
          <div className="board-with-eval">
            {engine.settings.enabled ? <EvalBar line={engine.lines[0]} sideToMove={chess.turn()} orientation={orientation} /> : <div className="eval-bar placeholder" aria-hidden />}
            <Board
              chess={chess}
              orientation={orientation}
              arrows={[...chessmindArrows, ...engineArrows, ...annotation.arrows]}
              highlights={annotation.highlights}
              lastMove={lastMove}
              onMove={(from, to, promotion) => dispatch({ type: 'MAKE_MOVE', from, to, promotion })}
              onToggleArrow={(arrow) => dispatch({ type: 'TOGGLE_ARROW', arrow })}
              onToggleHighlight={(highlight) => dispatch({ type: 'TOGGLE_HIGHLIGHT', highlight })}
              pieceSet={ui.pieceSet}
              coordinates={ui.coordinates}
              legalMoves={ui.legalMoves}
            />
          </div>
          {hasPlayers && <div className="player player-bottom">{bottom ?? '?'}</div>}
        </div>
      </div>

      <footer className="stage-foot">
        <div className="nav-group" role="group" aria-label="Move navigation">
          <button className="btn btn-ghost btn-icon" onClick={() => dispatch({ type: 'START' })} disabled={atStart} title="Start (Home)" aria-label="Go to start">
            <ChevronFirst size={17} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={() => dispatch({ type: 'BACK' })} disabled={atStart} title="Previous move (←)" aria-label="Previous move">
            <ChevronLeft size={17} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={() => dispatch({ type: 'FORWARD' })} disabled={atEnd} title="Next move (→)" aria-label="Next move">
            <ChevronRight size={17} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={() => dispatch({ type: 'END' })} disabled={atEnd} title="End of line (End)" aria-label="Go to end of line">
            <ChevronLast size={17} />
          </button>
        </div>
        <span className="foot-divider" />
        <button className="btn btn-ghost btn-icon" onClick={app.flip} title="Flip board (F)" aria-label="Flip board">
          <FlipVertical2 size={16} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={() => dispatch({ type: 'CLEAR_SHAPES' })} disabled={!hasShapes} title="Clear arrows and highlights on this position (X)" aria-label="Clear arrows and highlights">
          <Eraser size={16} />
        </button>
        <div className="fen-field" title="FEN of the current position">
          <span className="fen-label">FEN</span>
          <input className="fen" readOnly value={fen} onFocus={(e) => e.target.select()} aria-label="FEN of the current position" />
          <button className="btn btn-ghost btn-icon btn-sm" onClick={copyFen} title="Copy FEN" aria-label="Copy FEN">
            {copied ? <span className="copied">✓</span> : <Copy size={13} />}
          </button>
        </div>
      </footer>
      {ui.boardHints && (
        <p className="stage-hint">
          Drag or click to move · right-drag to draw an arrow, right-click to circle · hold <kbd>⇧</kbd> <kbd>Alt</kbd> <kbd>Ctrl</kbd> for red, blue, yellow
        </p>
      )}
    </div>
  );
}
