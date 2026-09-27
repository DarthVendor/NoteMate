/**
 * The Erase menu, shared by the Analysis panel's move toolbar and the eraser under the board: side lines,
 * arrows + highlights everywhere or on this position, or everything. Erasing is immediate, with an Undo toast.
 */
import { ChevronDown, Eraser, GitBranch, MoveUpRight, Sparkles, Trash2 } from 'lucide-react';
import { useApp } from '../app/AppContext';
import { eraseCounts } from '../state/gameReducer';
import { Keys } from '../ui/primitives';
import { MenuDivider, MenuItem, MenuLabel, Popover } from '../ui/Popover';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function EraseMenu({ variant = 'toolbar' }: { variant?: 'toolbar' | 'icon' }) {
  const { state, annotation, dispatch, erase } = useApp();
  const { sideMoves, shapes } = eraseCounts(state);
  const here = annotation.arrows.length + annotation.highlights.length;
  const nothing = sideMoves === 0 && shapes === 0;
  return (
    <Popover
      label="Erase"
      width={290}
      trigger={(p) =>
        variant === 'icon' ? (
          <button {...p} className="btn btn-ghost btn-icon" title="Erase side lines or arrows" aria-label="Erase" data-testid="erase-menu-board">
            <Eraser size={16} />
          </button>
        ) : (
          <button {...p} className="btn btn-ghost btn-sm erase-btn" title="Erase side lines or arrows (undo from the message that follows)" data-testid="erase-menu">
            <Eraser size={13} /> Erase <ChevronDown size={12} className="faint" />
          </button>
        )
      }
    >
      {(close) => {
        const run = (fn: () => void) => () => {
          fn();
          close();
        };
        return (
          <>
            <MenuLabel>Erase</MenuLabel>
            <MenuItem icon={<GitBranch size={14} />} onClick={run(() => erase('variations'))} disabled={sideMoves === 0} hint={<Keys keys={['Shift', 'Backspace']} />}>
              <span className="menu-two">
                <span>Side lines</span>
                <span className="faint">{sideMoves ? `${plural(sideMoves, 'move')} off the main line, chat lines included` : 'Only the main line is left'}</span>
              </span>
            </MenuItem>
            <MenuItem icon={<MoveUpRight size={14} />} onClick={run(() => erase('shapes'))} disabled={shapes === 0}>
              <span className="menu-two">
                <span>Arrows and highlights</span>
                <span className="faint">{shapes ? `${plural(shapes, 'mark')} on all positions, pinned model arrows too` : 'None drawn'}</span>
              </span>
            </MenuItem>
            <MenuItem icon={<Sparkles size={14} />} onClick={run(() => dispatch({ type: 'CLEAR_SHAPES' }))} disabled={here === 0} hint={<Keys keys={['x']} />}>
              <span className="menu-two">
                <span>This position’s marks</span>
                <span className="faint">{here ? `${here} arrow${here === 1 ? '' : 's'} or highlight${here === 1 ? '' : 's'} here` : 'None here'}</span>
              </span>
            </MenuItem>
            <MenuDivider />
            <MenuItem icon={<Trash2 size={14} />} danger onClick={run(() => erase('all'))} disabled={nothing}>
              Everything above
            </MenuItem>
            <p className="menu-foot">Notes on the main line stay. Undo appears for a few seconds after erasing.</p>
          </>
        );
      }}
    </Popover>
  );
}
