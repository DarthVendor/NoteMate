import { Chess } from 'chess.js';
import type { EngineLine } from '../engine/EngineClient';
import { CUSTOM_ENGINE_ID, ENGINE_BUILDS, type EngineAvailability, type EngineSettings } from '../engine/engines';
import type { EngineStatus } from '../engine/useEngine';

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

/** Score from White's point of view, formatted like "+0.35" or "#-3". */
export function formatScore(line: EngineLine, sideToMove: 'w' | 'b'): string {
  const sign = sideToMove === 'w' ? 1 : -1;
  if (line.mate !== undefined) {
    const m = line.mate * sign;
    return m > 0 ? `#${m}` : `#-${Math.abs(m)}`;
  }
  const pawns = ((line.cp ?? 0) * sign) / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(2);
}

/** Convert a UCI principal variation to SAN using the given starting position. */
function pvToSan(fen: string, pv: string[]): string {
  const chess = new Chess(fen);
  const parts: string[] = [];
  for (const uci of pv) {
    const moveNo = chess.moveNumber();
    const white = chess.turn() === 'w';
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] as 'q' | 'r' | 'b' | 'n' | undefined });
      if (white) parts.push(`${moveNo}.`);
      else if (parts.length === 0) parts.push(`${moveNo}...`);
      parts.push(m.san);
    } catch {
      break;
    }
  }
  return parts.join(' ');
}

export function EnginePanel({ fen, settings, update, status, engineName, error, lines, available, progress, onPlayUci }: Props) {
  const sideToMove = fen.split(' ')[1] as 'w' | 'b';
  const build = ENGINE_BUILDS.find((b) => b.id === settings.engineId);
  const depth = lines[0]?.depth ?? 0;
  const nps = lines[0]?.nps;

  return (
    <div className="engine-panel">
      <header className="engine-header">
        <label className="switch">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span>Engine</span>
        </label>
        <span className={`engine-status status-${status}`}>
          {status === 'off' && 'off'}
          {status === 'loading' &&
            (progress !== null && progress < 100
              ? `downloading ${build?.sizeMb ?? ''} MB · ${progress}%`
              : build && build.sizeMb >= 50
                ? `loading ${build.sizeMb} MB, this can take a minute…`
                : 'loading…')}
          {status === 'ready' && `${engineName || 'ready'} · depth ${depth}${nps ? ` · ${(nps / 1000).toFixed(0)}k nps` : ''}`}
          {status === 'error' && 'error'}
        </span>
      </header>

      <div className="engine-controls">
        <label>
          Model
          <select value={settings.engineId} onChange={(e) => update({ engineId: e.target.value, threads: 1 })}>
            {ENGINE_BUILDS.map((b) => {
              const missing = available !== null && available[b.id] === 'missing';
              const needsIsolation = b.threaded && !isolated;
              return (
                <option key={b.id} value={b.id} disabled={missing || needsIsolation}>
                  {b.name} · {b.sizeMb} MB
                  {missing ? ' (not included in this hosted copy)' : needsIsolation ? ' (needs cross-origin isolation)' : ''}
                </option>
              );
            })}
            <option value={CUSTOM_ENGINE_ID}>Custom UCI worker URL…</option>
          </select>
        </label>
        {settings.engineId === CUSTOM_ENGINE_ID ? (
          <label>
            Worker script URL
            <input
              type="url"
              value={settings.customUrl}
              placeholder="https://…/engine.js (must speak UCI over postMessage)"
              onChange={(e) => update({ customUrl: e.target.value })}
            />
          </label>
        ) : (
          build && <p className="hint engine-desc">{build.description}</p>
        )}

        <label>
          Engine server <span className="label-hint">(optional, e.g. http://localhost:4174 from npm run host)</span>
          <input
            id="engine-base"
            type="url"
            value={settings.engineBase}
            placeholder="same origin (engines/ next to the app)"
            onChange={(e) => update({ engineBase: e.target.value })}
          />
        </label>

        <div className="engine-numbers">
          <label>
            Threads
            <input
              type="number"
              min={1}
              max={cores}
              value={settings.threads}
              disabled={!(build?.threaded ?? true)}
              onChange={(e) => update({ threads: Math.max(1, Math.min(cores, Number(e.target.value) || 1)) })}
            />
          </label>
          <label>
            Lines
            <input type="number" min={1} max={8} value={settings.multiPv} onChange={(e) => update({ multiPv: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />
          </label>
          <label>
            Depth
            <input type="number" min={0} max={60} value={settings.depth} title="0 = unlimited" onChange={(e) => update({ depth: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
          </label>
          <label>
            Hash MB
            <input type="number" min={16} max={1024} step={16} value={settings.hashMb} onChange={(e) => update({ hashMb: Math.max(16, Math.min(1024, Number(e.target.value) || 16)) })} />
          </label>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {settings.enabled && (
        <ol className="engine-lines">
          {lines.length === 0 && status === 'ready' && <li className="hint">Thinking…</li>}
          {lines.map((l) => (
            <li key={l.multipv} className="engine-line">
              <button className="engine-score" title="Play the first move of this line" onClick={() => onPlayUci(l.pv[0])}>
                {formatScore(l, sideToMove)}
              </button>
              <span className="engine-pv">{pvToSan(fen, l.pv)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
