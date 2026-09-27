import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { useApp } from '../app/AppContext';
import { BOARD_THEMES, PIECE_SETS, type MotionPref, type ThemePref } from '../ui/settings';
import { Segmented } from '../ui/primitives';
import { EngineConfig } from '../components/EnginePanel';
import { PRESETS, type PresetId } from '../workspace/layout';
import { setOnboardingDismissed } from '../app/onboardingStore';

const PIECE_PREVIEW = import.meta.glob('../assets/pieces/*/wN.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3 className="section-label">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsPanel() {
  const { ui, updateUi, engine, chessmind, layout, toast } = useApp();
  const cm = chessmind.settings;
  return (
    <div className="settings-panel" data-testid="settings-panel">
      <Section title="Appearance">
        <div className="setting-row">
          <span>Theme</span>
          <Segmented<ThemePref>
            label="Theme"
            value={ui.theme}
            onChange={(theme) => updateUi({ theme })}
            options={[
              { value: 'system', label: <><Monitor size={12} /> System</> },
              { value: 'light', label: <><Sun size={12} /> Light</> },
              { value: 'dark', label: <><Moon size={12} /> Dark</> },
            ]}
          />
        </div>
        <div className="setting-block">
          <span>Board</span>
          <div className="swatches" role="radiogroup" aria-label="Board colours">
            {BOARD_THEMES.map((b) => (
              <button key={b.id} role="radio" aria-checked={ui.boardTheme === b.id} className="swatch" onClick={() => updateUi({ boardTheme: b.id })} title={b.name}>
                <span className="swatch-board" style={{ background: `conic-gradient(${b.dark} 0 25%, ${b.light} 0 50%, ${b.dark} 0 75%, ${b.light} 0)` }} />
                <span className="swatch-name">{b.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="setting-block">
          <span>Pieces</span>
          <div className="swatches" role="radiogroup" aria-label="Piece set">
            {PIECE_SETS.map((p) => {
              const src = PIECE_PREVIEW[`../assets/pieces/${p.id}/wN.svg`];
              return (
                <button key={p.id} role="radio" aria-checked={ui.pieceSet === p.id} className="swatch" onClick={() => updateUi({ pieceSet: p.id })} title={p.name}>
                  <span className="swatch-piece">{src ? <img src={src} alt="" /> : <span className="glyph-preview">♞</span>}</span>
                  <span className="swatch-name">{p.name}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="setting-row">
          <span>Move animation</span>
          <Segmented<MotionPref>
            label="Move animation"
            value={ui.motion}
            onChange={(motion) => updateUi({ motion })}
            options={[
              { value: 'normal', label: 'Smooth' },
              { value: 'fast', label: 'Fast' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </div>
        <label className="check-row">
          <span>Coordinates</span>
          <input type="checkbox" checked={ui.coordinates} onChange={(e) => updateUi({ coordinates: e.target.checked })} />
        </label>
        <label className="check-row">
          <span>Show legal moves</span>
          <input type="checkbox" checked={ui.legalMoves} onChange={(e) => updateUi({ legalMoves: e.target.checked })} />
        </label>
        <label className="check-row">
          <span>Help line under the board</span>
          <input type="checkbox" checked={ui.boardHints} onChange={(e) => updateUi({ boardHints: e.target.checked })} />
        </label>
      </Section>

      <Section title="Engine defaults">
        <label className="check-row">
          <span className="check-text">
            <span>Analyse with Stockfish</span>
            <span className="field-hint">Remembered between visits</span>
          </span>
          <input type="checkbox" checked={engine.settings.enabled} onChange={(e) => engine.update({ enabled: e.target.checked })} />
        </label>
        <EngineConfig settings={engine.settings} update={engine.update} available={engine.available} />
      </Section>

      <Section title="ChessMind chat">
        <label className="check-row">
          <span className="check-text">
            <span>Load the model</span>
            <span className="field-hint">Runs in this browser; downloaded once, then cached</span>
          </span>
          <input type="checkbox" checked={cm.enabled} onChange={(e) => chessmind.update({ enabled: e.target.checked })} />
        </label>
        <label className="field">
          <span className="field-label">Backend</span>
          <select value={cm.backend} onChange={(e) => chessmind.update({ backend: e.target.value as typeof cm.backend })}>
            <option value="auto">Automatic</option>
            <option value="wasm">WebAssembly (CPU)</option>
            <option value="webgpu">WebGPU</option>
          </select>
        </label>
        <label className="check-row">
          <span>Live prediction arrows</span>
          <input type="checkbox" checked={cm.arrows} onChange={(e) => chessmind.update({ arrows: e.target.checked })} />
        </label>
        <label className="check-row">
          <span className="check-text">
            <span>Send game moves with questions</span>
            <span className="field-hint">Context for the answer</span>
          </span>
          <input type="checkbox" checked={cm.sendMoves} onChange={(e) => chessmind.update({ sendMoves: e.target.checked })} />
        </label>
        <label className="check-row">
          <span className="check-text">
            <span>Answer lines start from this position</span>
            <span className="field-hint">Sends a board snapshot instead of the move list</span>
          </span>
          <input type="checkbox" checked={cm.aboutPosition} onChange={(e) => chessmind.update({ aboutPosition: e.target.checked })} />
        </label>
      </Section>

      <Section title="Workspace">
        <div className="preset-grid">
          {(Object.keys(PRESETS) as PresetId[]).map((id) => (
            <button key={id} className={`preset-card ${layout.layout.preset === id ? 'active' : ''}`} onClick={() => layout.applyPreset(id)}>
              <strong>{PRESETS[id].name}</strong>
              <span>{PRESETS[id].description}</span>
            </button>
          ))}
        </div>
        <div className="settings-actions">
          <button className="btn btn-sm" onClick={layout.reset}>
            <RotateCcw size={13} /> Reset layout
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setOnboardingDismissed(false);
              toast('Getting-started tips will show above the board after a reload');
            }}
          >
            Show tips again
          </button>
        </div>
      </Section>
    </div>
  );
}
