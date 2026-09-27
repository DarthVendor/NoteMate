import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

export type Zone = 'left' | 'right' | 'bottom';

/**
 * A panel that can be placed in the workspace. Register one with `registerPanel` (see src/panels/index.tsx);
 * it then appears in the Panels menu, the command palette ("Show …") and Settings, and layouts can place it.
 */
export interface PanelDef {
  /** Stable id, used in saved layouts. Never rename a shipped id. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** One line shown in the Panels menu. */
  description?: string;
  /** Zone the panel opens in when shown and not placed by a layout. */
  defaultZone: Zone;
  /** Minimum size in px along the zone's resize axis (width for left/right, height for bottom). */
  minSize?: number;
  /** The panel body. It gets app state from `useApp()`. */
  component: ComponentType;
  /** Optional live status shown in the tab (e.g. a running engine). */
  useStatus?: () => 'on' | 'busy' | 'err' | null;
}

const panels = new Map<string, PanelDef>();
const order: string[] = [];

export function registerPanel(def: PanelDef): void {
  if (!panels.has(def.id)) order.push(def.id);
  panels.set(def.id, def);
}

export const getPanel = (id: string): PanelDef | undefined => panels.get(id);
export const allPanels = (): PanelDef[] => order.map((id) => panels.get(id)!);
