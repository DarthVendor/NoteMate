/*
 * Puzzle mode state (PuzzlePanel.tsx): the position being solved (the board node when opened, or a Lichess trainer
 * puzzle), the goal, and three ways to solve it:
 *  - Ask ChessMind: the training layout with think on, answers streaming into the chat, each try verified
 *    (puzzleVerify.ts) and retried with the refutation up to `attempts` (puzzleRun.ts);
 *  - Solve it myself: the user plays on the board; each solver move is checked (the known solution first, else the
 *    engine), a correct one gets the defender's reply ~400 ms later, a wrong one shows why;
 *  - Hint / Show solution.
 * Verification runs on the puzzle mode's own Stockfish (puzzleEngine.ts), never the analysis engine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { GameAction } from '../state/gameReducer';
import { positionAt, resolveLine } from '../state/gameReducer';
import { newId } from '../state/pgn';
import { pushHistory } from '../state/history';
import { ROOT_ID, type GameState } from '../types';
import { DEFAULT_ENGINE_SETTINGS, resolveEngineSource, type EngineAvailability, type EngineSettings } from '../engine/engines';
import type { useChessMind } from './useChessMind';
import { answerLine, appGoalText, detectGoal, dialogueStart, filterPuzzles, goalText, goalTurn, hintText, parseTrainerSet, retryTurns, sideName, sideOf, trainerSpec, turnText, type PuzzleGoal, type PuzzleSpec, type TrainerPuzzle, type TrainerSet } from './puzzle';
import { bestMoveAt, EvalCache, mateDepth, type MoveVerdict, verifyMateLine, verifyMove } from './puzzleVerify';
import type { DialogueTurn } from './tokenizer';
import { PuzzleEngine } from './puzzleEngine';
import { modelSolve, PUZZLE_GEN, type PuzzleAttempt } from './puzzleRun';

type ChessMindState = ReturnType<typeof useChessMind>;

export const TRAINER_URL = 'puzzles/lichess.json';
export const TRAINER_EVENT = 'Lichess puzzle';
const STATS_KEY = 'notemate.puzzles.v1';
const REPLY_MS = 400;

export interface PuzzleStats {
  /** Per theme (and 'all'): solved / failed. */
  themes: Record<string, { solved: number; failed: number }>;
  /** Recently served puzzle ids (not served again soon). */
  seen: string[];
}

function loadStats(): PuzzleStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as PuzzleStats;
      if (s && typeof s.themes === 'object' && Array.isArray(s.seen)) return s;
    }
  } catch {
    /* ignore */
  }
  return { themes: {}, seen: [] };
}

function saveStats(s: PuzzleStats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** UCI of the move that led to `id` (null for the root). */
export function nodeUci(state: GameState, id: string): string | null {
  const node = state.nodes[id];
  if (!node || node.parent === null) return null;
  try {
    const mv = positionAt(state, node.parent).move(node.san);
    return mv.from + mv.to + (mv.promotion ?? '');
  } catch {
    return null;
  }
}

/** The puzzle spec of a board node: its position, and the opponent's last move when the node has a parent. */
export function specAt(state: GameState, id: string, goal: PuzzleGoal): PuzzleSpec {
  const position = positionAt(state, id).fen();
  const node = state.nodes[id];
  const setup = nodeUci(state, id);
  if (node?.parent !== null && node?.parent !== undefined && setup) return { position, start: positionAt(state, node.parent).fen(), setup, goal };
  return { position, goal };
}

export type SolveStatus = 'waiting' | 'checking' | 'wrong' | 'unknown' | 'done';

export interface SolveState {
  status: SolveStatus;
  /** Node where the solver is to move. */
  expectNode: string;
  /** Moves played from the puzzle position (solver and defender). */
  played: string[];
  /** `played` is a prefix of the known solution. */
  onSolution: boolean;
  /** The user's last checked move node. */
  checkedNode?: string;
  message?: string;
  verdict?: MoveVerdict;
  wrongNode?: string;
}

export interface PuzzleOutcome {
  by: 'you' | 'chessmind';
  ok: boolean;
  line: string[];
  message: string;
}

export interface PuzzleSession {
  spec: PuzzleSpec;
  /** The node of the puzzle position. */
  nodeId: string;
  /** Node ids that existed when the puzzle started (a wrong try's new branch may be removed again). */
  preexisting: Set<string>;
  trainer?: TrainerPuzzle;
  /** A mistake, hint or revealed solution: a trainer solve no longer counts as clean. */
  tainted: boolean;
  recorded: boolean;
}

/** A puzzle question / answer in the chat (a goal typed in the chat, or a puzzle-mode try), by message id: the
 * badge on the question, the check under the answer. */
export interface ChatGoalCheck {
  role: 'question' | 'answer';
  spec: PuzzleSpec;
  nodeId: string;
  /** The dialogue up to and including this answer's question. */
  turns: DialogueTurn[];
  status: 'thinking' | 'checking' | 'done';
  verdict?: MoveVerdict | null;
  line?: string[] | null;
  where?: 'answer' | 'think';
  lineOk?: boolean | null;
  lineReason?: string;
  /** Why there is no verdict ("No move given"). */
  reason?: string;
  /** Puzzle-mode tries retry on their own: no Retry button. */
  auto?: boolean;
  retried?: boolean;
}

interface Opts {
  cm: ChessMindState;
  state: GameState;
  dispatch: (a: GameAction) => void;
  engine?: { settings: EngineSettings; available: Record<string, EngineAvailability> | null } | null;
  orientation?: 'white' | 'black';
  flip?: () => void;
}

export function usePuzzle({ cm, state, dispatch, engine, orientation, flip }: Opts) {
  const [open, setOpen] = useState(false);
  const [goal, setGoalState] = useState<PuzzleGoal>({ kind: 'best' });
  const [attempts, setAttempts] = useState(3);
  const [session, setSession] = useState<PuzzleSession | null>(null);
  const [solve, setSolve] = useState<SolveState | null>(null);
  const [run, setRun] = useState<{ attempts: PuzzleAttempt[]; running: boolean; solved: boolean | null; explain?: boolean } | null>(null);
  const [hint, setHint] = useState<{ level: 0 | 1 | 2; text: string | null; busy?: boolean }>({ level: 0, text: null });
  const [solution, setSolution] = useState<{ line: string[]; source: 'known' | 'engine' | 'none'; busy?: boolean } | null>(null);
  const [outcome, setOutcome] = useState<PuzzleOutcome | null>(null);
  const [trainerSet, setTrainerSet] = useState<TrainerSet | null>(null);
  const [trainerError, setTrainerError] = useState<string | null>(null);
  const [stats, setStats] = useState<PuzzleStats>(loadStats);
  const [chatGoals, setChatGoals] = useState<Record<string, ChatGoalCheck>>({});
  const patchGoal = useCallback((id: string, patch: Partial<ChatGoalCheck>) => setChatGoals((g) => (g[id] ? { ...g, [id]: { ...g[id], ...patch } } : g)), []);

  const latest = useRef({ state, engine, cm, session, solve });
  useEffect(() => {
    latest.current = { state, engine, cm, session, solve };
  });
  const cancelled = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (fn: () => void, ms: number) => timers.current.push(setTimeout(fn, ms));

  // The puzzle mode's own Stockfish (started on first use) and the engine results of this session
  const engineRef = useRef<PuzzleEngine | null>(null);
  const getEngine = useCallback((): PuzzleEngine | null => {
    if (typeof Worker === 'undefined') return null;
    if (!engineRef.current)
      engineRef.current = new PuzzleEngine(() => {
        const e = latest.current.engine;
        if (!e) return resolveEngineSource({ ...DEFAULT_ENGINE_SETTINGS, enabled: true }, {});
        return resolveEngineSource({ ...e.settings, enabled: true }, e.available ?? {}) ?? resolveEngineSource({ ...e.settings, engineId: 'sf19-lite-single', enabled: true }, e.available ?? {});
      });
    return engineRef.current;
  }, []);
  const evals = useMemo(() => new EvalCache(null), [session]); // eslint-disable-line react-hooks/exhaustive-deps
  evals.engine = getEngine();
  // chat goal checks outlive puzzle sessions
  const chatEvals = useMemo(() => new EvalCache(null), []);
  chatEvals.engine = evals.engine;

  useEffect(
    () => () => {
      cancelled.current = true;
      for (const t of timers.current) clearTimeout(t);
      engineRef.current?.terminate();
      engineRef.current = null;
    },
    [],
  );

  const record = useCallback((sess: PuzzleSession, ok: boolean) => {
    if (!sess.trainer || sess.recorded) return;
    sess.recorded = true;
    setStats((s) => {
      const themes = { ...s.themes };
      for (const t of ['all', ...sess.trainer!.themes]) {
        const cur = themes[t] ?? { solved: 0, failed: 0 };
        themes[t] = ok ? { ...cur, solved: cur.solved + 1 } : { ...cur, failed: cur.failed + 1 };
      }
      const next = { ...s, themes };
      saveStats(next);
      return next;
    });
  }, []);

  const resetProgress = () => {
    cancelled.current = false;
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    setSolve(null);
    setRun(null);
    setHint({ level: 0, text: null });
    setSolution(null);
    setOutcome(null);
  };

  /** Start a puzzle at a board node (the current one by default). */
  const startAt = useCallback(
    (nodeId: string, g: PuzzleGoal, trainer?: TrainerPuzzle, spec?: PuzzleSpec) => {
      const st = latest.current.state;
      resetProgress();
      setGoalState(g);
      setSession({ spec: spec ?? specAt(st, nodeId, g), nodeId, preexisting: new Set(Object.keys(st.nodes)), trainer, tainted: false, recorded: false });
      setOpen(true);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Open puzzle mode on the current position (the /puzzle command, the header chip). */
  const openHere = useCallback(
    (g?: PuzzleGoal | null) => {
      const st = latest.current.state;
      startAt(st.currentId, g ?? goal);
    },
    [startAt, goal],
  );

  const exit = useCallback(() => {
    cancelled.current = true;
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    if (run?.running) latest.current.cm.stop();
    setOpen(false);
    setSession(null);
    setSolve(null);
    setRun(null);
    setOutcome(null);
    setSolution(null);
    setHint({ level: 0, text: null });
  }, [run?.running]);

  const setGoal = useCallback((g: PuzzleGoal) => {
    setGoalState(g);
    setSession((s) => (s ? { ...s, spec: { ...s.spec, goal: g } } : s));
    setRun(null);
    setOutcome(null);
    setHint({ level: 0, text: null });
    setSolution(null);
  }, []);

  // ---------------------------------------------------------------------------------------------- Ask ChessMind

  const askModel = useCallback(
    async (mode: 'try' | 'explain' = 'try') => {
      const sess = latest.current.session;
      if (!sess || run?.running) return;
      cancelled.current = false;
      const explain = mode === 'explain';
      setRun({ attempts: [], running: true, solved: null, explain });
      if (!explain) setOutcome(null);
      const spec = sess.spec;
      const ids: string[] = [];
      const res = await modelSolve(spec, {
        attempts: explain ? 1 : attempts,
        retries: !explain,
        evals,
        cancelled: () => cancelled.current,
        ask: async (req) => {
          const userId = newId();
          const answerId = newId();
          ids.push(answerId);
          const turns = [...req.history, { role: 'user' as const, parts: req.parts }];
          setChatGoals((g) => ({ ...g, [userId]: { role: 'question', spec, nodeId: sess.nodeId, turns, status: 'done' }, [answerId]: { role: 'answer', spec, nodeId: sess.nodeId, turns, status: 'thinking', auto: true } }));
          const r = await latest.current.cm.askParts({ ...req, originId: sess.nodeId, fen: spec.position, think: PUZZLE_GEN.think, maxTokens: PUZZLE_GEN.maxTokens, maxThinkTokens: PUZZLE_GEN.maxThinkTokens, temperature: PUZZLE_GEN.temperature, userId, answerId, goal: appGoalText(spec.goal, sideName(spec.position)) });
          if (r) patchGoal(answerId, { status: 'checking' });
          return r ?? { parts: [], stopped: true };
        },
        onAttempt: (a) => {
          setRun((r) => (r ? { ...r, attempts: [...r.attempts, a] } : r));
          const id = ids[a.attempt - 1];
          if (id) patchGoal(id, { status: 'done', verdict: a.verdict, line: a.line, where: a.where, lineOk: a.lineOk, lineReason: a.lineReason, reason: a.reason });
        },
      });
      if (cancelled.current) return;
      setRun((r) => (r ? { ...r, running: false, solved: res.solved } : r));
      if (explain) return;
      const last = res.attempts[res.attempts.length - 1];
      if (res.solved && last?.line) {
        setOutcome({ by: 'chessmind', ok: true, line: last.lineOk === false ? [last.line[0]] : last.line, message: last.verdict?.reason ?? 'Solved.' });
      } else if (res.solved === false) {
        setOutcome({ by: 'chessmind', ok: false, line: last?.verdict?.line ?? [], message: last?.verdict?.reason ?? last?.reason ?? 'No solution found.' });
      }
    },
    [run?.running, attempts, evals, patchGoal],
  );

  // ---------------------------------------------------------------------------------------------- goals in the chat

  /** Ask one puzzle question in the chat (`turns`: the dialogue, the question last) and check the answer. */
  const askTurns = useCallback(
    async (spec: PuzzleSpec, nodeId: string, turns: DialogueTurn[], label: string) => {
      const userId = newId();
      const answerId = newId();
      setChatGoals((g) => ({ ...g, [userId]: { role: 'question', spec, nodeId, turns, status: 'done' }, [answerId]: { role: 'answer', spec, nodeId, turns, status: 'thinking' } }));
      const last = turns[turns.length - 1];
      const r = await latest.current.cm.askParts({ parts: last.parts, history: turns.slice(0, -1), label, originId: nodeId, fen: spec.position, think: PUZZLE_GEN.think, maxTokens: PUZZLE_GEN.maxTokens, maxThinkTokens: PUZZLE_GEN.maxThinkTokens, temperature: PUZZLE_GEN.temperature, userId, answerId });
      if (!r) return patchGoal(answerId, { status: 'done', reason: 'Not answered' });
      const found = answerLine(r.parts, spec, dialogueStart(turns));
      if (!found) return patchGoal(answerId, { status: 'done', reason: r.stopped ? 'Stopped' : 'No move given' });
      patchGoal(answerId, { status: 'checking', line: found.moves, where: found.where });
      const verdict = await verifyMove({ fen: spec.position, goal: spec.goal }, found.moves[0], chatEvals);
      let lineOk: boolean | null | undefined;
      let lineReason: string | undefined;
      if (spec.goal.kind === 'mate' && verdict.ok) {
        const lv = await verifyMateLine(spec.position, spec.goal.n ?? Math.ceil(found.moves.length / 2), found.moves, chatEvals);
        lineOk = lv.ok;
        lineReason = lv.reason;
      }
      patchGoal(answerId, { status: 'done', verdict, lineOk, lineReason });
    },
    [chatEvals, patchGoal],
  );

  /** A goal stated in a chat message ("White has checkmate in 2"): asked in the puzzle layout with the user's own
   * words as the goal text, think on, and checked. False when the text states no goal (a normal question). */
  const askGoal = useCallback(
    (text: string): boolean => {
      const goal = detectGoal(text);
      if (!goal) return false;
      const st = latest.current.state;
      const spec = specAt(st, st.currentId, goal);
      void askTurns(spec, st.currentId, [goalTurn(text, spec)], text.trim());
      return true;
    },
    [askTurns],
  );

  /** Retry a checked chat answer with the retry layout (the try and its refutation; no try: the same question). */
  const retryGoal = useCallback(
    (answerId: string) => {
      const e = chatGoals[answerId];
      if (!e || e.role !== 'answer') return;
      patchGoal(answerId, { retried: true });
      const tried = e.verdict?.move;
      const turns = tried ? [...e.turns, ...retryTurns(e.spec.position, tried, e.verdict?.reply)] : e.turns;
      void askTurns(e.spec, e.nodeId, turns, turnText(turns[turns.length - 1]));
    },
    [chatGoals, askTurns, patchGoal],
  );

  // ---------------------------------------------------------------------------------------------- Solve it myself

  const solveMyself = useCallback(() => {
    const sess = latest.current.session;
    if (!sess) return;
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    setOutcome(null);
    setSolve({ status: 'waiting', expectNode: sess.nodeId, played: [], onSolution: true });
    dispatch({ type: 'GOTO', id: sess.nodeId });
  }, [dispatch]);

  /** Back to where the solver is to move; the wrong try's new branch is removed. */
  const tryAgain = useCallback(() => {
    const { session: sess, solve: sv, state: st } = latest.current;
    if (!sess || !sv) return;
    if (sv.wrongNode && st.nodes[sv.wrongNode] && !sess.preexisting.has(sv.wrongNode)) dispatch({ type: 'DELETE_FROM', id: sv.wrongNode });
    dispatch({ type: 'GOTO', id: sv.expectNode });
    setSolve({ ...sv, status: 'waiting', message: undefined, verdict: undefined, wrongNode: undefined, checkedNode: undefined });
    setOutcome(null);
  }, [dispatch]);

  // Watch the board: a new move from the node where the solver is to move is the solver's try
  useEffect(() => {
    const sess = session;
    const sv = solve;
    if (!sess || !sv || (sv.status !== 'waiting' && sv.status !== 'wrong' && sv.status !== 'unknown')) return;
    const id = state.currentId;
    const node = state.nodes[id];
    if (!node || node.parent !== sv.expectNode || id === sv.checkedNode) return;
    const uci = nodeUci(state, id);
    if (!uci) return;
    const spec = sess.spec;
    const fen = positionAt(state, sv.expectNode).fen();
    const step = Math.floor(sv.played.length / 2);
    const known = sv.onSolution ? spec.solution?.[sv.played.length] : undefined;
    const left = spec.goal.kind === 'mate' ? Math.max(1, (spec.goal.n ?? 1) - step) : undefined;
    setSolve({ ...sv, status: 'checking', checkedNode: id, message: undefined, verdict: undefined, wrongNode: undefined });
    void (async () => {
      const v = await verifyMove({ fen, goal: spec.goal, left, known, strict: !!sess.trainer }, uci, evals);
      if (cancelled.current || latest.current.session !== sess) return;
      if (v.ok !== true) {
        sess.tainted = true;
        if (v.ok === false) record(sess, false);
        setSolve((cur) => (cur ? { ...cur, status: v.ok === false ? 'wrong' : 'unknown', verdict: v, message: v.reason, wrongNode: id } : cur));
        return;
      }
      const played = [...sv.played, uci];
      const onSolution = sv.onSolution && !!spec.solution && spec.solution[sv.played.length] === uci;
      const after = new Chess(fen);
      after.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      const finish = (message: string) => {
        if (!sess.tainted) record(sess, true);
        setSolve((cur) => (cur ? { ...cur, status: 'done', played, onSolution, verdict: v, message } : cur));
        setOutcome({ by: 'you', ok: true, line: played, message });
      };
      if (after.isGameOver()) return finish(after.isCheckmate() ? `${v.label} — checkmate!` : v.reason);
      if (spec.solution && onSolution && played.length >= spec.solution.length) return finish(`${v.label} — that's the whole solution.`);
      if (spec.goal.kind !== 'mate' && !spec.solution) return finish(v.reason);
      if (spec.solution && !onSolution && spec.goal.kind !== 'mate') return finish(v.reason);
      // the defender's reply: the solution's next move, else the engine's best (the verdict's reply)
      let reply = onSolution ? spec.solution?.[played.length] : undefined;
      if (!reply) reply = v.reply ?? (await bestMoveAt(after.fen(), { kind: 'best' }, evals)).move ?? undefined;
      // no engine (a mate checked by the search): any defence; the next try is checked again
      if (!reply) {
        const d = after.moves({ verbose: true })[0];
        if (d) reply = d.from + d.to + (d.promotion ?? '');
      }
      if (!reply) return finish(v.reason);
      setSolve((cur) => (cur ? { ...cur, played, onSolution, verdict: v, message: `${v.label} is right.` } : cur));
      later(() => {
        const st = latest.current.state;
        if (!st.nodes[id] || latest.current.session !== sess) return;
        const r = resolveLine(st, id, [reply!], [newId()]);
        if (!r) return finish(v.reason);
        dispatch({ type: 'ADD_LINE', fromId: id, moves: [reply!], newIds: r.ids, gotoIndex: 1 });
        const played2 = [...played, reply!];
        const onSol2 = onSolution && spec.solution?.[played.length] === reply;
        setSolve((cur) => (cur ? { ...cur, status: 'waiting', expectNode: r.ids[0], played: played2, onSolution: onSol2, checkedNode: undefined, message: `${v.label} is right. Your move.` } : cur));
      }, REPLY_MS);
    })();
  }, [state, session, solve, evals, dispatch, record]);

  // ---------------------------------------------------------------------------------------------- hints / solution

  const giveHint = useCallback(async () => {
    const sess = latest.current.session;
    if (!sess) return;
    const sv = latest.current.solve;
    const st = latest.current.state;
    const spec = sess.spec;
    const atNode = sv && sv.status !== 'done' && st.nodes[sv.expectNode] ? sv.expectNode : sess.nodeId;
    const fen = atNode === sess.nodeId ? spec.position : positionAt(st, atNode).fen();
    const playedLen = atNode === sess.nodeId ? 0 : (sv?.played.length ?? 0);
    const known = playedLen === 0 || sv?.onSolution ? spec.solution?.[playedLen] : undefined;
    const left = spec.goal.kind === 'mate' ? Math.max(1, (spec.goal.n ?? 1) - Math.floor(playedLen / 2)) : undefined;
    const level: 1 | 2 = hint.level >= 1 ? 2 : 1;
    sess.tainted = true;
    setHint({ level: hint.level, text: hint.text, busy: true });
    const { move } = await bestMoveAt(fen, spec.goal, evals, known, left);
    setHint({ level, text: move ? hintText(fen, move, level) : 'No hint available (the engine is needed for this one).' });
  }, [hint.level, hint.text, evals]);

  const showSolution = useCallback(async () => {
    const sess = latest.current.session;
    if (!sess) return;
    sess.tainted = true;
    if (!latest.current.solve || latest.current.solve.status !== 'done') record(sess, false);
    const spec = sess.spec;
    if (spec.solution?.length) return setSolution({ line: spec.solution, source: 'known' });
    setSolution({ line: [], source: 'engine', busy: true });
    const n = spec.goal.n ?? 1;
    const e = await evals.get(spec.position, spec.goal.kind === 'mate' ? mateDepth(n) : 18, spec.goal.kind === 'mate' ? 6000 : 4000);
    if (e?.pv.length) return setSolution({ line: spec.goal.kind === 'mate' ? e.pv.slice(0, 2 * n - 1) : e.pv.slice(0, 5), source: 'engine' });
    const b = await bestMoveAt(spec.position, spec.goal, evals);
    setSolution(b.move ? { line: b.pv.length ? b.pv : [b.move], source: 'engine' } : { line: [], source: 'none' });
  }, [evals, record]);

  // ---------------------------------------------------------------------------------------------- trainer

  const loadTrainer = useCallback(async (): Promise<TrainerSet | null> => {
    if (trainerSet) return trainerSet;
    try {
      const r = await fetch(TRAINER_URL);
      if (!r.ok) throw new Error(`${TRAINER_URL}: ${r.status}`);
      const set = parseTrainerSet(await r.json());
      setTrainerSet(set);
      setTrainerError(null);
      return set;
    } catch (e) {
      setTrainerError(`Could not load the puzzle set (${(e as Error).message}).`);
      return null;
    }
  }, [trainerSet]);

  const nextPuzzle = useCallback(
    async (theme: string, band: string) => {
      const set = await loadTrainer();
      if (!set) return;
      const pool = filterPuzzles(set.puzzles, theme, band);
      if (!pool.length) return setTrainerError('No puzzle matches this theme and rating.');
      const seen = new Set(stats.seen);
      const fresh = pool.filter((p) => !seen.has(p.id));
      const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length ? fresh : pool).length)];
      const spec = trainerSpec(pick);
      const st = latest.current.state;
      // the game on the board goes into the history (not an earlier puzzle)
      if (Object.keys(st.nodes).length > 1 && !(st.meta.event ?? '').startsWith(TRAINER_EVENT)) pushHistory(st);
      latest.current.cm.detach();
      const first = new Chess(pick.fen).move({ from: pick.moves[0].slice(0, 2), to: pick.moves[0].slice(2, 4), promotion: pick.moves[0][4] });
      const id = newId();
      const game: GameState = {
        version: 2,
        startFen: new Chess(pick.fen).fen(),
        nodes: { [ROOT_ID]: { id: ROOT_ID, san: '', parent: null, children: [id] }, [id]: { id, san: first.san, parent: ROOT_ID, children: [] } },
        currentId: ROOT_ID,
        meta: { source: 'manual', event: `${TRAINER_EVENT} ${pick.id}`, link: `https://lichess.org/training/${pick.id}` },
        chat: [],
      };
      dispatch({ type: 'REPLACE', state: game });
      latest.current.state = game;
      setStats((s) => {
        const next = { ...s, seen: [pick.id, ...s.seen.filter((x) => x !== pick.id)].slice(0, 300) };
        saveStats(next);
        return next;
      });
      // the solver plays from the bottom
      const solverWhite = sideOf(spec.position) === 'w';
      if (orientation && flip && (orientation === 'white') !== solverWhite) flip();
      startAt(id, spec.goal, pick, spec);
      // the opponent's move is played on the board after a moment, then the user's turn
      later(() => {
        dispatch({ type: 'GOTO', id });
        setSolve({ status: 'waiting', expectNode: id, played: [], onSolution: true });
      }, 600);
    },
    [loadTrainer, stats.seen, dispatch, orientation, flip, startAt],
  );

  const goalSentence = session ? goalText(session.spec.goal, sideName(session.spec.position)) : null;

  return {
    open,
    setOpen,
    goal,
    setGoal,
    attempts,
    setAttempts,
    session,
    goalSentence,
    solve,
    run,
    hint,
    solution,
    outcome,
    stats,
    chatGoals,
    askGoal,
    retryGoal,
    trainerSet,
    trainerError,
    openHere,
    startAt,
    exit,
    askModel,
    solveMyself,
    tryAgain,
    giveHint,
    showSolution,
    loadTrainer,
    nextPuzzle,
    stopModel: () => {
      cancelled.current = true;
      latest.current.cm.stop();
    },
  };
}

export type PuzzleState = ReturnType<typeof usePuzzle>;
