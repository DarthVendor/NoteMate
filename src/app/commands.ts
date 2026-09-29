import type { LucideIcon } from 'lucide-react';
import {
  ArrowDown, ArrowLeft, ChartLine, History as HistoryIcon, ArrowRight, ArrowUp, ChevronFirst, ChevronLast, ClipboardCopy, Cpu, Eraser, FilePlus2, FlipVertical2,
  Keyboard, LayoutTemplate, Moon, MessageSquareText, Palette, PanelsTopLeft, RotateCcw, SquarePen, StickyNote, Sun, SunMoon, Swords, Upload, Wrench,
} from 'lucide-react';
import type { AppCtx } from './AppContext';
import { allPanels } from '../workspace/registry';
import { hidePanel, isVisible, PRESETS, type PresetId } from '../workspace/layout';
import { BOARD_THEMES } from '../ui/settings';
import { FOCUS_CHAT_EVENT } from '../analysis/AnalysisPanel';

export interface Command {
  id: string;
  title: string;
  group: 'Navigate' | 'Board' | 'Game' | 'Panels' | 'Layout' | 'Appearance' | 'Help' | 'Developer';
  icon?: LucideIcon;
  /** Keys for the shortcut, e.g. ['Mod', 'k'] or ['ArrowLeft']. The first entry of `shortcuts` is shown in menus. */
  shortcuts?: string[][];
  keywords?: string;
  run: () => void;
}

/** All commands available right now. Used by the command palette, the shortcuts sheet and the keyboard handler. */
export function buildCommands(ctx: AppCtx): Command[] {
  const { dispatch, layout } = ctx;
  const cmds: Command[] = [
    { id: 'nav.back', title: 'Previous move', group: 'Navigate', icon: ArrowLeft, shortcuts: [['ArrowLeft'], ['k']], run: () => dispatch({ type: 'BACK' }) },
    { id: 'nav.forward', title: 'Next move', group: 'Navigate', icon: ArrowRight, shortcuts: [['ArrowRight'], ['j']], run: () => dispatch({ type: 'FORWARD' }) },
    { id: 'nav.start', title: 'Go to start', group: 'Navigate', icon: ChevronFirst, shortcuts: [['Home']], run: () => dispatch({ type: 'START' }) },
    { id: 'nav.end', title: 'Go to end of line', group: 'Navigate', icon: ChevronLast, shortcuts: [['End']], run: () => dispatch({ type: 'END' }) },
    { id: 'nav.prevVar', title: 'Previous variation', group: 'Navigate', icon: ArrowUp, shortcuts: [['ArrowUp']], keywords: 'alternative sibling branch', run: () => dispatch({ type: 'SIBLING', delta: -1 }) },
    { id: 'nav.nextVar', title: 'Next variation', group: 'Navigate', icon: ArrowDown, shortcuts: [['ArrowDown']], keywords: 'alternative sibling branch', run: () => dispatch({ type: 'SIBLING', delta: 1 }) },
    { id: 'board.flip', title: 'Flip board', group: 'Board', icon: FlipVertical2, shortcuts: [['f']], keywords: 'orientation rotate', run: ctx.flip },
    { id: 'board.clear', title: 'Clear arrows and highlights on this position', group: 'Board', icon: Eraser, shortcuts: [['x']], keywords: 'shapes circles erase', run: () => dispatch({ type: 'CLEAR_SHAPES' }) },
    { id: 'board.engine', title: ctx.engine.settings.enabled ? 'Turn engine off' : 'Turn engine on', group: 'Board', icon: Cpu, shortcuts: [['e']], keywords: 'stockfish analysis evaluation', run: () => ctx.engine.update({ enabled: !ctx.engine.settings.enabled }) },
    {
      id: 'game.note', title: 'Add a note to this position', group: 'Game', icon: StickyNote, shortcuts: [['n']], keywords: 'sticky comment annotate',
      run: () => {
        ctx.revealPanel('notes');
        dispatch({ type: 'ADD_NOTE', color: 'yellow' });
      },
    },
    { id: 'game.import', title: 'Import PGN…', group: 'Game', icon: Upload, shortcuts: [['i']], keywords: 'load open chess.com chessbase file', run: ctx.openImport },
    { id: 'game.export', title: 'Copy game as PGN', group: 'Game', icon: ClipboardCopy, keywords: 'export clipboard save', run: () => ctx.exportPgn() },
    { id: 'game.eraseLines', title: 'Erase side lines', group: 'Game', icon: Eraser, shortcuts: [['Shift', 'Backspace']], keywords: 'delete variations branches clean clear lines keep main line', run: () => ctx.erase('variations') },
    { id: 'game.eraseArrows', title: 'Erase arrows and highlights (all positions)', group: 'Game', icon: Eraser, keywords: 'clear shapes circles drawings everywhere pinned', run: () => ctx.erase('shapes') },
    { id: 'game.eraseAll', title: 'Erase side lines and arrows', group: 'Game', icon: Eraser, keywords: 'clear everything clean up variations shapes', run: () => ctx.erase('all') },
    { id: 'game.new', title: 'New game', group: 'Game', icon: FilePlus2, keywords: 'reset clear start over', run: ctx.newGame },
    {
      id: 'game.setPosition', title: 'Set position…', group: 'Game', icon: SquarePen,
      keywords: 'fen setup set up position edit board editor custom start from current board puzzle', run: ctx.openSetPosition,
    },
    {
      id: 'game.ask', title: 'Ask ChessMind…', group: 'Game', icon: MessageSquareText, shortcuts: [['/']], keywords: 'chat model question coach',
      run: () => {
        // The chat lives in the Analysis panel unless a layout shows the standalone ChessMind panel.
        ctx.revealPanel(isVisible(layout.layout, 'chessmind') && !isVisible(layout.layout, 'analysis') ? 'chessmind' : 'analysis');
        window.dispatchEvent(new Event(FOCUS_CHAT_EVENT));
        if (!ctx.chessmind.settings.enabled) ctx.chessmind.update({ enabled: true });
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-testid=chessmind-prompt]')?.focus(), 60);
      },
    },
    {
      id: 'game.review', title: ctx.review.busy ? 'Stop the game review' : 'Review game with the engine', group: 'Game', icon: ChartLine,
      keywords: 'blunders mistakes accuracy stockfish annotate analyse',
      run: () => {
        if (ctx.review.busy) return ctx.review.cancel();
        ctx.revealPanel('review');
        void ctx.review.start();
      },
    },
  ];
  for (const g of ctx.savedGames) {
    cmds.push({ id: `game.restore.${g.id}`, title: `Restore earlier game: ${g.title}`, group: 'Game', icon: HistoryIcon, keywords: 'history previous undo import back', run: () => ctx.restoreGame(g.id) });
  }

  for (const p of allPanels()) {
    const visible = isVisible(layout.layout, p.id);
    cmds.push({
      id: `panel.${p.id}`,
      title: `${visible ? 'Hide' : 'Show'} ${p.title} panel`,
      group: 'Panels',
      icon: p.icon,
      keywords: `${p.description ?? ''} toggle`,
      run: () => (visible ? layout.edit((l) => hidePanel(l, p.id)) : ctx.revealPanel(p.id)),
    });
  }
  cmds.push({ id: 'panel.settings.open', title: 'Open settings', group: 'Panels', icon: Palette, shortcuts: [[','], ['Mod', ',']], keywords: 'preferences options', run: () => ctx.revealPanel('settings') });

  for (const id of Object.keys(PRESETS) as PresetId[]) {
    cmds.push({ id: `layout.${id}`, title: `Layout: ${PRESETS[id].name}`, group: 'Layout', icon: LayoutTemplate, keywords: `preset workspace ${PRESETS[id].description}`, run: () => layout.applyPreset(id) });
  }
  cmds.push({ id: 'layout.reset', title: 'Reset layout to default', group: 'Layout', icon: RotateCcw, keywords: 'restore panels', run: layout.reset });
  cmds.push({ id: 'layout.panels', title: 'Customize panels…', group: 'Layout', icon: PanelsTopLeft, keywords: 'dock move hide', run: () => document.querySelector<HTMLButtonElement>('[data-testid=panels-menu]')?.click() });

  cmds.push(
    { id: 'theme.light', title: 'Theme: Light', group: 'Appearance', icon: Sun, run: () => ctx.updateUi({ theme: 'light' }) },
    { id: 'theme.dark', title: 'Theme: Dark', group: 'Appearance', icon: Moon, run: () => ctx.updateUi({ theme: 'dark' }) },
    { id: 'theme.system', title: 'Theme: Match system', group: 'Appearance', icon: SunMoon, run: () => ctx.updateUi({ theme: 'system' }) },
    { id: 'theme.toggle', title: 'Toggle light / dark', group: 'Appearance', icon: SunMoon, shortcuts: [['t']], run: () => ctx.updateUi({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }) },
  );
  for (const b of BOARD_THEMES) cmds.push({ id: `board.theme.${b.id}`, title: `Board: ${b.name}`, group: 'Appearance', icon: Palette, keywords: 'colour color squares', run: () => ctx.updateUi({ boardTheme: b.id }) });

  cmds.push(
    {
      id: 'dev.tools', title: ctx.ui.devTools ? 'Developer: turn developer tools off' : 'Developer: turn developer tools on', group: 'Developer', icon: Wrench,
      keywords: 'debug simulate settings', run: () => ctx.updateUi({ devTools: !ctx.ui.devTools }),
    },
    {
      id: 'dev.simulate', title: 'Developer: Simulate vs Stockfish', group: 'Developer', icon: Swords, keywords: 'elo strength match test model engine',
      run: () => {
        ctx.updateUi({ devTools: true });
        ctx.revealPanel('simulate');
      },
    },
  );

  cmds.push(
    { id: 'help.palette', title: 'Command palette', group: 'Help', icon: Keyboard, shortcuts: [['Mod', 'k']], run: ctx.openPalette },
    { id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', icon: Keyboard, shortcuts: [['?']], keywords: 'keys help', run: ctx.openShortcuts },
  );
  return cmds;
}

/** Normalised key string of an event, matching Command.shortcuts entries joined with '+'. */
export function eventKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Shifted punctuation ('?', '/') is matched by the produced character, not Shift.
  if (e.shiftKey && e.key.length !== 1) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

export const shortcutKey = (keys: string[]) => keys.map((k) => (k.length === 1 ? k.toLowerCase() : k)).join('+');
