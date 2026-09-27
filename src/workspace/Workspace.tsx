import { createContext, Fragment, useContext, useState, type DragEvent, type ReactNode } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ChevronDown, ChevronUp, EyeOff, MoreHorizontal, Plus, SplitSquareVertical } from 'lucide-react';
import { getPanel, type Zone } from './registry';
import {
  activate, hiddenPanels, hidePanel, moveStack, movePanel, setStackSizes, setZoneSizes, ZONE_LABEL, ZONES,
  type DropTarget, type Layout, type Stack,
} from './layout';
import type { LayoutApi } from './useLayout';
import { MenuDivider, MenuItem, MenuLabel, Popover } from '../ui/Popover';

const MIME = 'application/x-notemate-panel';
const DragCtx = createContext<{ dragging: string | null; setDragging: (id: string | null) => void }>({ dragging: null, setDragging: () => {} });

const ZONE_ICON = { left: ArrowLeftToLine, right: ArrowRightToLine, bottom: ArrowDownToLine };

function readDrag(e: DragEvent): string | null {
  return e.dataTransfer.types.includes(MIME) ? e.dataTransfer.getData(MIME) || null : null;
}

/** Evenly fill in stack sizes that were never set. */
function stackLayout(stacks: Stack[]): Record<string, number> {
  const known = stacks.filter((s) => s.size !== undefined).reduce((a, s) => a + s.size!, 0);
  const unknown = stacks.filter((s) => s.size === undefined).length;
  const each = unknown ? Math.max(10, (100 - known) / unknown) : 0;
  const raw = Object.fromEntries(stacks.map((s) => [s.id, s.size ?? each]));
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (v / total) * 100]));
}

function PanelStack({ stack, zone, index, count, api }: { stack: Stack; zone: Zone; index: number; count: number; api: LayoutApi }) {
  const { dragging, setDragging } = useContext(DragCtx);
  const [over, setOver] = useState<'before' | 'after' | 'tab' | null>(null);
  const [tabOver, setTabOver] = useState<number | null>(null);
  const layout = api.layout;
  const active = getPanel(stack.active);
  const vertical = zone !== 'bottom';

  const drop = (target: DropTarget) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = readDrag(e);
    setOver(null);
    setTabOver(null);
    setDragging(null);
    if (id) api.edit((l) => movePanel(l, id, target));
  };
  const allow = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(MIME)) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return true;
  };

  const onBodyDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!allow(e)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = vertical ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    setOver(f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'tab');
  };
  const bodyTarget: DropTarget =
    over === 'before' ? { kind: 'split', zone, index } : over === 'after' ? { kind: 'split', zone, index: index + 1 } : { kind: 'tab', stackId: stack.id };

  const hidden = hiddenPanels(layout);
  const otherZones = ZONES.filter((z) => z !== zone);

  return (
    <section className="dock-stack" data-stack={stack.id} aria-label={`${stack.panels.map((p) => getPanel(p)?.title).join(', ')} panel group`}>
      <header
        className={`dock-tabs ${tabOver === stack.panels.length ? 'drop-end' : ''}`}
        onDragOver={(e) => allow(e) && setTabOver(stack.panels.length)}
        onDragLeave={() => setTabOver(null)}
        onDrop={drop({ kind: 'tab', stackId: stack.id })}
      >
        <div className="dock-tablist" role="tablist">
          {stack.panels.map((pid, i) => {
            const def = getPanel(pid)!;
            const Icon = def.icon;
            const selected = pid === stack.active;
            return (
              <button
                key={pid}
                role="tab"
                id={`tab-${pid}`}
                aria-selected={selected}
                aria-controls={`panel-${pid}`}
                tabIndex={selected ? 0 : -1}
                className={`dock-tab ${selected ? 'active' : ''} ${tabOver === i ? 'drop-before' : ''}`}
                draggable
                title={`${def.title}: drag to move, dock or tab with another panel`}
                data-testid={`tab-${pid}`}
                onClick={() => api.edit((l) => activate(l, stack.id, pid))}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  e.preventDefault();
                  e.stopPropagation();
                  const next = stack.panels[(i + (e.key === 'ArrowRight' ? 1 : -1) + stack.panels.length) % stack.panels.length];
                  api.edit((l) => activate(l, stack.id, next));
                  requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData(MIME, pid);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragging(pid);
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  if (allow(e)) {
                    e.stopPropagation();
                    setTabOver(i);
                  }
                }}
                onDrop={drop({ kind: 'tab', stackId: stack.id, index: i })}
              >
                <Icon size={14} strokeWidth={1.8} />
                <span>{def.title}</span>
                <TabStatus pid={pid} />
              </button>
            );
          })}
        </div>
        <Popover
          label={`${active?.title} panel options`}
          width={240}
          trigger={(p) => (
            <button {...p} className="btn btn-ghost btn-icon btn-sm dock-menu-btn" title="Panel options: move, dock, hide" data-testid={`stack-menu-${stack.active}`}>
              <MoreHorizontal size={15} />
            </button>
          )}
        >
          {(close) => {
            const run = (fn: (l: Layout) => Layout) => () => {
              api.edit(fn);
              close();
            };
            return (
              <>
                <MenuLabel>{active?.title}</MenuLabel>
                {otherZones.map((z) => {
                  const Icon = ZONE_ICON[z];
                  return (
                    <MenuItem key={z} icon={<Icon size={14} />} onClick={run((l) => movePanel(l, stack.active, { kind: 'split', zone: z }))}>
                      Dock {ZONE_LABEL[z].toLowerCase()}
                    </MenuItem>
                  );
                })}
                {stack.panels.length > 1 && (
                  <MenuItem icon={<SplitSquareVertical size={14} />} onClick={run((l) => movePanel(l, stack.active, { kind: 'split', zone, index: index + 1 }))}>
                    Split into its own group
                  </MenuItem>
                )}
                {count > 1 && index > 0 && (
                  <MenuItem icon={<ChevronUp size={14} />} onClick={run((l) => moveStack(l, stack.id, -1))}>
                    Move group {vertical ? 'up' : 'left'}
                  </MenuItem>
                )}
                {count > 1 && index < count - 1 && (
                  <MenuItem icon={<ChevronDown size={14} />} onClick={run((l) => moveStack(l, stack.id, 1))}>
                    Move group {vertical ? 'down' : 'right'}
                  </MenuItem>
                )}
                <MenuItem icon={<EyeOff size={14} />} onClick={run((l) => hidePanel(l, stack.active))}>
                  Hide {active?.title}
                </MenuItem>
                {hidden.length > 0 && (
                  <>
                    <MenuDivider />
                    <MenuLabel>Add as tab</MenuLabel>
                    {hidden.map((p) => {
                      const Icon = p.icon;
                      return (
                        <MenuItem key={p.id} icon={<Icon size={14} />} onClick={run((l) => movePanel(l, p.id, { kind: 'tab', stackId: stack.id }))} hint={<Plus size={12} />}>
                          {p.title}
                        </MenuItem>
                      );
                    })}
                  </>
                )}
              </>
            );
          }}
        </Popover>
      </header>
      <div className="dock-body">
        {stack.panels.map((pid) => {
          const def = getPanel(pid)!;
          const C = def.component;
          return (
            <div key={pid} role="tabpanel" id={`panel-${pid}`} aria-labelledby={`tab-${pid}`} className="dock-panel" hidden={pid !== stack.active} data-panel-id={pid}>
              <C />
            </div>
          );
        })}
        {dragging && (
          <div
            className={`dock-drop ${vertical ? 'v' : 'h'} ${over ? `over-${over}` : ''}`}
            onDragOver={onBodyDragOver}
            onDragLeave={() => setOver(null)}
            onDrop={drop(bodyTarget)}
          >
            <div className="dock-drop-hint">{over === 'tab' ? 'Add as tab' : over ? 'Split here' : ''}</div>
          </div>
        )}
      </div>
    </section>
  );
}

function TabStatus({ pid }: { pid: string }) {
  const useStatus = getPanel(pid)?.useStatus;
  return useStatus ? <TabStatusInner useStatus={useStatus} /> : null;
}
function TabStatusInner({ useStatus }: { useStatus: () => 'on' | 'busy' | 'err' | null }) {
  const s = useStatus();
  return s ? <span className={`status-dot ${s}`} aria-hidden /> : null;
}

function ZoneView({ zone, api }: { zone: Zone; api: LayoutApi }) {
  const stacks = api.layout.zones[zone].stacks;
  const vertical = zone !== 'bottom';
  return (
    <Group
      key={stacks.map((s) => s.id).join('|')}
      orientation={vertical ? 'vertical' : 'horizontal'}
      className={`dock-zone zone-${zone}`}
      defaultLayout={stackLayout(stacks)}
      onLayoutChanged={(l, meta) => meta.isUserInteraction && api.edit((x) => setStackSizes(x, zone, meta.requestedLayout ?? l))}
    >
      {stacks.map((s, i) => {
        const min = Math.max(...s.panels.map((p) => (vertical ? 140 : (getPanel(p)?.minSize ?? 240))));
        return (
          <Fragment key={s.id}>
            {i > 0 && <Separator className="dock-sep" />}
            <Panel id={s.id} minSize={`${min}px`}>
              <PanelStack stack={s} zone={zone} index={i} count={stacks.length} api={api} />
            </Panel>
          </Fragment>
        );
      })}
    </Group>
  );
}

/** Edge strips shown while a tab is dragged, to dock into a zone (also when it is empty). */
function EdgeDrop({ zone, api }: { zone: Zone; api: LayoutApi }) {
  const { dragging, setDragging } = useContext(DragCtx);
  const [over, setOver] = useState(false);
  if (!dragging) return null;
  const Icon = ZONE_ICON[zone];
  return (
    <div
      className={`edge-drop edge-${zone} ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        const id = readDrag(e);
        setOver(false);
        setDragging(null);
        if (id) api.edit((l) => movePanel(l, id, { kind: 'split', zone, index: zone === 'left' ? 0 : undefined }));
      }}
    >
      <Icon size={14} /> Dock {ZONE_LABEL[zone].toLowerCase()}
    </div>
  );
}

/** Desktop workspace: resizable, dockable zones around `center` (the board). */
export function Workspace({ api, center }: { api: LayoutApi; center: ReactNode }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const { zones } = api.layout;
  const has = (z: Zone) => zones[z].stacks.length > 0;
  const minPx = (z: Zone) => Math.max(240, ...zones[z].stacks.flatMap((s) => s.panels.map((p) => getPanel(p)?.minSize ?? 240)));
  const hLayout: Record<string, number> = {};
  if (has('left')) hLayout.left = zones.left.size;
  if (has('right')) hLayout.right = zones.right.size;
  hLayout.center = 100 - (hLayout.left ?? 0) - (hLayout.right ?? 0);
  const vLayout: Record<string, number> = has('bottom') ? { board: 100 - zones.bottom.size, bottom: zones.bottom.size } : { board: 100 };

  return (
    <DragCtx.Provider value={{ dragging, setDragging }}>
      <div className={`workspace ${dragging ? 'is-dragging' : ''}`} onDragEnd={() => setDragging(null)}>
        <Group
          key={`h${has('left')}${has('right')}`}
          className="ws-h"
          orientation="horizontal"
          defaultLayout={hLayout}
          onLayoutChanged={(l, meta) => {
            if (!meta.isUserInteraction) return;
            const r = meta.requestedLayout ?? l;
            api.edit((x) => setZoneSizes(x, { left: r.left, right: r.right }));
          }}
        >
          {has('left') && (
            <>
              <Panel id="left" minSize={`${minPx('left')}px`} maxSize="45%" groupResizeBehavior="preserve-pixel-size">
                <ZoneView zone="left" api={api} />
              </Panel>
              <Separator className="dock-sep" />
            </>
          )}
          <Panel id="center" minSize="320px">
            <Group
              key={`v${has('bottom')}`}
              className="ws-v"
              orientation="vertical"
              defaultLayout={vLayout}
              onLayoutChanged={(l, meta) => {
                if (!meta.isUserInteraction) return;
                const r = meta.requestedLayout ?? l;
                if (r.bottom) api.edit((x) => setZoneSizes(x, { bottom: r.bottom }));
              }}
            >
              <Panel id="board" minSize="260px">
                {center}
              </Panel>
              {has('bottom') && (
                <>
                  <Separator className="dock-sep" />
                  <Panel id="bottom" minSize="160px" maxSize="70%">
                    <ZoneView zone="bottom" api={api} />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          {has('right') && (
            <>
              <Separator className="dock-sep" />
              <Panel id="right" minSize={`${minPx('right')}px`} maxSize="50%" groupResizeBehavior="preserve-pixel-size">
                <ZoneView zone="right" api={api} />
              </Panel>
            </>
          )}
        </Group>
        <EdgeDrop zone="left" api={api} />
        <EdgeDrop zone="right" api={api} />
        <EdgeDrop zone="bottom" api={api} />
      </div>
    </DragCtx.Provider>
  );
}
