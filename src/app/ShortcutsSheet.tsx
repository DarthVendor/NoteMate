import { X } from 'lucide-react';
import type { Command } from './commands';
import { Keys } from '../ui/primitives';

const EXTRA: { group: string; items: { title: string; keys: string[][] }[] }[] = [
  {
    group: 'Board',
    items: [
      { title: 'Draw arrow / circle square', keys: [['Right-drag'], ['Right-click']] },
      { title: 'Red, blue, yellow shape', keys: [['Shift'], ['Alt'], ['Ctrl']] },
    ],
  },
];

export function ShortcutsSheet({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const groups = new Map<string, { title: string; keys: string[][] }[]>();
  for (const c of commands) {
    if (!c.shortcuts) continue;
    const g = groups.get(c.group) ?? [];
    g.push({ title: c.title.replace(/^Turn engine (on|off)$/, 'Toggle engine'), keys: c.shortcuts });
    groups.set(c.group, g);
  }
  for (const e of EXTRA) groups.set(e.group, [...(groups.get(e.group) ?? []), ...e.items]);
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal sheet" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()} data-testid="shortcuts-sheet">
        <header className="modal-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} autoFocus aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="shortcuts-grid">
          {[...groups].map(([group, items]) => (
            <section key={group}>
              <h3 className="section-label">{group}</h3>
              <dl>
                {items.map((it) => (
                  <div key={it.title} className="shortcut-row">
                    <dt>{it.title}</dt>
                    <dd>
                      {it.keys.map((k, i) => (
                        <span key={i} className="shortcut-alt">
                          {i > 0 && <span className="faint">or</span>}
                          <Keys keys={k} />
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="hint">Shortcuts are ignored while you type in a text field. Press <Keys keys={['Mod', 'k']} /> to search every command.</p>
      </div>
    </div>
  );
}
