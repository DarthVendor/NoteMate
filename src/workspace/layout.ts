/*
 * Workspace layout model: three dock zones around the board (left, right, bottom). Each zone holds
 * stacks (split along the zone), and each stack holds one or more panels shown as tabs.
 * Panels that are registered but not placed are hidden. All edits are pure functions on `Layout`.
 */
import { allPanels, getPanel, type Zone } from './registry';

export interface Stack {
  id: string;
  panels: string[];
  active: string;
  /** Share of the zone (percent), remembered across reloads. */
  size?: number;
}

export interface ZoneState {
  stacks: Stack[];
  /** Zone size as a percent of the workspace width (left/right) or the centre column height (bottom). */
  size: number;
}

export interface Layout {
  version: 1;
  /** Preset revision the layout was made with. A saved, unedited preset from an older revision is rebuilt. */
  rev?: number;
  zones: Record<Zone, ZoneState>;
  /** Preset the layout started from; 'custom' once edited. */
  preset: PresetId | 'custom';
}

export type PresetId = 'study' | 'analysis' | 'play' | 'coach';
export const ZONES: Zone[] = ['left', 'right', 'bottom'];
export const ZONE_LABEL: Record<Zone, string> = { left: 'Left', right: 'Right', bottom: 'Bottom' };

let seq = 0;
const stackId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;
const stack = (panels: string[], size?: number): Stack => ({ id: stackId(), panels, active: panels[0], size });

type PresetSpec = { name: string; description: string; zones: Partial<Record<Zone, { size: number; stacks: { panels: string[]; size?: number }[] }>> };

export const PRESETS: Record<PresetId, PresetSpec> = {
  study: {
    name: 'Study',
    description: 'Notes on the left, moves, engine and ChessMind in one panel on the right',
    zones: {
      left: { size: 21, stacks: [{ panels: ['notes'] }] },
      right: { size: 29, stacks: [{ panels: ['analysis'] }] },
    },
  },
  analysis: {
    name: 'Analysis',
    description: 'A wide analysis panel; notes tabbed beside it',
    zones: {
      right: { size: 34, stacks: [{ panels: ['analysis', 'notes'] }] },
    },
  },
  play: {
    name: 'Focus',
    description: 'The board with a slim analysis column',
    zones: {
      right: { size: 25, stacks: [{ panels: ['analysis'] }] },
    },
  },
  coach: {
    name: 'Coach',
    description: 'Room to talk the position through with ChessMind, notes at hand',
    zones: {
      left: { size: 20, stacks: [{ panels: ['notes'] }] },
      right: { size: 36, stacks: [{ panels: ['analysis'] }] },
    },
  },
};

export const DEFAULT_PRESET: PresetId = 'study';
/** Bump when PRESETS change so unedited saved presets pick up the new arrangement (2: one integrated Analysis panel). */
export const PRESET_REV = 2;

export function presetLayout(id: PresetId): Layout {
  const spec = PRESETS[id];
  const zones = {} as Record<Zone, ZoneState>;
  for (const z of ZONES) {
    const zs = spec.zones[z];
    zones[z] = { size: zs?.size ?? (z === 'bottom' ? 30 : 24), stacks: (zs?.stacks ?? []).map((s) => stack(s.panels, s.size)) };
  }
  return sanitize({ version: 1, rev: PRESET_REV, zones, preset: id });
}

/** Drop unknown/duplicate panels and empty stacks, repair active tabs and sizes. Safe on untrusted input. */
export function sanitize(input: unknown): Layout {
  const fallback = () => presetLayout(DEFAULT_PRESET);
  if (!input || typeof input !== 'object') return fallback();
  const raw = input as Partial<Layout>;
  if (raw.version !== 1 || !raw.zones || typeof raw.zones !== 'object') return fallback();
  const seen = new Set<string>();
  const zones = {} as Record<Zone, ZoneState>;
  for (const z of ZONES) {
    const rz = (raw.zones as Record<string, Partial<ZoneState> | undefined>)[z];
    const stacks: Stack[] = [];
    for (const rs of Array.isArray(rz?.stacks) ? rz!.stacks : []) {
      if (!rs || !Array.isArray(rs.panels)) continue;
      const ps = rs.panels.filter((p): p is string => typeof p === 'string' && !!getPanel(p) && !seen.has(p));
      ps.forEach((p) => seen.add(p));
      if (!ps.length) continue;
      stacks.push({
        id: typeof rs.id === 'string' ? rs.id : stackId(),
        panels: ps,
        active: ps.includes(rs.active as string) ? (rs.active as string) : ps[0],
        size: typeof rs.size === 'number' && rs.size > 0 && rs.size <= 100 ? rs.size : undefined,
      });
    }
    const size = typeof rz?.size === 'number' && rz.size >= 8 && rz.size <= 70 ? rz.size : z === 'bottom' ? 30 : 24;
    zones[z] = { stacks, size };
  }
  const preset = raw.preset && (raw.preset === 'custom' || raw.preset in PRESETS) ? raw.preset : 'custom';
  // An unedited preset saved before the presets changed: rebuild it from the current definition.
  if (preset !== 'custom' && raw.rev !== PRESET_REV) return presetLayout(preset);
  return { version: 1, rev: PRESET_REV, zones, preset };
}

export function locate(layout: Layout, panelId: string): { zone: Zone; stack: Stack; stackIndex: number; tabIndex: number } | null {
  for (const zone of ZONES) {
    const stacks = layout.zones[zone].stacks;
    for (let i = 0; i < stacks.length; i++) {
      const t = stacks[i].panels.indexOf(panelId);
      if (t >= 0) return { zone, stack: stacks[i], stackIndex: i, tabIndex: t };
    }
  }
  return null;
}

export const isVisible = (layout: Layout, id: string) => locate(layout, id) !== null;
export const hiddenPanels = (layout: Layout) => allPanels().filter((p) => !isVisible(layout, p.id));

const clone = (l: Layout): Layout => ({
  version: 1,
  rev: PRESET_REV,
  preset: 'custom',
  zones: Object.fromEntries(ZONES.map((z) => [z, { size: l.zones[z].size, stacks: l.zones[z].stacks.map((s) => ({ ...s, panels: [...s.panels] })) }])) as Record<Zone, ZoneState>,
});

function removePanel(l: Layout, id: string): Layout {
  const next = clone(l);
  for (const z of ZONES) {
    next.zones[z].stacks = next.zones[z].stacks
      .map((s) => {
        if (!s.panels.includes(id)) return s;
        const idx = s.panels.indexOf(id);
        const panels = s.panels.filter((p) => p !== id);
        const active = s.active === id ? panels[Math.min(idx, panels.length - 1)] : s.active;
        return { ...s, panels, active };
      })
      .filter((s) => s.panels.length > 0);
  }
  return next;
}

export type DropTarget =
  /** Add as a tab to a stack (before tab `index`, default: last). */
  | { kind: 'tab'; stackId: string; index?: number }
  /** New stack in `zone` at position `index` (default: end). */
  | { kind: 'split'; zone: Zone; index?: number };

export function movePanel(l: Layout, id: string, target: DropTarget): Layout {
  // Dropping a panel onto its own single-tab stack is a no-op.
  const from = locate(l, id);
  if (from && target.kind === 'tab' && from.stack.id === target.stackId && from.stack.panels.length === 1) return l;
  let next = removePanel(l, id);
  if (target.kind === 'tab') {
    for (const z of ZONES) {
      const s = next.zones[z].stacks.find((st) => st.id === target.stackId);
      if (s) {
        let index = target.index ?? s.panels.length;
        if (from && from.stack.id === s.id && from.tabIndex < index) index--;
        s.panels.splice(Math.max(0, Math.min(index, s.panels.length)), 0, id);
        s.active = id;
        return next;
      }
    }
    // Stack vanished (it only held this panel): fall back to its zone.
    return movePanel(next, id, { kind: 'split', zone: from?.zone ?? getPanel(id)?.defaultZone ?? 'right' });
  }
  const stacks = next.zones[target.zone].stacks;
  let index = target.index ?? stacks.length;
  // Removing the panel's own single-panel stack earlier in the same zone shifts the insertion point.
  if (from && from.zone === target.zone && from.stack.panels.length === 1 && from.stackIndex < index) index--;
  stacks.splice(Math.max(0, Math.min(index, stacks.length)), 0, stack([id]));
  // New stacks share the zone evenly.
  stacks.forEach((s) => (s.size = undefined));
  next = { ...next };
  return next;
}

export function showPanel(l: Layout, id: string): Layout {
  const found = locate(l, id);
  if (found) return activate(l, found.stack.id, id);
  const def = getPanel(id);
  if (!def) return l;
  const zone = def.defaultZone;
  const stacks = l.zones[zone].stacks;
  // Join the last stack of its zone as a tab, or open a new stack.
  return stacks.length ? movePanel(l, id, { kind: 'tab', stackId: stacks[stacks.length - 1].id }) : movePanel(l, id, { kind: 'split', zone });
}

export const hidePanel = (l: Layout, id: string): Layout => removePanel(l, id);
export const togglePanel = (l: Layout, id: string): Layout => (isVisible(l, id) ? hidePanel(l, id) : showPanel(l, id));

export function activate(l: Layout, stackId: string, panelId: string): Layout {
  const next = clone(l);
  next.preset = l.preset; // switching tabs is not a layout edit
  for (const z of ZONES) for (const s of next.zones[z].stacks) if (s.id === stackId && s.panels.includes(panelId)) s.active = panelId;
  return next;
}

export function moveStack(l: Layout, stackId: string, delta: -1 | 1): Layout {
  const next = clone(l);
  for (const z of ZONES) {
    const stacks = next.zones[z].stacks;
    const i = stacks.findIndex((s) => s.id === stackId);
    const j = i + delta;
    if (i >= 0 && j >= 0 && j < stacks.length) {
      [stacks[i], stacks[j]] = [stacks[j], stacks[i]];
      return next;
    }
  }
  return l;
}

export function setZoneSizes(l: Layout, sizes: Partial<Record<Zone, number>>): Layout {
  const next = clone(l);
  next.preset = l.preset;
  for (const [z, v] of Object.entries(sizes) as [Zone, number][]) if (v >= 5) next.zones[z].size = Math.round(v * 10) / 10;
  return next;
}

export function setStackSizes(l: Layout, zone: Zone, sizes: Record<string, number>): Layout {
  const next = clone(l);
  next.preset = l.preset;
  for (const s of next.zones[zone].stacks) if (sizes[s.id] !== undefined) s.size = Math.round(sizes[s.id] * 10) / 10;
  return next;
}

/** Panels in reading order (left, right, bottom), used by the phone layout. */
export const orderedPanels = (l: Layout): string[] => ZONES.flatMap((z) => l.zones[z].stacks.flatMap((s) => s.panels));
