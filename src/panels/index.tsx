/*
 * Built-in panels. To add a panel: write a component that reads app state with `useApp()`, then call
 * `registerPanel` here with an id, title, icon and default zone. Layouts, the Panels menu, the command
 * palette and the phone tab bar pick it up automatically; add it to a preset in workspace/layout.ts
 * if it should be visible by default.
 *
 * "Analysis" is the default right-hand panel (engine strip, move tree, ChessMind chat). Moves, Engine and
 * ChessMind stay available as separate panels for custom layouts. Simulate is a developer panel (dev: true),
 * listed only while Settings → Developer tools is on.
 */
import { Bot, ChartLine, Cpu, ListTree, PanelRight, Settings2, StickyNote, Swords } from 'lucide-react';
import { registerPanel } from '../workspace/registry';
import { useApp } from '../app/AppContext';
import { ChessMindHost, EngineHost, MovesPanel, NotesPanel, SimulateHost } from './hosts';
import { SettingsPanel } from './SettingsPanel';
import { AnalysisPanel } from '../analysis/AnalysisPanel';
import { ReviewPanel } from '../review/ReviewPanel';

registerPanel({
  id: 'analysis',
  title: 'Analysis',
  icon: PanelRight,
  description: 'Engine, move tree and ChessMind chat in one panel',
  defaultZone: 'right',
  minSize: 300,
  component: AnalysisPanel,
  useStatus: () => {
    const { engine, chessmind } = useApp();
    if (engine.status === 'error' || chessmind.status === 'error') return 'err';
    if (engine.status === 'loading' || chessmind.status === 'loading' || chessmind.chatBusy) return 'busy';
    return engine.status === 'ready' || chessmind.status === 'ready' ? 'on' : null;
  },
});
registerPanel({ id: 'notes', title: 'Notes', icon: StickyNote, description: 'Sticky notes for each position', defaultZone: 'left', minSize: 240, component: NotesPanel });
registerPanel({ id: 'moves', title: 'Moves', icon: ListTree, description: 'Move tree on its own (also in Analysis)', defaultZone: 'right', minSize: 240, component: MovesPanel });
registerPanel({
  id: 'engine',
  title: 'Engine',
  icon: Cpu,
  description: 'Stockfish lines on their own (also in Analysis)',
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
  description: 'The chat on its own (also in Analysis)',
  defaultZone: 'right',
  minSize: 280,
  component: ChessMindHost,
  useStatus: () => {
    const { chessmind } = useApp();
    return chessmind.chatBusy ? 'busy' : chessmind.status === 'ready' ? 'on' : chessmind.status === 'loading' ? 'busy' : chessmind.status === 'error' ? 'err' : null;
  },
});
registerPanel({
  id: 'review',
  title: 'Review',
  icon: ChartLine,
  description: 'Engine game review: accuracy, blunders and mistakes',
  defaultZone: 'left',
  minSize: 260,
  component: ReviewPanel,
  useStatus: () => {
    const { review } = useApp();
    return review.busy ? 'busy' : review.phase === 'error' ? 'err' : null;
  },
});
registerPanel({ id: 'settings', title: 'Settings', icon: Settings2, description: 'Theme, board, engine and chat options', defaultZone: 'right', minSize: 280, component: SettingsPanel });
registerPanel({
  id: 'simulate',
  title: 'Simulate',
  icon: Swords,
  description: 'Developer: ChessMind vs Stockfish with an Elo estimate',
  // Opens beside Notes so the board and the Analysis panel stay in view while games play.
  defaultZone: 'left',
  minSize: 280,
  component: SimulateHost,
  dev: true,
  useStatus: () => (useApp().sim.phase === 'idle' ? null : 'on'),
});
