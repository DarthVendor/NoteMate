/*
 * The tools ChessMind may call in NoteMate (tools.ts), run on the main thread: the engine tool searches the position
 * with a dedicated Stockfish (the configured build, else the single-threaded Lite build; never the analysis engine,
 * whose search follows the board) and answers with the `[Engine: ...]` block of promptContext.ts; the notes tools read
 * the user's notes on the current game tree (notesTool.ts).
 */
import { useCallback, useEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import { EngineClient } from '../engine/EngineClient';
import { resolveEngineSource, type EngineAvailability, type EngineSettings } from '../engine/engines';
import { engineInfoFor } from './chatContext';
import { engineToolResult, errorText, gameOverText, type ToolResultData } from './tools';
import { runNotesTool } from './notesTool';
import type { GameState } from '../types';

/** Search limits of one engine call: whichever comes first. */
export const TOOL_ENGINE_DEPTH = 16;
export const TOOL_ENGINE_MS = 2500;
export const TOOL_ENGINE_MULTIPV = 3;

export interface ToolCallRequest {
  name: string;
  fen: string;
  moves: string[];
  numbers: boolean;
}

export type RunTool = (req: ToolCallRequest) => Promise<ToolResultData>;

/** A finished position's result (no search needed), else null. */
export function finishedResult(fen: string): ToolResultData | null {
  let c: Chess;
  try {
    c = new Chess(fen);
  } catch {
    return { text: errorText('Engine', 'bad position'), ok: false };
  }
  const turn = c.turn();
  if (c.isCheckmate()) return { text: gameOverText('checkmate', turn), ok: true };
  if (c.isStalemate()) return { text: gameOverText('stalemate', turn), ok: true };
  if (c.isInsufficientMaterial()) return { text: gameOverText('insufficient', turn), ok: true };
  return null;
}

export function useChessMindTools(engineSettings: EngineSettings, engineAvailable: Record<string, EngineAvailability> | null, game: GameState | null = null): RunTool {
  const latest = useRef({ engineSettings, engineAvailable, game });
  useEffect(() => {
    latest.current = { engineSettings, engineAvailable, game };
  }, [engineSettings, engineAvailable, game]);
  const client = useRef<{ key: string; ready: Promise<EngineClient> } | null>(null);
  // one call at a time on the tool engine
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(
    () => () => {
      client.current?.ready.then((c) => c.terminate()).catch(() => undefined);
      client.current = null;
    },
    [],
  );

  const engine = useCallback((): Promise<EngineClient> => {
    const { engineSettings: s, engineAvailable: a } = latest.current;
    const source = resolveEngineSource({ ...s, enabled: true }, a ?? {}) ?? resolveEngineSource({ ...s, engineId: 'sf19-lite-single', enabled: true }, a ?? {});
    if (!source) return Promise.reject(new Error('no Stockfish build is available'));
    const key = `${source.script}|${source.remote}`;
    if (client.current?.key === key) return client.current.ready;
    client.current?.ready.then((c) => c.terminate()).catch(() => undefined);
    const ready = (async () => {
      const c = new EngineClient(source.script, source.remote);
      await new Promise<void>((resolve, reject) => {
        c.onError = (m) => reject(new Error(m));
        const timer = setTimeout(() => reject(new Error('the engine did not start')), 60_000);
        c.init().then(
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
      c.onError = undefined;
      await c.setOption('Threads', 1);
      await c.setOption('Hash', 16);
      await c.newGame();
      return c;
    })();
    ready.catch(() => {
      if (client.current?.ready === ready) client.current = null;
    });
    client.current = { key, ready };
    return ready;
  }, []);

  return useCallback<RunTool>(
    (req) => {
      // Notes are local and instant: no queue behind engine searches
      if (req.name === 'notes' || req.name === 'all_notes') return Promise.resolve(runNotesTool(latest.current.game, req.name, req.fen));
      const job = chain.current.then(async (): Promise<ToolResultData> => {
        if (req.name !== 'engine') return { text: errorText(req.name ? req.name[0].toUpperCase() + req.name.slice(1) : 'Tool', 'unknown tool'), ok: false };
        const done = finishedResult(req.fen);
        if (done) return done;
        try {
          const c = await engine();
          const lines = await c.searchLines(req.fen, { depth: TOOL_ENGINE_DEPTH, movetime: TOOL_ENGINE_MS }, TOOL_ENGINE_MULTIPV, TOOL_ENGINE_MS + 8000);
          const info = engineInfoFor(req.fen, { fen: req.fen, lines, name: c.info.name }, 1);
          if (!info) return { text: errorText('Engine', 'no line'), ok: false };
          return engineToolResult(req.fen, info, req.numbers);
        } catch (e) {
          return { text: errorText('Engine', /timed out/.test(String(e)) ? 'timeout' : 'error'), ok: false };
        }
      });
      chain.current = job.catch(() => undefined);
      return job;
    },
    [engine],
  );
}
