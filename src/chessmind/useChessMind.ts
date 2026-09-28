import { useCallback, useEffect, useRef, useState } from 'react';
import ChessMindWorker from './worker.ts?worker&inline';
import { DEFAULT_LINE_TEMPERATURE, DEFAULT_MAX_THINK_TOKENS, type Backend, type FromWorker, type ModelManifest, type MovePrediction, type ThinkMode, type ToWorker } from './protocol';
import { splitThink, type DialogueTurn } from './tokenizer';
import type { ChatMessage } from '../types';
import { DEFAULT_LINE_RULES } from './lineRules';
import type { GameAction } from '../state/gameReducer';
import { newId } from '../state/pgn';

/** One entry of chessmind/models.json (written by scripts/copy-chessmind.mjs). */
export interface ChessMindModel {
  id: string;
  name: string;
  params: number;
  sizeMb: number;
  step: number | null;
  hasText: boolean;
  /** Has the board-embedding input. */
  boards?: boolean;
  description?: string;
}

export interface ChessMindSettings {
  enabled: boolean;
  modelId: string;
  backend: Backend;
  arrows: boolean;
  /** Ask chat questions about the current board position (board snapshot; lines continue from it). */
  aboutPosition: boolean;
  /** Send the moves leading to the current position with each question. */
  sendMoves: boolean;
  /** Board-embedding models: moves fed for predictions ('full' or the last N plies; the board carries the rest). */
  contextPlies: 'full' | 8 | 16 | 32;
  /** Hidden reasoning before the answer (models that can think): always, the model's choice, or never. */
  think: ThinkMode;
  /** Chat text sampling temperature; move lines are always greedy (DEFAULT_LINE_TEMPERATURE). */
  temperature: number;
  /** A chat line ends once P(<|end_line|>) reaches this: in the answer, and inside the hidden reasoning. */
  lineEndAnswer: number;
  lineEndThink: number;
  /** Hard cap on plies per move line (the model can end earlier). */
  maxLinePliesAnswer: number;
  maxLinePliesThink: number;
}

export interface PickResult {
  uci: string | null;
  p: number;
  ms: number;
  tokens: number;
}

export type ChessMindStatus = 'off' | 'loading' | 'ready' | 'error';

const STORAGE_KEY = 'notemate.chessmind.v1';
/** Stored with the settings; older saves are migrated in loadSettings. */
const SETTINGS_VERSION = 2;
/** Plies of history the simulator gives a board-embedding model (see pick). */
const SIM_CONTEXT_PLIES = 16;
const DEFAULTS: ChessMindSettings = { enabled: false, modelId: '', backend: 'auto', arrows: true, aboutPosition: false, sendMoves: true, contextPlies: 'full', think: 'auto', temperature: 0.8, lineEndAnswer: DEFAULT_LINE_RULES.endP.answer, lineEndThink: DEFAULT_LINE_RULES.endP.think, maxLinePliesAnswer: DEFAULT_LINE_RULES.maxPlies.answer, maxLinePliesThink: DEFAULT_LINE_RULES.maxPlies.think };
/** Earlier chat turns (user + assistant messages) sent with a question, so follow-ups like "no, the other one"
 * have their context. The KV cache makes the extra prompt a one-off prefill; the worker trims the think budget
 * (and drops the oldest turns) to fit the context. */
const HISTORY_TURNS = 6;
export const CHAT_MAX_TOKENS = 60;
/** Budget of the hidden reasoning (on top of CHAT_MAX_TOKENS; the worker shrinks it to what the model's context leaves).
 * Training thinks run from ~50 to ~2,000 tokens; the close is forced gracefully at the budget. */
export const CHAT_MAX_THINK_TOKENS = DEFAULT_MAX_THINK_TOKENS;

function loadSettings(): ChessMindSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ChessMindSettings> & { v?: number };
      // v2: 'Always think' is no longer the default. Forced reasoning puts the model into its engine-review template
      // (the only chess reasoning it was trained on): it reviews an invented game instead of answering.
      if ((saved.v ?? 1) < SETTINGS_VERSION && saved.think === 'on') saved.think = 'auto';
      return { ...DEFAULTS, ...saved };
    }
  } catch {
    /* ignore */
  }
  return DEFAULTS;
}

const modelBase = (id: string) => new URL(`chessmind/${id}/`, location.href).href;

/**
 * Runs a ChessMind model in a worker. `moves` is the game so far in UCI from the standard
 * start position (null when the game has a custom start, which the model cannot follow).
 * The conversation lives in the game state (`chat`, updated through `dispatch`).
 */
export function useChessMind(moves: string[] | null, chat: ChatMessage[], dispatch: (a: GameAction) => void) {
  const [settings, setSettings] = useState<ChessMindSettings>(loadSettings);
  const [models, setModels] = useState<ChessMindModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [status, setStatus] = useState<ChessMindStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number; phase: 'download' | 'compile' } | null>(null);
  const [info, setInfo] = useState<{ manifest: ModelManifest; backend: string; loadMs: number; cached: boolean; hasText: boolean; thinking: boolean } | null>(null);
  const [prediction, setPrediction] = useState<{ key: string; moves: MovePrediction[]; ms: number; tokens: number } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const predictKeys = useRef(new Map<number, string>());
  /** Worker request id of the running generation and the chat message it writes to. */
  const chatId = useRef<number | null>(null);
  const chatMsg = useRef<string | null>(null);
  /** Outstanding pick() requests (the simulator), by worker request id. */
  const picks = useRef(new Map<number, { resolve: (r: PickResult) => void; reject: (e: Error) => void }>());
  /** While true the automatic prediction for the current position is skipped (the simulator drives the model). */
  const [suspended, setSuspended] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, v: SETTINGS_VERSION }));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const update = useCallback((patch: Partial<ChessMindSettings>) => setSettings((s) => ({ ...s, ...patch })), []);

  // Discover the exported models shipped next to the app.
  useEffect(() => {
    if (!settings.enabled || models) return;
    fetch('chessmind/models.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`chessmind/models.json: ${r.status}`))))
      .then((list: ChessMindModel[]) => {
        setModels(list);
        setModelsError(null);
      })
      .catch((e: Error) => setModelsError(`No ChessMind models found (${e.message}). Export one with ChessMind's scripts/export_onnx.py and run npm run chessmind.`));
  }, [settings.enabled, models]);

  const modelId = models?.some((m) => m.id === settings.modelId) ? settings.modelId : (models?.[0]?.id ?? '');

  // (Re)start the worker when the model or backend changes.
  useEffect(() => {
    if (!settings.enabled || !modelId) {
      setStatus('off');
      return;
    }
    setStatus('loading');
    setError(null);
    setProgress(null);
    setInfo(null);
    setPrediction(null);
    setChatBusy(false);
    const worker = new ChessMindWorker();
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      switch (m.type) {
        case 'progress':
          setProgress({ loaded: m.loaded, total: m.total, phase: m.phase });
          break;
        case 'ready':
          setInfo({ manifest: m.manifest, backend: m.backend, loadMs: m.loadMs, cached: m.cached, hasText: m.hasText, thinking: !!m.thinking });
          setStatus('ready');
          break;
        case 'prediction': {
          const key = predictKeys.current.get(m.id);
          predictKeys.current.delete(m.id);
          if (key !== undefined) setPrediction({ key, moves: m.moves, ms: m.ms, tokens: m.tokens });
          break;
        }
        case 'chat-update':
          if (m.id !== chatId.current || !chatMsg.current) break;
          dispatch({
            type: 'CHAT_PATCH',
            id: chatMsg.current,
            patch: { parts: m.parts, tokens: m.tokens, msPerToken: m.msPerToken, prefillMs: m.prefillMs, done: m.done, stopped: m.stopped, ...(m.predictions ? { predictions: m.predictions } : {}) },
          });
          if (m.done) {
            setChatBusy(false);
            chatId.current = null;
            chatMsg.current = null;
          }
          break;
        case 'debug':
          console.log('[chessmind-debug]', JSON.stringify(m.data));
          break;
        case 'picked': {
          const p = picks.current.get(m.id);
          picks.current.delete(m.id);
          p?.resolve({ uci: m.uci, p: m.p, ms: m.ms, tokens: m.tokens });
          break;
        }
        case 'error':
          if (m.id !== undefined && picks.current.has(m.id)) {
            picks.current.get(m.id)!.reject(new Error(m.message));
            picks.current.delete(m.id);
            break;
          }
          if (m.id !== undefined && m.id === chatId.current) {
            if (chatMsg.current) dispatch({ type: 'CHAT_PATCH', id: chatMsg.current, patch: { done: true, stopped: true } });
            setChatBusy(false);
            chatId.current = null;
            chatMsg.current = null;
            setError(m.message);
          } else if (m.id === undefined) {
            setStatus('error');
            setError(m.message);
          }
          break;
      }
    };
    worker.onerror = (e) => {
      setStatus('error');
      setError(e.message || 'ChessMind worker failed');
    };
    let debug = false;
    try {
      debug = localStorage.getItem('notemate.chessmind.debug') === '1';
    } catch {
      /* ignore */
    }
    worker.postMessage({ type: 'load', base: modelBase(modelId), backend: settings.backend, debug } satisfies ToWorker);
    const pending = picks.current;
    return () => {
      worker.terminate();
      workerRef.current = null;
      for (const p of pending.values()) p.reject(new Error('ChessMind model unloaded'));
      pending.clear();
      if (chatMsg.current) dispatch({ type: 'CHAT_PATCH', id: chatMsg.current, patch: { done: true, stopped: true } });
      chatId.current = null;
      chatMsg.current = null;
    };
  }, [settings.enabled, modelId, settings.backend, dispatch]);

  // Cropped context only applies to models with the board input.
  const contextPlies = info?.manifest.boards && settings.contextPlies !== 'full' ? settings.contextPlies : null;

  // Predict the next move whenever the position changes.
  const movesKey = moves ? moves.join(' ') : null;
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker || status !== 'ready' || movesKey === null || suspended) return;
    const timer = setTimeout(() => {
      const id = ++reqId.current;
      predictKeys.current.set(id, `${movesKey}|${contextPlies}`);
      worker.postMessage({ type: 'predict', id, moves: movesKey ? movesKey.split(' ') : [], top: 5, contextPlies } satisfies ToWorker);
    }, 60);
    return () => clearTimeout(timer);
  }, [movesKey, status, contextPlies, suspended]);

  /** One model move for the position after `movesUci` (from the standard start), legal-masked. */
  const pick = useCallback(
    (movesUci: string[], temperature: number): Promise<PickResult> => {
      const worker = workerRef.current;
      if (!worker || status !== 'ready') return Promise.reject(new Error('load a ChessMind model first'));
      const id = ++reqId.current;
      return new Promise<PickResult>((resolve, reject) => {
        picks.current.set(id, { resolve, reject });
        // The graph has no KV cache, so a full-history pick costs O(plies) per move and games got slower and
        // slower (0.5 s -> 3 s by ply 50 for the 250M model). Board models barely use history beyond a few plies
        // (probe: 44.2% top-1 with the full game vs 43.9% with 4 plies), so the simulator caps it at 16.
        const simContext = info?.manifest.boards ? Math.min(contextPlies ?? SIM_CONTEXT_PLIES, SIM_CONTEXT_PLIES) : contextPlies;
        worker.postMessage({ type: 'pick', id, moves: movesUci, temperature, contextPlies: simContext } satisfies ToWorker);
      });
    },
    [status, contextPlies, info?.manifest.boards],
  );

  /** Send a question to the model; the answer streams into a new assistant message. */
  const ask = useCallback(
    (prompt: string, opts: { originId: string; fen?: string; context?: string[] }) => {
      const worker = workerRef.current;
      const text = prompt.trim();
      if (!worker || status !== 'ready' || chatId.current !== null || !text) return;
      const turns = HISTORY_TURNS > 0 ? chat.filter((m) => m.kind === 'model' && (m.role === 'user' || m.parts.length > 0)).slice(-HISTORY_TURNS) : [];
      if (turns[0]?.role === 'assistant') turns.shift();
      // Earlier answers without their hidden reasoning, as in training data.
      const history: DialogueTurn[] = turns.map((m) => ({
        role: m.role,
        parts: m.role === 'user' && m.fen ? [{ kind: 'fen', fen: m.fen }, ...m.parts] : splitThink(m.parts).answer,
      }));
      const id = ++reqId.current;
      const answerId = newId();
      chatId.current = id;
      chatMsg.current = answerId;
      setChatBusy(true);
      setError(null);
      dispatch({
        type: 'CHAT_APPEND',
        messages: [
          { id: newId(), role: 'user', kind: 'model', parts: [{ kind: 'text', text }], originId: opts.originId, fen: opts.fen, context: opts.context },
          { id: answerId, role: 'assistant', kind: 'model', parts: [], originId: opts.originId, fen: opts.fen },
        ],
      });
      worker.postMessage({ type: 'chat', id, history, prompt: text, fen: opts.fen, context: opts.context, maxTokens: CHAT_MAX_TOKENS, temperature: settings.temperature, topK: 50, lineTemperature: DEFAULT_LINE_TEMPERATURE, think: settings.think, maxThinkTokens: CHAT_MAX_THINK_TOKENS, lineRules: { endP: { answer: settings.lineEndAnswer, think: settings.lineEndThink }, maxPlies: { answer: settings.maxLinePliesAnswer, think: settings.maxLinePliesThink } } } satisfies ToWorker);
    },
    [chat, status, dispatch, settings.think, settings.temperature, settings.lineEndAnswer, settings.lineEndThink, settings.maxLinePliesAnswer, settings.maxLinePliesThink],
  );

  /** Top moves for the position after `movesUci` plus a short explanation from the model. */
  const analyse = useCallback(
    (prompt: string, movesUci: string[], originId: string) => {
      const worker = workerRef.current;
      if (!worker || status !== 'ready' || chatId.current !== null) return;
      const id = ++reqId.current;
      const answerId = newId();
      chatId.current = id;
      chatMsg.current = answerId;
      setChatBusy(true);
      setError(null);
      dispatch({
        type: 'CHAT_APPEND',
        messages: [
          { id: newId(), role: 'user', kind: 'analysis', parts: [{ kind: 'text', text: prompt.trim() }], originId },
          { id: answerId, role: 'assistant', kind: 'analysis', parts: [], originId, context: movesUci },
        ],
      });
      worker.postMessage({ type: 'explain', id, moves: movesUci, maxTokens: 40, temperature: 0.8, topK: 50, top: 5, contextPlies } satisfies ToWorker);
    },
    [status, dispatch, contextPlies],
  );

  const stop = useCallback(() => {
    if (chatId.current !== null) workerRef.current?.postMessage({ type: 'stop', id: chatId.current } satisfies ToWorker);
  }, []);

  /** Forget the running generation (e.g. when the game, and with it the chat, is reset). */
  const detach = useCallback(() => {
    stop();
    chatId.current = null;
    chatMsg.current = null;
    setChatBusy(false);
  }, [stop]);

  const currentPrediction = prediction && prediction.key === `${movesKey}|${contextPlies}` ? prediction : null;

  return { pick, setSuspended, contextPlies, settings, update, models, modelsError, modelId, status, error, progress, info, prediction: currentPrediction, chatBusy, canGenerate: status === 'ready' && !chatBusy, ask, analyse, stop, detach };
}
