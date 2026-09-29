import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Chess, DEFAULT_POSITION } from 'chess.js';
import { EngineClient } from '../engine/EngineClient';
import { ENGINE_BUILDS, resolveEngineSource, type EngineAvailability, type EngineSettings, type EngineSource } from '../engine/engines';
import type { useChessMind } from '../chessmind/useChessMind';
import { thinkText } from './exportSim';
import { uciToSan } from '../chessmind/san';
import { DEFAULT_THINK_MOVE_TOKENS, type PickThink, type ThinkMode } from '../chessmind/protocol';
import { pathTo, type GameAction } from '../state/gameReducer';
import { newId } from '../state/pgn';
import { ROOT_ID, type GameState } from '../types';

type ChessMind = ReturnType<typeof useChessMind>;

export interface SimSettings {
  open: boolean;
  modelColor: 'white' | 'black' | 'alternate';
  /** Stockfish UCI "Skill Level" 0-20. */
  skill: number;
  limitKind: 'movetime' | 'nodes';
  movetime: number;
  nodes: number;
  choice: 'argmax' | 'sample';
  temperature: number;
  start: 'current' | 'initial';
  games: number;
  /** Pause after each move, for watching (ms). */
  delay: number;
  maxPlies: number;
  /** Think before moving (models that can think; ChessMind's think-then-move): never, the model's choice, always. */
  think: ThinkMode;
  /** Think budget (tokens) per move. */
  thinkTokens: number;
}

export const DEFAULT_SIM_SETTINGS: SimSettings = {
  open: false,
  modelColor: 'alternate',
  skill: 3,
  limitKind: 'movetime',
  movetime: 100,
  nodes: 5000,
  choice: 'argmax',
  temperature: 0.7,
  start: 'current',
  games: 4,
  delay: 300,
  maxPlies: 300,
  think: 'off',
  thinkTokens: DEFAULT_THINK_MOVE_TOKENS,
};

/** The think before the model's latest move: the position it thought about and, once played, the move (SAN). */
export interface SimThought {
  fen: string;
  ply: number;
  san: string | null;
  think: PickThink;
}

export type SimResult = '1-0' | '0-1' | '1/2-1/2';

export interface SimGame {
  /** 1-based index within its run. */
  n: number;
  total: number;
  modelColor: 'w' | 'b';
  modelId: string;
  opponent: string;
  result: SimResult;
  /** Score for the model: 1, 0.5 or 0. */
  score: number;
  reason: string;
  plies: number;
  startFen: string;
  /** Node the game branches from, its first and last move nodes. */
  startId: string;
  firstId: string | null;
  lastId: string;
  /** Moves of this game only (UCI). */
  moves: string[];
  sans: string[];
  modelMs: number;
  engineMs: number;
  date: string;
  /** Every move of the game in order: who played it, from which position, and what went with it (exportSim.ts). */
  trace: SimMoveTrace[];
}

/** One move of a simulated game, for the export. */
export interface SimMoveTrace {
  ply: number;
  fen: string;
  side: 'model' | 'engine';
  uci: string;
  san: string;
  /** Model: probability of the played move and model time (ms); engine: search time and its eval (side to move). */
  p?: number;
  ms: number;
  evalText?: string;
  /** Model with thinking on: the reasoning before the move (plain text, lines in SAN), its tokens, cut off or not. */
  think?: { text: string; tokens: number; open: boolean; raw?: string };
  /** Model: its 5 most likely moves (SAN, probability) and the tail of the prompt it saw (think picks). */
  top?: { san: string; uci: string; p: number }[];
  prompt?: string;
}

export type SimPhase = 'idle' | 'loading' | 'running' | 'paused';

export interface SimLive {
  game: number;
  total: number;
  ply: number;
  modelColor: 'w' | 'b';
  message: string;
}

const STORAGE_KEY = 'notemate.simulate.v1';
const STANDARD = DEFAULT_POSITION.split(' ').slice(0, 4).join(' ');
const ADJUDICATE_CP = 400;
const ADJUDICATE_MS = 300;

function loadSettings(): SimSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SIM_SETTINGS, ...(JSON.parse(raw) as Partial<SimSettings>) };
  } catch {
    /* ignore */
  }
  return DEFAULT_SIM_SETTINGS;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const limitLabel = (s: Pick<SimSettings, 'limitKind' | 'movetime' | 'nodes'>) =>
  s.limitKind === 'nodes' ? `${s.nodes} nodes` : `${s.movetime} ms`;

class Cancelled extends Error {}

interface Control {
  cancelled: boolean;
  paused: boolean;
  steps: number;
  wake: (() => void) | null;
}

/** Engine build for the opponent: the analysis panel's selection, else Lite single-threaded. */
function opponentSources(settings: EngineSettings, available: Record<string, EngineAvailability> | null): EngineSource[] {
  const out: EngineSource[] = [];
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const build = ENGINE_BUILDS.find((b) => b.id === settings.engineId);
  const usable = !(build?.threaded && !isolated) && !(build && available?.[build.id] === 'missing');
  const chosen = usable ? resolveEngineSource(settings, available) : null;
  if (chosen) out.push(chosen);
  const lite = resolveEngineSource({ ...settings, engineId: 'sf19-lite-single' }, available);
  if (lite && !out.some((s) => s.script === lite.script)) out.push(lite);
  return out;
}

async function startEngine(src: EngineSource): Promise<EngineClient> {
  const client = new EngineClient(src.script, src.remote);
  try {
    await new Promise<void>((resolve, reject) => {
      client.onError = (m) => reject(new Error(m));
      const big = /stockfish-19(\.|-single)/.test(src.script) || src.script.includes('chunked');
      const timer = setTimeout(() => reject(new Error('engine did not start')), big ? 10 * 60_000 : 60_000);
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
    return client;
  } catch (e) {
    client.terminate();
    throw e;
  }
}

/**
 * Plays the ChessMind model against a separate Stockfish instance into the move tree. The loop is async
 * (awaits the model worker and the engine worker) and checks a cancellation token between steps.
 */
export function useSimulate(opts: {
  state: GameState;
  dispatch: (a: GameAction) => void;
  cm: ChessMind;
  engineSettings: EngineSettings;
  engineAvailable: Record<string, EngineAvailability> | null;
}) {
  const [settings, setSettings] = useState<SimSettings>(loadSettings);
  const [phase, setPhase] = useState<SimPhase>('idle');
  const [games, setGames] = useState<SimGame[]>([]);
  const [live, setLive] = useState<SimLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engineName, setEngineName] = useState('');
  const [thought, setThought] = useState<SimThought | null>(null);
  const [latency, setLatency] = useState<{ model: number[]; modelWall: number[]; engine: number[] }>({ model: [], modelWall: [], engine: [] });

  const latest = useRef(opts);
  const settingsRef = useRef(settings);
  // The async loop reads the newest props (state, model status) through these refs.
  useLayoutEffect(() => {
    latest.current = opts;
    settingsRef.current = settings;
  });
  const ctl = useRef<Control | null>(null);
  const engineRef = useRef<{ client: EngineClient; script: string } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const update = useCallback((patch: Partial<SimSettings>) => setSettings((s) => ({ ...s, ...patch })), []);

  // Stop everything on unmount.
  useEffect(
    () => () => {
      if (ctl.current) {
        ctl.current.cancelled = true;
        ctl.current.wake?.();
      }
      engineRef.current?.client.terminate();
      engineRef.current = null;
    },
    [],
  );

  const getEngine = async (c: Control): Promise<EngineClient> => {
    const { engineSettings, engineAvailable } = latest.current;
    const sources = opponentSources(engineSettings, engineAvailable);
    if (engineRef.current && sources.some((s) => s.script === engineRef.current!.script)) return engineRef.current.client;
    engineRef.current?.client.terminate();
    engineRef.current = null;
    let lastErr: unknown = null;
    for (const src of sources) {
      if (c.cancelled) throw new Cancelled();
      try {
        const client = await startEngine(src);
        engineRef.current = { client, script: src.script };
        setEngineName(client.info.name);
        return client;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('could not start Stockfish');
  };

  /** Wait while paused; a Step lets exactly one move through. */
  const gate = async (c: Control) => {
    while (c.paused && c.steps === 0 && !c.cancelled) await new Promise<void>((r) => (c.wake = r));
    c.wake = null;
    if (c.cancelled) throw new Cancelled();
    if (c.paused && c.steps > 0) c.steps--;
  };

  const run = async (c: Control) => {
    const s = { ...settingsRef.current };
    /** The game in progress, for a note when it is stopped. */
    let current: { parent: string; plies: number; g: number } | null = null;
    try {
      // Model: turn the panel on and wait for it.
      if (!latest.current.cm.settings.enabled) latest.current.cm.update({ enabled: true });
      setPhase('loading');
      setLive({ game: 0, total: s.games, ply: 0, modelColor: 'w', message: 'Waiting for the ChessMind model to load…' });
      for (;;) {
        if (c.cancelled) throw new Cancelled();
        const st = latest.current.cm.status;
        if (st === 'ready') break;
        if (st === 'error') throw new Error(`ChessMind: ${latest.current.cm.error ?? 'model failed to load'}`);
        if (latest.current.cm.modelsError) throw new Error(latest.current.cm.modelsError);
        await sleep(150);
      }
      latest.current.cm.setSuspended(true);
      setLive((l) => l && { ...l, message: 'Starting Stockfish…' });
      const engine = await getEngine(c);
      await engine.setOption('Threads', 1);
      await engine.setOption('Hash', 16);
      await engine.setOption('MultiPV', 1);

      const st0 = latest.current.state;
      if (st0.startFen.split(' ').slice(0, 4).join(' ') !== STANDARD) {
        throw new Error('ChessMind follows games from the initial position; this game starts from a custom FEN (use New game).');
      }
      const startId = s.start === 'initial' ? ROOT_ID : st0.currentId;
      const prefix: string[] = [];
      {
        const ch = new Chess(st0.startFen);
        for (const node of pathTo(st0, startId)) prefix.push(ch.move(node.san).lan);
      }
      const modelId = latest.current.cm.modelId;
      const opponent = `Stockfish Skill ${s.skill} (${limitLabel(s)})`;
      const limit = s.limitKind === 'nodes' ? { nodes: s.nodes } : { movetime: s.movetime };
      setPhase(c.paused ? 'paused' : 'running');

      for (let g = 1; g <= s.games; g++) {
        if (c.cancelled) throw new Cancelled();
        if (!latest.current.state.nodes[startId]) throw new Error('the start position was deleted');
        const modelColor: 'w' | 'b' = s.modelColor === 'white' ? 'w' : s.modelColor === 'black' ? 'b' : g % 2 === 1 ? 'w' : 'b';
        const label = `ChessMind (${modelId}) vs ${opponent} — game ${g} of ${s.games}`;
        const colourText = modelColor === 'w' ? 'ChessMind plays White' : 'ChessMind plays Black';
        await engine.newGame();
        await engine.setOption('Skill Level', s.skill);

        const chess = new Chess();
        for (const u of prefix) chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        const startFen = chess.fen();
        const moves = [...prefix];
        const gameMoves: string[] = [];
        // The running thread: ChessMind's thinks so far in this game ({index in moves: ids}), fed back into its next
        // think picks as training shows them (ChessMind data.think_chain; the worker drops the oldest to fit)
        const thinks: Record<number, number[]> = {};
        const trace: SimMoveTrace[] = [];
        let pending: Omit<SimMoveTrace, 'san' | 'ply'> | null = null;
        const sans: string[] = [];
        let parent = startId;
        let firstId: string | null = null;
        let modelMs = 0;
        let modelN = 0;
        let engineMs = 0;
        let engineN = 0;
        let result: SimResult | null = null;
        let reason = '';

        setLive({ game: g, total: s.games, ply: 0, modelColor, message: label });
        for (;;) {
          // Game over?
          if (chess.isCheckmate()) {
            result = chess.turn() === 'w' ? '0-1' : '1-0';
            reason = 'checkmate';
          } else if (chess.isStalemate()) [result, reason] = ['1/2-1/2', 'stalemate'];
          else if (chess.isInsufficientMaterial()) [result, reason] = ['1/2-1/2', 'insufficient material'];
          else if (chess.isThreefoldRepetition()) [result, reason] = ['1/2-1/2', 'threefold repetition'];
          else if (chess.isDrawByFiftyMoves()) [result, reason] = ['1/2-1/2', '50-move rule'];
          else if (gameMoves.length >= s.maxPlies) {
            // Adjudicate with a quick full-strength search.
            await engine.setOption('Skill Level', 20);
            const ev = await engine.bestMove(chess.fen(), { movetime: ADJUDICATE_MS });
            await engine.setOption('Skill Level', s.skill);
            const sign = chess.turn() === 'w' ? 1 : -1;
            const cpWhite = ev.mate !== undefined ? sign * Math.sign(ev.mate || -1) * 100000 : sign * (ev.cp ?? 0);
            const evalText = ev.mate !== undefined ? `mate ${ev.mate * sign}` : `${cpWhite >= 0 ? '+' : ''}${(cpWhite / 100).toFixed(2)}`;
            if (Math.abs(cpWhite) >= ADJUDICATE_CP) [result, reason] = [cpWhite > 0 ? '1-0' : '0-1', `adjudicated at ${s.maxPlies} plies, eval ${evalText}`];
            else [result, reason] = ['1/2-1/2', `adjudicated draw at ${s.maxPlies} plies, eval ${evalText}`];
          }
          if (result) break;

          await gate(c);
          setPhase(c.paused ? 'paused' : 'running');
          const fen = chess.fen();
          const modelTurn = chess.turn() === modelColor;
          let uci: string | null;
          const t0 = performance.now();
          if (modelTurn) {
            const ply = gameMoves.length;
            const r = await latest.current.cm.pick(moves, s.choice === 'sample' ? s.temperature : 0, {
              think: s.think,
              maxThinkTokens: s.thinkTokens,
              onThink: (think) => setThought({ fen, ply, san: null, think }),
              thinks,
            });
            const wall = performance.now() - t0;
            uci = r.uci;
            if (r.think?.ids && r.uci) thinks[moves.length] = r.think.ids;
            if (s.think !== 'off') setThought(r.think ? { fen, ply, san: null, think: r.think } : null);
            pending = {
              fen, side: 'model', uci: r.uci ?? '', p: r.p, ms: Math.round(wall),
              ...(r.think ? { think: { text: thinkText(r.think.parts, fen), tokens: r.think.tokens, open: !!r.think.open, raw: r.think.raw } } : {}),
              ...(r.top ? { top: r.top.map((m) => ({ uci: m.uci, san: uciToSan(fen, m.uci), p: Number(m.p.toFixed(4)) })) } : {}),
              ...(r.prompt ? { prompt: r.prompt } : {}),
            };
            modelMs += wall;
            modelN++;
            setLatency((l) => ({ ...l, model: [...l.model, r.ms], modelWall: [...l.modelWall, wall] }));
          } else {
            const r = await engine.bestMove(fen, limit);
            const wall = performance.now() - t0;
            uci = r.move;
            pending = {
              fen, side: 'engine', uci: r.move ?? '', ms: Math.round(wall),
              ...(r.mate !== undefined ? { evalText: `mate ${r.mate}` } : r.cp !== undefined ? { evalText: `${r.cp >= 0 ? '+' : ''}${(r.cp / 100).toFixed(2)}` } : {}),
            };
            engineMs += wall;
            engineN++;
            setLatency((l) => ({ ...l, engine: [...l.engine, wall] }));
          }
          if (c.cancelled) throw new Cancelled();
          if (!uci) throw new Error(`${modelTurn ? 'ChessMind' : 'Stockfish'} returned no move in ${fen}`);
          let san: string;
          try {
            san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
          } catch {
            throw new Error(`${modelTurn ? 'ChessMind' : 'Stockfish'} played an illegal move ${uci} in ${fen}`);
          }
          if (modelTurn && s.think !== 'off') {
            const played = san;
            setThought((th) => (th && th.fen === fen ? { ...th, san: played } : th));
          }
          const id = newId();
          latest.current.dispatch({ type: 'APPEND_MOVE', parentId: parent, uci, id, goto: true });
          if (firstId === null) {
            firstId = id;
            latest.current.dispatch({ type: 'ADD_NOTE', nodeId: id, color: 'chessmind', text: `${label} (${colourText})` });
          }
          parent = id;
          moves.push(uci);
          gameMoves.push(uci);
          sans.push(san);
          if (pending) trace.push({ ...pending, ply: gameMoves.length, san });
          pending = null;
          current = { parent: id, plies: gameMoves.length, g };
          setLive({ game: g, total: s.games, ply: gameMoves.length, modelColor, message: label });
          await sleep(s.delay);
        }

        current = null;
        const score = result === '1/2-1/2' ? 0.5 : (result === '1-0') === (modelColor === 'w') ? 1 : 0;
        const verdict = score === 1 ? 'ChessMind wins' : score === 0 ? 'Stockfish wins' : 'draw';
        latest.current.dispatch({
          type: 'ADD_NOTE',
          nodeId: parent,
          color: 'chessmind',
          text: `Result ${result} (${reason}) — ${verdict}. Game ${g} of ${s.games}, ${gameMoves.length} plies.`,
        });
        const game: SimGame = {
          n: g,
          total: s.games,
          modelColor,
          modelId,
          opponent,
          result,
          score,
          reason,
          plies: gameMoves.length,
          startFen,
          startId,
          firstId,
          lastId: parent,
          moves: gameMoves,
          sans,
          modelMs: modelN ? modelMs / modelN : 0,
          engineMs: engineN ? engineMs / engineN : 0,
          date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
          trace,
        };
        setGames((gs) => [...gs, game]);
      }
      setLive((l) => l && { ...l, message: `Finished ${s.games} game${s.games === 1 ? '' : 's'}.` });
    } catch (e) {
      if (current) {
        const text = `Simulation ${e instanceof Cancelled ? 'stopped' : 'aborted'} after ${current.plies} plies (game ${current.g} of ${s.games}, unfinished).`;
        latest.current.dispatch({ type: 'ADD_NOTE', nodeId: current.parent, color: 'chessmind', text });
      }
      if (e instanceof Cancelled) setLive((l) => l && { ...l, message: 'Stopped.' });
      else {
        setError(e instanceof Error ? e.message : String(e));
        setLive(null);
      }
    } finally {
      latest.current.cm.setSuspended(false);
      if (ctl.current === c) ctl.current = null;
      setPhase('idle');
    }
  };

  const start = useCallback((paused = false) => {
    if (ctl.current) return;
    const c: Control = { cancelled: false, paused, steps: paused ? 1 : 0, wake: null };
    ctl.current = c;
    setError(null);
    setThought(null);
    setLatency({ model: [], modelWall: [], engine: [] });
    void run(c);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pause = useCallback(() => {
    if (!ctl.current) return;
    ctl.current.paused = true;
    setPhase((p) => (p === 'running' ? 'paused' : p));
  }, []);

  const resume = useCallback(() => {
    const c = ctl.current;
    if (!c) return;
    c.paused = false;
    c.wake?.();
    setPhase((p) => (p === 'paused' ? 'running' : p));
  }, []);

  const stop = useCallback(() => {
    const c = ctl.current;
    if (!c) return;
    c.cancelled = true;
    c.wake?.();
    engineRef.current?.client.stop();
    latest.current.cm.stopPicks();
  }, []);

  /** One move: starts a paused run if none is going. */
  const step = useCallback(() => {
    const c = ctl.current;
    if (!c) return start(true);
    c.paused = true;
    c.steps++;
    c.wake?.();
    setPhase((p) => (p === 'running' ? 'paused' : p));
  }, [start]);

  const clear = useCallback(() => setGames([]), []);

  return { settings, update, phase, games, live, error, engineName, latency, thought, start: () => start(false), pause, resume, stop, step, clear };
}
