import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import type { Command } from './commands';
import { Keys } from '../ui/primitives';

/** Subsequence match with a bonus for word starts; 0 = no match. */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || t[idx - 1] === ' ' ? 50 : 0);
  let ti = 0;
  let s = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return 0;
    s += f === 0 || t[f - 1] === ' ' ? 3 : 1;
    ti = f + 1;
  }
  return s;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: Math.max(score(query, c.title), score(query, `${c.group} ${c.keywords ?? ''}`) * 0.6) }))
      .filter((x) => x.s > 0);
    if (query) scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.c);
  }, [commands, query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // Let the palette unmount (and focus return) before the command runs.
    setTimeout(c.run, 0);
  };

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()} data-testid="command-palette">
        <div className="palette-search">
          <Search size={16} className="faint" />
          <input
            autoFocus
            value={query}
            placeholder="Type a command or search…"
            aria-label="Search commands"
            aria-controls="palette-list"
            aria-activedescendant={results[sel] ? `cmd-${results[sel].id}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setSel((s) => Math.min(results.length - 1, s + 1));
              else if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
              else if (e.key === 'Enter') run(results[sel]);
              else if (e.key === 'Escape') onClose();
              else return;
              e.preventDefault();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No commands match “{query}”.</div>}
          {results.map((c, i) => {
            const Icon = c.icon;
            const header = !query && c.group !== results[i - 1]?.group ? c.group : null;
            return (
              <div key={c.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={i === sel}
                  data-index={i}
                  className={`palette-item ${i === sel ? 'sel' : ''}`}
                  onPointerMove={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  <span className="palette-icon">{Icon && <Icon size={15} strokeWidth={1.8} />}</span>
                  <span className="palette-title">{c.title}</span>
                  {query && <span className="palette-cat">{c.group}</span>}
                  {c.shortcuts?.[0] && <Keys keys={c.shortcuts[0]} />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><Keys keys={['ArrowUp', 'ArrowDown']} /> navigate</span>
          <span><CornerDownLeft size={12} /> run</span>
        </div>
      </div>
    </div>
  );
}
