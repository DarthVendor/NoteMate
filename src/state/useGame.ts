import { useEffect, useMemo, useReducer } from 'react';
import { Chess } from 'chess.js';
import { gameReducer, initialGameState, pathTo } from './gameReducer';
import type { Annotation, GameState, MoveNode } from '../types';
import { emptyAnnotation, ROOT_ID } from '../types';

const STORAGE_KEY = 'notemate.game.v2';
const LEGACY_KEY = 'notemate.game.v1';

interface LegacyState {
  startFen: string;
  moves: string[];
  ply: number;
  annotations: Record<number, Annotation>;
  meta: GameState['meta'];
}

/** Convert the old linear format (main line + per-ply annotations) into a tree. */
function migrate(legacy: LegacyState): GameState {
  const state = initialGameState();
  state.startFen = legacy.startFen;
  state.meta = legacy.meta;
  let parentId = ROOT_ID;
  if (legacy.annotations[0]) state.nodes[ROOT_ID].annotation = legacy.annotations[0];
  legacy.moves.forEach((san, i) => {
    const id = `m${i + 1}`;
    const node: MoveNode = { id, san, parent: parentId, children: [] };
    if (legacy.annotations[i + 1]) node.annotation = legacy.annotations[i + 1];
    state.nodes[id] = node;
    state.nodes[parentId].children.push(id);
    parentId = id;
  });
  state.currentId = legacy.ply === 0 ? ROOT_ID : `m${legacy.ply}`;
  return state;
}

function load(): GameState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as GameState;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return migrate(JSON.parse(legacy) as LegacyState);
  } catch {
    /* ignore corrupt storage */
  }
  return initialGameState();
}

export function useGame() {
  const [state, dispatch] = useReducer(gameReducer, undefined, load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage may be unavailable */
    }
  }, [state]);

  const { startFen, nodes, currentId } = state;
  const chess = useMemo(() => {
    const c = new Chess(startFen);
    for (const node of pathTo({ ...state, startFen, nodes, currentId }, currentId)) c.move(node.san);
    return c;
  }, [startFen, nodes, currentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const annotation = nodes[currentId]?.annotation ?? emptyAnnotation();
  const lastMove = currentId !== ROOT_ID ? chess.history({ verbose: true }).at(-1) : undefined;

  return { state, dispatch, chess, annotation, lastMove };
}
