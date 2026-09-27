/*
 * Built-in panels. To add a panel: write a component that reads app state with `useApp()`, then call
 * `registerPanel` here with an id, title, icon and default zone. Layouts, the Panels menu, the command
 * palette and the phone tab bar pick it up automatically; add it to a preset in workspace/layout.ts
 * if it should be visible by default.
 */
import { Bot, Cpu, ListTree, Settings2, StickyNote, Swords } from 'lucide-react';
import { registerPanel } from '../workspace/registry';
import { useApp } from '../app/AppContext';
import { ChessMindHost, EngineHost, MovesPanel, NotesPanel, SimulateHost } from './hosts';
import { SettingsPanel } from './SettingsPanel';

registerPanel({ id: 'moves', title: 'Moves', icon: ListTree, description: 'Move tree with variations', defaultZone: 'right', minSize: 240, component: MovesPanel });
registerPanel({ id: 'notes', title: 'Notes', icon: StickyNote, description: 'Sticky notes for each position', defaultZone: 'left', minSize: 240, component: NotesPanel });
registerPanel({
  id: 'engine',
  title: 'Engine',
  icon: Cpu,
  description: 'Stockfish lines and evaluation',
  defaultZone: 'right',
  minSize: 260,
  component: EngineHost,
  useStatus: () => {
    const { engine } = useApp();
    return engine.status === 'ready' ? 'on' : engine.status === 'loading' ? 'busy' : engine.status === 'error' ? 'err' : null;
  },
});
registerPanel({
  id: 'chessmind',
  title: 'ChessMind',
  icon: Bot,
  description: 'Chat with the in-browser chess model',
  defaultZone: 'right',
  minSize: 280,
  component: ChessMindHost,
  useStatus: () => {
    const { chessmind } = useApp();
    return chessmind.chatBusy ? 'busy' : chessmind.status === 'ready' ? 'on' : chessmind.status === 'loading' ? 'busy' : chessmind.status === 'error' ? 'err' : null;
  },
});
registerPanel({
  id: 'simulate',
  title: 'Simulate',
  icon: Swords,
  description: 'ChessMind vs Stockfish with an Elo estimate',
  defaultZone: 'right',
  minSize: 280,
  component: SimulateHost,
  useStatus: () => (useApp().sim.phase === 'idle' ? null : 'on'),
});
registerPanel({ id: 'settings', title: 'Settings', icon: Settings2, description: 'Theme, board, engine and chat options', defaultZone: 'right', minSize: 280, component: SettingsPanel });
