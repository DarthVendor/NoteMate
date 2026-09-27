import { ExternalLink, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useApp } from '../app/AppContext';
import { formatTimeControl } from '../state/pgn';
import type { GameReview, ReviewedMove } from '../types';
import { mainLine, REVIEW_DEPTHS, reviewStale } from './useGameReview';

const CLASS_LABEL: Record<ReviewedMove['cls'], string> = { best: 'Best', good: 'Good', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };

/** White's win% over the game as a small area chart; click a point to go to that move. */
function WinChart({ review, currentId, onGoto }: { review: GameReview; currentId: string; onGoto: (id: string) => void }) {
  const n = review.moves.length;
  if (!n) return null;
  const W = 300;
  const H = 64;
  // White's win% after each move (the mover's "after" for White moves, 100 - it for Black moves).
  const pts = [review.moves[0].ply % 2 === 1 ? review.moves[0].before : 100 - review.moves[0].before, ...review.moves.map((m) => (m.ply % 2 === 1 ? m.after : 100 - m.after))];
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * W;
  const y = (p: number) => H - (p / 100) * H;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const cur = review.moves.findIndex((m) => m.nodeId === currentId);
  return (
    <svg className="rv-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="White's winning chances over the game">
      <path className="rv-chart-area" d={`${path} L${W},${H} L0,${H} Z`} />
      <line className="rv-chart-mid" x1="0" x2={W} y1={H / 2} y2={H / 2} />
      {cur >= 0 && <line className="rv-chart-cur" x1={x(cur + 1)} x2={x(cur + 1)} y1="0" y2={H} />}
      {review.moves.map((m, i) =>
        m.cls === 'blunder' || m.cls === 'mistake' ? <circle key={m.nodeId} className={`rv-dot is-${m.cls}`} cx={x(i + 1)} cy={y(pts[i + 1])} r="3" /> : null,
      )}
      {review.moves.map((m, i) => (
        <rect key={`hit-${m.nodeId}`} x={x(i + 1) - W / pts.length / 2} y="0" width={W / pts.length} height={H} fill="transparent" onClick={() => onGoto(m.nodeId)}>
          <title>{`${Math.ceil(m.ply / 2)}${m.ply % 2 ? '.' : '...'} ${m.san}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** Engine game review: accuracy per side, blunders / mistakes / inaccuracies, and a list of the flagged moves. */
export function ReviewPanel() {
  const { state, dispatch, review: rv } = useApp();
  const r = state.review;
  const plies = mainLine(state).length;
  const stale = reviewStale(state);
  const flagged = r?.moves.filter((m) => m.cls === 'blunder' || m.cls === 'mistake' || m.cls === 'inaccuracy') ?? [];
  const { white, black, whiteElo, blackElo, timeControl, termination, link } = state.meta;
  const tc = formatTimeControl(timeControl);

  return (
    <div className="rv-panel" data-testid="review-panel">
      {(link || tc || termination) && (
        <p className="rv-game">
          {[tc, termination].filter(Boolean).join(' · ')}
          {link && (
            <a className="link-btn rv-link" href={link} target="_blank" rel="noreferrer">
              chess.com <ExternalLink size={11} />
            </a>
          )}
        </p>
      )}

      <div className="rv-controls">
        {rv.busy ? (
          <button className="btn btn-sm" onClick={rv.cancel} data-testid="review-stop">
            <Square size={11} /> Stop
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={() => rv.start()} disabled={!plies} data-testid="review-start">
            {r ? <RotateCcw size={12} /> : <Play size={12} />} {r ? 'Review again' : 'Review game'}
          </button>
        )}
        <label className="rv-depth">
          Depth
          <select className="select rv-select" value={rv.depth} onChange={(e) => rv.setDepth(Number(e.target.value))} disabled={rv.busy} aria-label="Search depth per position">
            {REVIEW_DEPTHS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        {r && !rv.busy && (
          <button className="btn btn-sm btn-ghost btn-icon" onClick={rv.clear} title="Remove the review and its notes" aria-label="Remove the review">
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {rv.busy && rv.progress && (
        <div className="rv-progress" data-testid="review-progress">
          <div className="rv-bar">
            <span style={{ width: `${(100 * rv.progress.done) / Math.max(1, rv.progress.total)}%` }} />
          </div>
          <span className="faint">
            {rv.phase === 'loading' ? 'Starting Stockfish…' : `Position ${rv.progress.done} of ${rv.progress.total}`}
          </span>
        </div>
      )}
      {rv.error && <p className="error">{rv.error}</p>}
      {!r && !rv.busy && !rv.error && (
        <p className="rv-empty">
          Stockfish walks the main line at depth {rv.depth} and marks moves that lose win chances: blunders (≥ 20%), mistakes (≥ 10%) and inaccuracies (≥ 5%). Blunders and mistakes get a note.
        </p>
      )}

      {r && (
        <>
          {stale && <p className="rv-stale">The main line changed since this review. Run it again to update it.</p>}
          <table className="rv-table" data-testid="review-summary">
            <thead>
              <tr>
                <th />
                <th title="Approximate accuracy (Lichess formula)">Accuracy</th>
                <th title="Blunders (≥ 20% win chance lost)">??</th>
                <th title="Mistakes (≥ 10%)">?</th>
                <th title="Inaccuracies (≥ 5%)">?!</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['white', white ?? 'White', whiteElo, r.white],
                  ['black', black ?? 'Black', blackElo, r.black],
                ] as const
              ).map(([side, name, elo, s]) => (
                <tr key={side} data-testid={`review-${side}`}>
                  <td>
                    <span className={`rv-side is-${side}`} aria-hidden />
                    {name}
                    {elo && <span className="faint"> ({elo})</span>}
                  </td>
                  <td className="rv-acc">{s.accuracy.toFixed(1)}</td>
                  <td className="is-blunder">{s.blunders}</td>
                  <td className="is-mistake">{s.mistakes}</td>
                  <td className="is-inaccuracy">{s.inaccuracies}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <WinChart review={r} currentId={state.currentId} onGoto={(id) => dispatch({ type: 'GOTO', id })} />
          {flagged.length ? (
            <ol className="rv-moves" data-testid="review-moves">
              {flagged.map((m) => (
                <li key={m.nodeId} className={m.nodeId === state.currentId ? 'is-current' : ''}>
                  <button className="rv-move" onClick={() => dispatch({ type: 'GOTO', id: m.nodeId })} disabled={!state.nodes[m.nodeId]}>
                    <span className={`rv-tag is-${m.cls}`}>{CLASS_LABEL[m.cls]}</span>
                    <span className="rv-san">
                      {Math.ceil(m.ply / 2)}
                      {m.ply % 2 ? '.' : '...'} {m.san}
                    </span>
                    <span className="rv-loss">−{Math.round(m.loss)}%</span>
                    {m.best && <span className="faint rv-best">best {m.best}</span>}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="rv-empty">No inaccuracies, mistakes or blunders at this depth.</p>
          )}
          <p className="rv-foot faint">
            {r.engine} · depth {r.depth} · {r.plies} plies. Accuracy is approximate (Lichess's formula), not chess.com's CAPS.
          </p>
        </>
      )}
    </div>
  );
}
