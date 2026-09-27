import { ClipboardCopy, FilePlus2, Keyboard, LayoutTemplate, Moon, RotateCcw, Search, Settings2, Sun, Upload } from 'lucide-react';
import { useApp } from './AppContext';
import { allPanels } from '../workspace/registry';
import { hidePanel, isVisible, PRESETS, type PresetId } from '../workspace/layout';
import { MenuDivider, MenuItem, MenuLabel, Popover } from '../ui/Popover';
import { Keys } from '../ui/primitives';

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="5" fill="currentColor" />
      <rect x="5" y="5" width="7" height="7" fill="var(--surface)" opacity="0.92" />
      <rect x="12" y="12" width="7" height="7" fill="var(--surface)" opacity="0.92" />
      <path d="M19 5v4.5L14.5 5z" fill="var(--surface)" opacity="0.55" />
    </svg>
  );
}

export function TopBar({ confirmingNew, compact }: { confirmingNew: boolean; compact: boolean }) {
  const app = useApp();
  const { layout } = app;
  const presetName = layout.layout.preset === 'custom' ? 'Custom' : PRESETS[layout.layout.preset].name;
  const dark = app.ui.theme === 'dark' || (app.ui.theme === 'system' && document.documentElement.dataset.theme === 'dark');

  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">NoteMate</span>
      </div>

      <nav className="topbar-actions" aria-label="Game">
        <button className="btn btn-ghost" onClick={app.openImport} title="Import a game from PGN (I)">
          <Upload size={15} />
          {!compact && 'Import'}
        </button>
        <button className="btn btn-ghost" onClick={() => app.exportPgn()} title="Copy the whole game, with variations and notes, as PGN">
          <ClipboardCopy size={15} />
          {!compact && 'Copy PGN'}
        </button>
        <button className={`btn ${confirmingNew ? 'btn-danger' : 'btn-ghost'}`} onClick={app.newGame} title="Start a new game" data-testid="new-game">
          <FilePlus2 size={15} />
          {confirmingNew ? 'Discard this game?' : !compact && 'New'}
        </button>
      </nav>

      <span className="topbar-spacer" />

      <button className="palette-trigger" onClick={app.openPalette} title="Command palette" data-testid="palette-trigger">
        <Search size={14} />
        {!compact && <span>Search commands</span>}
        <Keys keys={['Mod', 'k']} />
      </button>

      <div className="topbar-actions">
        <Popover
          label="Layout"
          width={290}
          trigger={(p) => (
            <button {...p} className="btn btn-ghost" title="Layout presets and panels" data-testid="panels-menu">
              <LayoutTemplate size={15} />
              {!compact && <span>{presetName}</span>}
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuLabel>Layout presets</MenuLabel>
              {(Object.keys(PRESETS) as PresetId[]).map((id) => (
                <MenuItem
                  key={id}
                  checked={layout.layout.preset === id}
                  onClick={() => {
                    layout.applyPreset(id);
                    close();
                  }}
                >
                  <span className="menu-two">
                    <span>{PRESETS[id].name}</span>
                    <span className="faint">{PRESETS[id].description}</span>
                  </span>
                </MenuItem>
              ))}
              <MenuDivider />
              <MenuLabel>Panels</MenuLabel>
              {allPanels().map((p) => {
                const Icon = p.icon;
                const visible = isVisible(layout.layout, p.id);
                return (
                  <MenuItem key={p.id} icon={<Icon size={14} />} checked={visible} onClick={() => (visible ? layout.edit((l) => hidePanel(l, p.id)) : app.revealPanel(p.id))}>
                    {p.title}
                  </MenuItem>
                );
              })}
              <MenuDivider />
              <MenuItem
                icon={<RotateCcw size={14} />}
                onClick={() => {
                  layout.reset();
                  close();
                }}
              >
                Reset layout
              </MenuItem>
              <p className="menu-foot">Drag a tab to dock it on another side, or onto another panel to tab them together.</p>
            </>
          )}
        </Popover>
        <button className="btn btn-ghost btn-icon" onClick={() => app.updateUi({ theme: dark ? 'light' : 'dark' })} title={`Switch to ${dark ? 'light' : 'dark'} theme (T)`} aria-label="Toggle theme">
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="btn btn-ghost btn-icon" onClick={() => app.revealPanel('settings')} title="Settings (,)" aria-label="Settings" data-testid="open-settings">
          <Settings2 size={16} />
        </button>
        {!compact && (
          <button className="btn btn-ghost btn-icon" onClick={app.openShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            <Keyboard size={16} />
          </button>
        )}
      </div>
    </header>
  );
}
