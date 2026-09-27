/** ChessMind model settings in a popover: model, backend, reasoning, context and chat options. */
import { SlidersHorizontal } from 'lucide-react';
import type { useChessMind } from './useChessMind';
import { CHAT_MAX_THINK_TOKENS } from './useChessMind';
import { MenuDivider, MenuLabel, Popover } from '../ui/Popover';
import { keepArrows } from '../ui/keepArrows';

type ChessMindState = ReturnType<typeof useChessMind>;

export function ChessMindSettings({ cm }: { cm: ChessMindState }) {
  const { settings, update, models, modelId, info, status } = cm;
  const model = models?.find((m) => m.id === modelId);
  return (
    <Popover
      label="ChessMind settings"
      width={300}
      trigger={(p) => (
        <button {...p} className="btn btn-ghost btn-icon btn-sm" title="ChessMind settings" aria-label="ChessMind settings" data-testid="chessmind-settings">
          <SlidersHorizontal size={14} />
        </button>
      )}
    >
      {() => (
        <div className="pop-form" tabIndex={0} onKeyDown={keepArrows}>
          <MenuLabel>ChessMind</MenuLabel>
          <label className="check-row">
            <span className="check-text">
              <span>Model loaded</span>
              <span className="field-hint">
                {status === 'ready' && info ? `${info.backend} · loaded in ${(info.loadMs / 1000).toFixed(1)} s${info.cached ? ' (cached)' : ''}` : 'Runs in this browser; cached after the first download'}
              </span>
            </span>
            <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} data-testid="chessmind-toggle" />
          </label>
          {models && models.length > 0 && (
            <>
              <label className="field">
                <span className="field-label">Model</span>
                <select className="select" value={modelId} onChange={(e) => update({ modelId: e.target.value })} data-testid="chessmind-model">
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {(m.params / 1e6).toFixed(0)}M{m.boards ? ' · board' : ''} · {m.sizeMb} MB
                    </option>
                  ))}
                </select>
                {model?.description && <span className="field-hint">{model.description}</span>}
              </label>
              <label className="field">
                <span className="field-label">Backend</span>
                <select className="select" value={settings.backend} onChange={(e) => update({ backend: e.target.value as typeof settings.backend })} data-testid="chessmind-backend">
                  <option value="auto">Automatic</option>
                  <option value="wasm">WebAssembly (CPU)</option>
                  <option value="webgpu">WebGPU</option>
                </select>
              </label>
            </>
          )}
          <MenuDivider />
          <MenuLabel>Chat</MenuLabel>
          {info?.thinking && (
            <label className="field">
              <span className="field-label">Think before answering</span>
              <select className="select" value={settings.think} onChange={(e) => update({ think: e.target.value as typeof settings.think })} data-testid="chessmind-think-mode">
                <option value="on">Always</option>
                <option value="auto">Model decides</option>
                <option value="off">Never</option>
              </select>
              <span className="field-hint">Hidden reasoning, up to {CHAT_MAX_THINK_TOKENS} tokens, shown collapsed above the answer.</span>
            </label>
          )}
          <label className="field">
            <span className="field-label">
              Text temperature <span className="mono faint">{settings.temperature.toFixed(2)}</span>
            </span>
            <input type="range" min={0} max={1.5} step={0.05} value={settings.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} data-testid="chessmind-temperature" />
            <span className="field-hint">Applies to the words only: move lines always use the model's top choice.</span>
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Send the game moves</span>
              <span className="field-hint">The moves that led here go with each question</span>
            </span>
            <input type="checkbox" checked={settings.sendMoves} onChange={(e) => update({ sendMoves: e.target.checked })} data-testid="chessmind-send-moves" />
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Lines start from this position</span>
              <span className="field-hint">Sends a board snapshot instead of the move list</span>
            </span>
            <input type="checkbox" checked={settings.aboutPosition} onChange={(e) => update({ aboutPosition: e.target.checked })} data-testid="chessmind-about-position" />
          </label>
          <MenuDivider />
          <MenuLabel>Predictions</MenuLabel>
          <label className="check-row">
            <span>Live arrows on the board</span>
            <input type="checkbox" checked={settings.arrows} onChange={(e) => update({ arrows: e.target.checked })} />
          </label>
          <label className="field">
            <span className="field-label">Move context</span>
            <select
              className="select"
              value={String(settings.contextPlies)}
              disabled={!!info && !info.manifest.boards}
              onChange={(e) => update({ contextPlies: e.target.value === 'full' ? 'full' : (Number(e.target.value) as 8 | 16 | 32) })}
              data-testid="chessmind-context"
            >
              <option value="full">Full game</option>
              <option value="8">Last 8 plies + board</option>
              <option value="16">Last 16 plies + board</option>
              <option value="32">Last 32 plies + board</option>
            </select>
            <span className="field-hint">
              {info && !info.manifest.boards
                ? 'This model has no board input, so it always reads the full game.'
                : 'Board-input models see the position directly; a short history keeps deep branches fast.'}
            </span>
          </label>
        </div>
      )}
    </Popover>
  );
}
