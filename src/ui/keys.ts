/** "Mod" renders as ⌘ on Apple platforms and Ctrl elsewhere. */
export const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const KEY_LABEL: Record<string, string> = {
  Mod: isApple ? '⌘' : 'Ctrl',
  Shift: '⇧',
  Alt: isApple ? '⌥' : 'Alt',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: '↵',
  Escape: 'Esc',
};
export const keyLabel = (k: string) => KEY_LABEL[k] ?? (k.length === 1 ? k.toUpperCase() : k);
