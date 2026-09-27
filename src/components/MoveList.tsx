import { useEffect, useRef } from 'react';
import { ArrowUpToLine, GitBranch, ListTree, MoveUpRight, StickyNote, Trash2 } from 'lucide-react';
import type { GameState, MoveNode } from '../types';
import { EmptyState } from '../ui/primitives';
import { ROOT_ID } from '../types';
import { isMainLine } from '../state/gameReducer';
import type { GameAction } from '../state/gameReducer';

interface Props {
  state: GameState;
  dispatch: (action: GameAction) => void;
}

function MoveButton({
  state,
  id,
  ply,
  showNumber,
  activeRef,
  onGoto,
}: {
  state: GameState;
  id: string;
  ply: number;
  showNumber: boolean;
  activeRef: React.RefObject<HTMLButtonElement | null>;
  onGoto: (id: string) => void;
}) {
  const node = state.nodes[id];
  const ann = node.annotation;
  const hasNotes = !!ann?.notes.length;
  const hasShapes = !!(ann?.arrows.length || ann?.highlights.length);
  const white = ply % 2 === 1;
  const number = showNumber || white ? `${Math.ceil(ply / 2)}${white ? '.' : '…'}` : '';
  const active = id === state.currentId;
  return (
    <button ref={active ? activeRef : undefined} className={`move ${active ? 'active' : ''}`} onClick={() => onGoto(id)}>
      {number && <span className="move-number">{number}</span>}
      {node.san}
      {(hasNotes || hasShapes) && (
        <span className="move-badges">
          {hasNotes && <StickyNote size={10} strokeWidth={2.2} aria-label="Has notes" />}
          {hasShapes && <MoveUpRight size={10} strokeWidth={2.2} aria-label="Has arrows or highlights" />}
        </span>
      )}
    </button>
  );
}

/** Renders a line starting at `startId`, with each move's alternatives nested after it. */
function Line({
  state,
  startId,
  startPly,
  depth,
  activeRef,
  onGoto,
}: {
  state: GameState;
  startId: string;
  startPly: number;
  depth: number;
  activeRef: React.RefObject<HTMLButtonElement | null>;
  onGoto: (id: string) => void;
}) {
  const items: React.ReactNode[] = [];
  let id: string | undefined = startId;
  let ply = startPly;
  let needNumber = true;
  let first = true;
  while (id) {
    const node: MoveNode = state.nodes[id];
    items.push(<MoveButton key={id} state={state} id={id} ply={ply} showNumber={needNumber} activeRef={activeRef} onGoto={onGoto} />);
    needNumber = false;
    // Alternatives to this move are its siblings. The first move of a variation
    // skips them because the parent line already listed them.
    if (!(first && depth > 0)) {
      const siblings = state.nodes[node.parent!].children.filter((c) => c !== id);
      if (siblings.length) {
        items.push(
          <div key={`${id}-var`} className="variations">
            {siblings.map((s) => (
              <div key={s} className="variation">
                <Line state={state} startId={s} startPly={ply} depth={depth + 1} activeRef={activeRef} onGoto={onGoto} />
              </div>
            ))}
          </div>,
        );
        needNumber = true;
      }
    }
    first = false;
    id = node.children[0];
    ply++;
  }
  return <>{items}</>;
}

export function MoveList({ state, dispatch, onImport }: Props & { onImport?: () => void }) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const { currentId } = state;

  const movesRef = useRef<HTMLDivElement>(null);

  // Keep the active move visible by scrolling only the move container, never the page.
  useEffect(() => {
    const el = activeRef.current;
    const box = movesRef.current;
    if (!box) return;
    if (!el) {
      box.scrollTop = 0; // at the start position
      return;
    }
    const top = el.offsetTop; // .moves is the offset parent
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top - 8;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
  }, [currentId]);

  const current = state.nodes[currentId];
  const firstMove = state.nodes[ROOT_ID].children[0];
  const onMain = isMainLine(state, currentId);
  const siblingCount = current.parent !== null ? state.nodes[current.parent].children.length : 1;
  const onGoto = (id: string) => dispatch({ type: 'GOTO', id });

  return (
    <div className="move-list">
      {currentId !== ROOT_ID && (
        <div className="line-tools" role="toolbar" aria-label="Variation tools">
          {siblingCount > 1 && (
            <button className="btn btn-ghost btn-sm" onClick={() => dispatch({ type: 'SIBLING', delta: 1 })} title="Switch to the next alternative (↑/↓)">
              <GitBranch size={13} /> {siblingCount} alternatives
            </button>
          )}
          {!onMain && (
            <button className="btn btn-ghost btn-sm" onClick={() => dispatch({ type: 'PROMOTE', id: currentId })} title="Make this variation the main line">
              <ArrowUpToLine size={13} /> Make main line
            </button>
          )}
          <span className="line-tools-spacer" />
          <button className="btn btn-ghost btn-sm danger-text" onClick={() => dispatch({ type: 'DELETE_FROM', id: currentId })} title="Delete this move and everything after it">
            <Trash2 size={13} /> Delete from here
          </button>
        </div>
      )}
      <div className="moves" ref={movesRef}>
        {!firstMove && (
          <EmptyState
            icon={ListTree}
            title="No moves yet"
            actions={onImport && <button className="btn btn-sm" onClick={onImport}>Import PGN</button>}
          >
            Play a move on the board to start. Playing a different move from any earlier position creates a variation, shown indented here.
          </EmptyState>
        )}
        {firstMove && <Line state={state} startId={firstMove} startPly={1} depth={0} activeRef={activeRef} onGoto={onGoto} />}
        {state.meta.result && state.meta.result !== '*' && <div className="result">{state.meta.result}</div>}
      </div>
    </div>
  );
}
