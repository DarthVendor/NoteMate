import type { ReactNode } from 'react';
import { getPanel } from './registry';
import { orderedPanels } from './layout';
import type { LayoutApi } from './useLayout';

/** Phone layout: the board on top, then the visible panels as one row of tabs. */
export function MobileWorkspace({ api, center, active, setActive }: { api: LayoutApi; center: ReactNode; active: string | null; setActive: (id: string) => void }) {
  const ids = orderedPanels(api.layout);
  const current = active && ids.includes(active) ? active : ids[0];
  return (
    <div className="mobile-ws">
      <div className="mobile-board">{center}</div>
      {ids.length > 0 && (
        <>
          <div className="mobile-tabs" role="tablist" aria-label="Panels">
            {ids.map((id) => {
              const def = getPanel(id)!;
              const Icon = def.icon;
              return (
                <button key={id} role="tab" id={`tab-${id}`} aria-selected={id === current} aria-controls={`panel-${id}`} className={`dock-tab ${id === current ? 'active' : ''}`} onClick={() => setActive(id)} data-testid={`tab-${id}`}>
                  <Icon size={14} strokeWidth={1.8} />
                  <span>{def.title}</span>
                </button>
              );
            })}
          </div>
          {ids.map((id) => {
            const C = getPanel(id)!.component;
            return (
              <div key={id} role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="dock-panel mobile-panel" hidden={id !== current} data-panel-id={id}>
                <C />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
