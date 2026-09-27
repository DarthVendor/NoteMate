import { Cpu, Play, SlidersHorizontal } from 'lucide-react';
import type { EngineLine } from '../engine/EngineClient';
import { CUSTOM_ENGINE_ID, ENGINE_BUILDS, type EngineAvailability, type EngineSettings } from '../engine/engines';
import type { EngineStatus } from '../engine/useEngine';
import { formatScore, pvTokens } from '../engine/format';
import { EmptyState, ProgressBar } from '../ui/primitives';

interface Props {
  fen: string;
  settings: EngineSettings;
  update: (patch: Partial<EngineSettings>) => void;
  status: EngineStatus;
  engineName: string;
  error: string | null;
  lines: EngineLine[];
  available: Record<string, EngineAvailability> | null;
  progress: number | null;
  onPlayUci: (uci: string) => void;
}

const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1;

/** Engine settings that also appear in the Settings panel. */
export function EngineConfig({ settings, update, available }: Pick<Props, 'settings' | 'update' | 'available'>) {
  const build = ENGINE_BUILDS.find((b) => b.id === settings.engineId);
  return (
    <div className="engine-controls">
      <label className="field">
        <span className="field-label">Engine build</span>
        <select value={settings.engineId} onChange={(e) => update({ engineId: e.target.value, threads: 1 })}>
          {ENGINE_BUILDS.map((b) => {
            const missing = available !== null && available[b.id] === 'missing';
            const needsIsolation = b.threaded && !isolated;
            return (
              <option key={b.id} value={b.id} disabled={missing || needsIsolation}>
                {b.name} · {b.sizeMb} MB
                {missing ? ' (not on this server)' : needsIsolation ? ' (needs cross-origin isolation)' : ''}
              </option>
            );
          })}
          <option value={CUSTOM_ENGINE_ID}>Custom UCI worker URL…</option>
        </select>
      </label>
      {settings.engineId === CUSTOM_ENGINE_ID ? (
        <label className="field">
          <span className="field-label">Worker script URL</span>
          <input type="url" value={settings.customUrl} placeholder="https://…/engine.js (UCI over postMessage)" onChange={(e) => update({ customUrl: e.target.value })} />
        </label>
      ) : (
        build && <p className="field-hint">{build.description}</p>
      )}

      <label className="field">
        <span className="field-label">Engine server</span>
        <input id="engine-base" type="url" value={settings.engineBase} placeholder="Same origin (engines/ next to the app)" onChange={(e) => update({ engineBase: e.target.value })} />
        <span className="field-hint">Optional. With <code>npm run host</code> or <code>./start.sh</code> use http://localhost:4174 for the Full builds.</span>
      </label>

      <div className="engine-numbers">
        <label className="field">
          <span className="field-label">Threads</span>
          <input type="number" min={1} max={cores} value={settings.threads} disabled={!(build?.threaded ?? true)} onChange={(e) => update({ threads: Math.max(1, Math.min(cores, Number(e.target.value) || 1)) })} />
        </label>
        <label className="field">
          <span className="field-label">Lines</span>
          <input type="number" min={1} max={8} value={settings.multiPv} onChange={(e) => update({ multiPv: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />
        </label>
        <label className="field">
          <span className="field-label">Depth</span>
          <input type="number" min={0} max={60} value={settings.depth} title="0 = unlimited" onChange={(e) => update({ depth: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
        </label>
        <label className="field">
          <span className="field-label">Hash MB</span>
          <input type="number" min={16} max={1024} step={16} value={settings.hashMb} onChange={(e) => update({ hashMb: Math.max(16, Math.min(1024, Number(e.target.value) || 16)) })} />
        </label>
      </div>
    </div>
  );
}

export function EnginePanel({ fen, settings, update, status, engineName, error, lines, available, progress, onPlayUci }: Props) {
  const sideToMove = fen.split(' ')[1] as 'w' | 'b';
  const build = ENGINE_BUILDS.find((b) => b.id === settings.engineId);
  const depth = lines[0]?.depth ?? 0;
  const nps = lines[0]?.nps;

  let statusText = '';
  if (status === 'loading')
    statusText = progress !== null && progress < 100 ? `Downloading ${build?.sizeMb ?? ''} MB · ${progress}%` : build && build.sizeMb >= 50 ? `Compiling ${build.sizeMb} MB, this can take a minute…` : 'Loading…';
  else if (status === 'ready') statusText = `depth ${depth}${nps ? ` · ${(nps / 1000).toFixed(0)}k nps` : ''}`;
  else if (status === 'error') statusText = 'Could not start';

  return (
    <div className="engine-panel" data-testid="engine-panel">
      <header className="engine-header">
        <label className="switch">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} data-testid="engine-toggle" />
          <span>{status === 'ready' && engineName ? engineName : (build?.name ?? 'Stockfish')}</span>
        </label>
        <span className={`engine-status status-${status}`}>
          {status === 'loading' && <span className="spinner" aria-hidden />}
          {statusText}
        </span>
      </header>

      {status === 'loading' && <ProgressBar value={progress !== null && progress < 100 ? progress : null} />}
      {error && <p className="error" role="alert">{error}</p>}

      {!settings.enabled && (
        <EmptyState
          icon={Cpu}
          title="Engine is off"
          actions={
            <button className="btn btn-sm btn-primary" onClick={() => update({ enabled: true })} data-testid="engine-start">
              <Play size={13} /> Start {build?.name ?? 'engine'}
            </button>
          }
        >
          Stockfish runs in your browser and shows its best lines, an evaluation bar and a blue arrow for its top move. <span className="faint">Shortcut: E</span>
        </EmptyState>
      )}

      {settings.enabled && (
        <ol className="engine-lines" aria-label="Engine lines">
          {lines.length === 0 && status === 'ready' && <li className="hint">Thinking…</li>}
          {lines.map((l) => {
            const score = formatScore(l, sideToMove);
            return (
              <li key={l.multipv} className="engine-line">
                <button className={`engine-score ${score.startsWith('-') || score.startsWith('#-') ? 'neg' : 'pos'}`} title="Play the first move of this line" onClick={() => onPlayUci(l.pv[0])}>
                  {score}
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
        </ol>
      )}

      <details className="disclosure">
        <summary>
          <SlidersHorizontal size={13} /> Engine settings
        </summary>
        <EngineConfig settings={settings} update={update} available={available} />
      </details>
    </div>
  );
}
