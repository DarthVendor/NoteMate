import type { KeyboardEvent } from 'react';

/** For forms inside a Popover: keep the arrow keys for selects and inputs instead of the menu's item navigation. */
export const keepArrows = (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).matches('select, input, textarea')) e.stopPropagation();
};
