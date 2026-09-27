import { useCallback, useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { EngineClient } from '../engine/EngineClient';
import { resolveEngineSource, type EngineAvailability, type EngineSettings } from '../engine/engines';
import type { GameAction } from '../state/gameReducer';
import type { GameReview, GameState, NoteColor } from '../types';
import { ROOT_ID } from '../types';
import { judgeMoves, movesOf, reviewNote, sideSummary, type Score } from './review';

/** Default search depth per position: modest, so a 40-move game takes seconds, not minutes. */
export const DEFAULT_REVIEW_DEPTH = 10;
export const REVIEW_DEPTHS = [8, 10, 12, 14] as const;

export type ReviewPhase = 'idle' | 'loading' | 'running' | 'error';

/** Main line from the root: node id and SAN of each move. */
export function mainLine(state: GameState): { nodeId: string; san: string }[] {
  const out: { nodeId: string; san: string }[] = [];
  let node = state.nodes[ROOT_ID];
  while (node?.children.length) {
    node = state.nodes[node.children[0]];
    if (!node) break;
    out.push({ nodeId: node.id, san: node.san });
  }
  return out;
}

/** True when the stored review no longer matches the main line (moves were added, removed or reordered). */
export function reviewStale(state: GameState): boolean {
  const r = state.review;
  if (!r) return false;
  const line = mainLine(state);
  return line.length !== r.plies || r.moves.some((m, i) => line[i]?.nodeId !== m.nodeId);
}

/** Score of a finished position (no engine needed): mated = lost, other game ends = drawn. */
function terminalScore(chess: Chess): Score | null {
  if (chess.isCheckmate()) return { mate: 0 };
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return { cp: 0 };
  return null;
}

/**
 * Walks the main line with a dedicated single-threaded Stockfish (Threads 1, Hash 16 MB, fixed depth) and
 * stores the result with APPLY_REVIEW: per-move win% losses, a per-side summary, and notes on blunders and
 * mistakes. The analysis engine should pause while `busy` (App passes it to useEngine).
 */
export function useGameReview(opts: {
  state: GameState;
  dispatch: (a: GameAction) => void;
  engineSettings: EngineSettings;
  engineAvailable: Record<string, EngineAvailability> | null;
  /** Called when a review starts or ends (App pauses the analysis engine meanwhile). */
  onBusy?: (busy: boolean) => void;
}) {
  const [phase, setPhaseState] = useState<ReviewPhase>('idle');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState<number>(DEFAULT_REVIEW_DEPTH);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  const run = useRef<{ cancelled: boolean; client: EngineClient | null } | null>(null);
  const setPhase = useCallback((p: ReviewPhase) => {
    setPhaseState(p);
    latest.current.onBusy?.(p === 'loading' || p === 'running');
  }, []);

  const cancel = useCallback(() => {
    const r = run.current;
    if (!r) return;
    r.cancelled = true;
    r.client?.terminate();
    run.current = null;
    setPhase('idle');
    setProgress(null);
  }, [setPhase]);

  useEffect(() => () => cancel(), [cancel]);

  const start = useCallback(
    async (d: number = depth, game?: GameState) => {
      if (run.current) return;
      const { engineSettings, engineAvailable } = latest.current;
      const state = game ?? latest.current.state;
      const line = mainLine(state);
      if (!line.length) {
        setError('There are no moves to review.');
        setPhase('error');
        return;
      }
      // The lightest build: fast to load, one thread, so the review stays in the background.
      const source = resolveEngineSource({ ...engineSettings, engineId: 'sf19-lite-single', enabled: true }, engineAvailable ?? {});
      if (!source) {
        setError('No Stockfish build is available (see the Engine settings).');
        setPhase('error');
        return;
      }
      const me: { cancelled: boolean; client: EngineClient | null } = { cancelled: false, client: null };
      run.current = me;
      setError(null);
      setPhase('loading');
      setProgress({ done: 0, total: line.length + 1 });
      try {
        const client = new EngineClient(source.script, source.remote);
        me.client = client;
        await new Promise<void>((resolve, reject) => {
          client.onError = (m) => reject(new Error(m));
          const timer = setTimeout(() => reject(new Error('the engine did not start')), 60_000);
          client.init().then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (e) => {
              clearTimeout(timer);
              reject(e);
            },
          );
        });
        client.onError = undefined;
        if (me.cancelled) return;
        await client.setOption('Threads', 1);
        await client.setOption('Hash', 16);
        await client.setOption('MultiPV', 1);
        await client.newGame();
        setPhase('running');

        const chess = new Chess(state.startFen);
        const evals: Score[] = [];
        const best: (string | undefined)[] = [];
        for (let i = 0; i <= line.length; i++) {
          if (me.cancelled) return;
          const done = terminalScore(chess);
          if (done) {
            evals.push(done);
            best.push(undefined);
          } else {
            const r = await client.bestMove(chess.fen(), { depth: d }, 120_000);
            if (me.cancelled) return;
            evals.push({ cp: r.cp, mate: r.mate });
            let san: string | undefined;
            if (r.move) {
              try {
                san = new Chess(chess.fen()).move({ from: r.move.slice(0, 2), to: r.move.slice(2, 4), promotion: r.move[4] }).san;
              } catch {
                san = undefined;
              }
            }
            best.push(san);
          }
          setProgress({ done: i + 1, total: line.length + 1 });
          if (i < line.length) chess.move(line[i].san);
        }

        const moves = judgeMoves(line, evals, best);
        const review: GameReview = {
          depth: d,
          engine: client.info.name,
          moves,
          white: sideSummary(movesOf(moves, 'white')),
          black: sideSummary(movesOf(moves, 'black')),
          plies: line.length,
          createdAt: Date.now(),
        };
        const notes = moves
          .filter((m) => m.cls === 'blunder' || m.cls === 'mistake')
          .map((m) => ({ nodeId: m.nodeId, text: reviewNote(m), color: (m.cls === 'blunder' ? 'pink' : 'blue') as NoteColor }));
        // The game may have changed meanwhile: only annotate if the reviewed moves are still there.
        const now = latest.current.state;
        if (line.every((m) => now.nodes[m.nodeId])) latest.current.dispatch({ type: 'APPLY_REVIEW', review, notes });
        else throw new Error('the game changed during the review; run it again');
      } catch (e) {
        if (!me.cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
        }
        return;
      } finally {
        me.client?.terminate();
        if (run.current === me) run.current = null;
      }
      if (!me.cancelled) {
        setPhase('idle');
        setProgress(null);
      }
    },
    [depth, setPhase],
  );

  const clear = useCallback(() => latest.current.dispatch({ type: 'APPLY_REVIEW', review: null, notes: [] }), []);

  return { phase, busy: phase === 'loading' || phase === 'running', progress, error, depth, setDepth, start, cancel, clear };
}
