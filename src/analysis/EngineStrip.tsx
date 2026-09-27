/*
 * Compact engine strip for the Analysis panel: on/off, the evaluation, the best line and the depth on one row.
 * Expanding shows every MultiPV line; the settings (build, threads, lines, depth, hash) are in a popover.
 */
import { ChevronDown, Play, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../app/AppContext';
import { EngineConfig } from '../components/EnginePanel';
import { formatScore, pvTokens } from '../engine/format';
import { ENGINE_BUILDS } from '../engine/engines';
import { keepArrows } from '../ui/keepArrows';
import { MenuLabel, Popover } from '../ui/Popover';
import { ProgressBar } from '../ui/primitives';

const isNeg = (score: string) => score.startsWith('-') || score.startsWith('#-');

export function EngineStrip({ expanded, onToggleExpanded }: { expanded: boolean; onToggleExpanded: () => void }) {
  const { engine, fen, playUci } = useApp();
  const { settings, update, status, lines, progress, error, engineName, paused } = engine;
  const side = fen.split(' ')[1] as 'w' | 'b';
  const build = ENGINE_BUILDS.find((b) => b.id === settings.engineId);
  const best = lines[0];
  const score = best ? formatScore(best, side) : null;
  const on = settings.enabled;
  const name = status === 'ready' && engineName ? engineName : (build?.name ?? 'Stockfish');

  let body: React.ReactNode;
  if (!on) {
    body = (
      <span className="es-off">
        <span className="faint">Engine off</span>
        <button className="btn btn-sm es-start" onClick={() => update({ enabled: true })} data-testid="engine-start" title="Start Stockfish (E)">
          <Play size={12} /> Start
        </button>
      </span>
    );
  } else if (status === 'loading') {
    body = <span className="faint">{progress !== null && progress < 100 ? `Downloading ${build?.sizeMb ?? ''} MB · ${progress}%` : build && build.sizeMb >= 50 ? 'Compiling, this can take a minute…' : 'Starting…'}</span>;
  } else if (status === 'error') {
    body = <span className="es-err">Could not start</span>;
  } else if (paused) {
    body = <span className="faint">Paused while Simulate runs</span>;
  } else if (!best) {
    body = <span className="faint">Thinking…</span>;
  } else {
    body = (
      <button className="es-pv" onClick={() => playUci(best.pv[0])} title="Play the best move" data-testid="engine-best">
        {pvTokens(fen, best.pv).slice(0, 10).map((t, i) => (
          <span key={i} className={i === 0 ? 'pv-first' : ''}>
            {t.num && <span className="pv-num">{t.num}</span>}
            {t.san}{' '}
          </span>
        ))}
      </button>
    );
  }

  return (
    <section className="es" data-testid="engine-strip" aria-label="Engine">
      <div className="es-row">
        <input type="checkbox" checked={on} onChange={(e) => update({ enabled: e.target.checked })} title={`${on ? 'Stop' : 'Start'} ${name} (E)`} aria-label="Engine on" data-testid="engine-toggle" />
        <span className={`es-eval ${score ? (isNeg(score) ? 'neg' : 'pos') : 'none'}`} data-testid="engine-eval" title={on ? name : undefined}>
          {on && score && !paused ? score : '–'}
        </span>
        <div className="es-body">{body}</div>
        {on && status === 'ready' && best && !paused && (
          <span className="es-depth" title={`${name}${best.nps ? ` · ${(best.nps / 1000).toFixed(0)}k nodes/s` : ''}`} data-testid="engine-depth">
            d{best.depth}
          </span>
        )}
        {on && (
          <button className="btn btn-ghost btn-icon btn-sm es-expand" aria-expanded={expanded} onClick={onToggleExpanded} title={expanded ? 'Show only the best line' : 'Show all engine lines'} aria-label="All engine lines" data-testid="engine-expand">
            <ChevronDown size={14} />
          </button>
        )}
        <Popover
          label="Engine settings"
          width={320}
          trigger={(p) => (
            <button {...p} className="btn btn-ghost btn-icon btn-sm" title="Engine settings" aria-label="Engine settings" data-testid="engine-settings">
              <SlidersHorizontal size={14} />
            </button>
          )}
        >
          {() => (
            <div className="pop-form" tabIndex={0} onKeyDown={keepArrows}>
              <MenuLabel>{name}</MenuLabel>
              <EngineConfig settings={settings} update={update} available={engine.available} />
            </div>
          )}
        </Popover>
      </div>
      {on && status === 'loading' && <ProgressBar value={progress !== null && progress < 100 ? progress : null} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {on && expanded && status === 'ready' && !paused && (
        <ol className="engine-lines es-lines" aria-label="Engine lines" data-testid="engine-lines">
          {lines.map((l) => {
            const s = formatScore(l, side);
            return (
              <li key={l.multipv} className="engine-line">
                <button className={`engine-score ${isNeg(s) ? 'neg' : 'pos'}`} title="Play the first move of this line" onClick={() => playUci(l.pv[0])}>
                  {s}
                </button>
                <span className="engine-pv">
                  {pvTokens(fen, l.pv).map((t, i) => (
                    <span key={i} className={i === 0 ? 'pv-first' : ''}>
                      {t.num && <span className="pv-num">{t.num}</span>}
                      {t.san}{' '}
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
          <li className="es-meta">
            {name}
            {best?.nps ? ` · ${(best.nps / 1000).toFixed(0)}k nodes/s` : ''} · {settings.multiPv} line{settings.multiPv === 1 ? '' : 's'}
            {settings.depth ? ` · depth ≤ ${settings.depth}` : ''}
          </li>
        </ol>
      )}
    </section>
  );
}
