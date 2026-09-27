import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { readJson, writeJson } from './storage';

export type ThemePref = 'system' | 'light' | 'dark';
export type BoardTheme = 'walnut' | 'slate' | 'olive' | 'stone';
export type PieceSet = 'cburnett' | 'chessnut' | 'glyph';
export type MotionPref = 'normal' | 'fast' | 'off';

export interface UiSettings {
  theme: ThemePref;
  boardTheme: BoardTheme;
  pieceSet: PieceSet;
  coordinates: boolean;
  legalMoves: boolean;
  motion: MotionPref;
  /** Show the one-line help strip under the board. */
  boardHints: boolean;
}

export const DEFAULT_UI: UiSettings = {
  theme: 'system',
  boardTheme: 'walnut',
  pieceSet: 'cburnett',
  coordinates: true,
  legalMoves: true,
  motion: 'normal',
  boardHints: true,
};

export const BOARD_THEMES: { id: BoardTheme; name: string; light: string; dark: string }[] = [
  { id: 'walnut', name: 'Walnut', light: '#ecdab9', dark: '#ae8a68' },
  { id: 'slate', name: 'Slate', light: '#dee3e6', dark: '#8ca2ad' },
  { id: 'olive', name: 'Olive', light: '#e9e9d0', dark: '#7d945d' },
  { id: 'stone', name: 'Stone', light: '#d9d6cf', dark: '#8f8a80' },
];

export const PIECE_SETS: { id: PieceSet; name: string }[] = [
  { id: 'cburnett', name: 'Classic' },
  { id: 'chessnut', name: 'Chessnut' },
  { id: 'glyph', name: 'Glyph' },
];

const KEY = 'notemate.ui.v1';

function load(): UiSettings {
  const saved = readJson<Partial<UiSettings>>(KEY);
  return { ...DEFAULT_UI, ...(saved && typeof saved === 'object' ? saved : {}) };
}

const darkQuery = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
const subscribeScheme = (cb: () => void) => {
  darkQuery?.addEventListener('change', cb);
  return () => darkQuery?.removeEventListener('change', cb);
};
const systemDark = () => darkQuery?.matches ?? true;

export function useUiSettings() {
  const [ui, setUi] = useState<UiSettings>(load);
  const prefersDark = useSyncExternalStore(subscribeScheme, systemDark, () => true);
  const resolvedTheme: 'light' | 'dark' = ui.theme === 'system' ? (prefersDark ? 'dark' : 'light') : ui.theme;

  useEffect(() => writeJson(KEY, ui), [ui]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.motion = ui.motion;
  }, [resolvedTheme, ui.motion]);

  const updateUi = useCallback((patch: Partial<UiSettings>) => setUi((s) => ({ ...s, ...patch })), []);
  return { ui, updateUi, resolvedTheme };
}

/** Width-based breakpoint, e.g. useMediaQuery('(max-width: 760px)'). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
}
