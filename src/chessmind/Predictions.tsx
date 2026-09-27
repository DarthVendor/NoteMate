/** ChessMind's predicted next moves as compact chips (SAN + probability), with pin / live-arrow toggles. */
import { MoveUpRight, Pin, PinOff } from 'lucide-react';
import type { useChessMind } from './useChessMind';
import { uciToSan } from './san';
import type { GameAction } from '../state/gameReducer';
import type { Arrow, GameState, Square } from '../types';

interface Props {
  cm: ReturnType<typeof useChessMind>;
  state: GameState;
  dispatch: (a: GameAction) => void;
  fen: string;
  /** False for games with a custom start (the model follows games from the initial position). */
  standardStart: boolean;
  onPlayUci: (uci: string) => void;
}

export function PredictionChips({ cm, state, dispatch, fen, standardStart, onPlayUci }: Props) {
  const { prediction, settings, update, status } = cm;
  if (!settings.enabled || status !== 'ready') return null;
  const pinned = (state.nodes[state.currentId].annotation?.arrows ?? []).filter((a) => a.color === 'chessmind');

  const pinArrows = () => {
    if (!prediction?.moves.length) return;
    const top = prediction.moves[0].p || 1;
    const arrows: Arrow[] = prediction.moves.map((m) => ({
      from: m.uci.slice(0, 2) as Square,
      to: m.uci.slice(2, 4) as Square,
      color: 'chessmind',
      opacity: Math.round((0.25 + 0.6 * (m.p / top)) * 100) / 100,
    }));
    dispatch({ type: 'ADD_ARROWS', arrows });
  };
  const unpinArrows = () => {
    for (const a of pinned) dispatch({ type: 'TOGGLE_ARROW', arrow: a });
  };

  return (
    <div className="pred-row" data-testid="chessmind-predictions" title={prediction ? `${prediction.tokens} tokens · ${prediction.ms.toFixed(0)} ms per prediction` : undefined}>
      <span className="pred-label">
        <span className="pred-dot" aria-hidden />
        Model
      </span>
      <div className="pred-chips">
        {!standardStart ? (
          <span className="faint">Follows games from the initial position only</span>
        ) : prediction === null ? (
          <span className="faint">Predicting…</span>
        ) : prediction.moves.length === 0 ? (
          <span className="faint">No legal moves</span>
        ) : (
          prediction.moves.map((m) => (
            <button key={m.uci} className="pred-chip" data-uci={m.uci} style={{ '--p': `${Math.round(m.p * 100)}%` } as React.CSSProperties} title="Play this move" onClick={() => onPlayUci(m.uci)}>
              <b>{uciToSan(fen, m.uci)}</b>
              <span>{(m.p * 100).toFixed(0)}%</span>
            </button>
          ))
        )}
      </div>
      <span className="pred-tools">
        {pinned.length > 0 ? (
          <button className="btn btn-ghost btn-icon btn-sm" onClick={unpinArrows} title="Remove the pinned arrows" aria-label="Unpin arrows" data-testid="chessmind-unpin">
            <PinOff size={13} />
          </button>
        ) : (
          <button className="btn btn-ghost btn-icon btn-sm" onClick={pinArrows} disabled={!prediction?.moves.length} title="Pin these arrows to this position" aria-label="Pin arrows" data-testid="chessmind-pin">
            <Pin size={13} />
          </button>
        )}
        <button
          className="btn btn-ghost btn-icon btn-sm"
          aria-pressed={settings.arrows}
          onClick={() => update({ arrows: !settings.arrows })}
          title={settings.arrows ? 'Hide live arrows' : 'Show live arrows on the board'}
          aria-label="Live arrows"
          data-testid="chessmind-arrows"
        >
          <MoveUpRight size={13} />
        </button>
      </span>
    </div>
  );
}
