/*
 * ChessMind chat: message bubbles, answer lines as clickable move chips (play through / keep / discard), the hidden
 * reasoning as a collapsed ThinkingBlock, suggestions for an empty chat, and a composer with a "/" command menu.
 * Model settings live in a popover (ChessMindSettings); move predictions are PredictionChips (shown by the host).
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { ArrowUp, ArrowUpToLine, Bot, Eraser, Pause, Play, Square as StopIcon, X } from 'lucide-react';
import type { useChessMind } from './useChessMind';
import { CHAT_MAX_THINK_TOKENS, CHAT_MAX_TOKENS } from './useChessMind';
import { LineEndNote, ThinkingBlock } from './ThinkingBlock';
import { ToolChip } from './ToolChip';
import { LineChips, MarkLabel } from './LineChips';
import { createdRoots, nodeAtPath, planLineInsert } from './lineTree';
import type { LineChip } from './lines';
import { isAnalysisRequest, parseCommand } from './commands';
import { ChessMindSettings } from './ChessMindSettings';
import { uciToSan } from './san';
import type { GameAction } from '../state/gameReducer';
import { positionAt, resolveLine } from '../state/gameReducer';
import { newId } from '../state/pgn';
import { ROOT_ID, type ChatLinePart, type ChatLineState, type ChatMessage, type GameState } from '../types';
import { ProgressBar, Segmented } from '../ui/primitives';
import { AppContext } from '../app/AppContext';
import { MIN_ENGINE_DEPTH, chatContext, contextLabel, engineInfoFor, messageMarks, userSide, type MessageMarks } from './chatContext';
import { MarkedText } from './MarkedText';
import { Target as PuzzleIcon } from 'lucide-react';
import { GoalCheck, PuzzlePanel } from './PuzzlePanel';
import { usePuzzle } from './usePuzzle';
import { goalLabel, parseGoal } from './puzzle';

type ChessMindState = ReturnType<typeof useChessMind>;

interface Props {
  cm: ChessMindState;
  state: GameState;
  dispatch: (a: GameAction) => void;
  chess: Chess;
  fen: string;
  /** Moves (UCI) from the standard start to the current node; null for games with a custom start. */
  uciMoves: string[] | null;
  onFlip: () => void;
  /** Rendered between the header and the transcript (the standalone panel puts the move predictions there). */
  above?: React.ReactNode;
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(0);

const PLAY_STEP_MS = 800;

/** Claim checker marks by answer message object (a patch replaces only the patched message). */
const MARK_CACHE = new WeakMap<ChatMessage, { user?: ChatMessage; mk: MessageMarks }>();

/** Starters shown in an empty chat. */
const SUGGESTIONS = ["What's the plan here?", 'What should I play?', 'Show me the Najdorf', 'Review this game'];

/** The "/" menu: board commands handled locally (see commands.ts). `run`: complete as typed; else fill in and edit. */
const SLASH: { insert: string; desc: string; run?: boolean }[] = [
  { insert: 'back 2', desc: 'Step back N moves' },
  { insert: 'forward', desc: 'Step forward', run: true },
  { insert: 'go to move 12', desc: 'Jump to a move on this line' },
  { insert: 'start', desc: 'Go to the start position', run: true },
  { insert: 'end', desc: 'Go to the end of the line', run: true },
  { insert: 'flip', desc: 'Flip the board', run: true },
  { insert: 'next variation', desc: 'Switch to the next alternative', run: true },
  { insert: 'previous variation', desc: 'Switch to the previous alternative', run: true },
  { insert: 'make this the main line', desc: 'Promote the current line', run: true },
  { insert: 'delete this line', desc: 'Delete this move and what follows', run: true },
  { insert: 'note: ', desc: 'Add a note to this position' },
  { insert: 'arrow e2 e4 red', desc: 'Draw an arrow (green, red, blue, yellow)' },
  { insert: 'highlight e4', desc: 'Circle a square' },
  { insert: 'clear arrows', desc: 'Clear arrows and highlights', run: true },
  { insert: 'play Nf3', desc: 'Play a move (SAN or UCI)' },
  { insert: 'analyse', desc: 'Top model moves with a short explanation', run: true },
  { insert: 'puzzle', desc: 'Puzzle mode: solve this position (or the Lichess trainer)', run: true },
  { insert: 'puzzle mate 2', desc: 'Puzzle with a goal: mate N, win queen, piece, material, win, draw, best' },
  { insert: 'new game', desc: 'Start over (clears the chat)', run: true },
];

export function ChessMindPanel({ cm, state, dispatch, chess, fen, uciMoves, onFlip, above }: Props) {
  const { settings, update, models, modelsError, modelId, status, error, progress, info, chatBusy } = cm;
  const chat = state.chat ?? [];
  const standardStart = uciMoves !== null;
  const [prompt, setPrompt] = useState('');
  const [slashSel, setSlashSel] = useState(0);
  const [playing, setPlaying] = useState<{ ids: string[]; step: number } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const model = models?.find((m) => m.id === modelId) ?? models?.[0];
  const lastAnswer = [...chat].reverse().find((m) => m.role === 'assistant' && m.msPerToken);
  // The analysis engine (when the panel is inside the app): its result goes with questions about its position.
  const app = useContext(AppContext);
  const engine = app?.engine;
  // Puzzle mode (usePuzzle.ts / PuzzlePanel.tsx): the panel above the transcript, /puzzle and the header chip
  const puzzle = usePuzzle({ cm, state, dispatch, engine, orientation: app?.orientation, flip: onFlip });
  // Claim checker marks per finished answer (cached per message object: patches replace only the patched message).
  const marks = useMemo(() => {
    const out = new Map<string, MessageMarks>();
    if (!settings.checkClaims) return out;
    chat.forEach((m, i) => {
      if (m.role !== 'assistant' || m.kind !== 'model' || !m.done || !m.parts.length) return;
      const user = chat.slice(0, i).reverse().find((u) => u.role === 'user' && u.kind === 'model');
      let hit = MARK_CACHE.get(m);
      if (!hit || hit.user !== user) MARK_CACHE.set(m, (hit = { user, mk: messageMarks(m, user) }));
      if (hit.mk.count) out.set(m.id, hit.mk);
    });
    return out;
  }, [state.chat, settings.checkClaims]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the newest message in view.
  const lastParts = chat.length ? JSON.stringify(chat[chat.length - 1].parts).length : 0;
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, lastParts]);

  // Grow the composer with its text (up to the CSS max-height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  // "Play through": step the board along a line.
  useEffect(() => {
    if (!playing) return;
    if (playing.step >= playing.ids.length) {
      setPlaying(null);
      return;
    }
    const id = playing.ids[playing.step];
    if (!state.nodes[id]) {
      setPlaying(null);
      return;
    }
    dispatch({ type: 'GOTO', id });
    const timer = setTimeout(() => setPlaying((p) => (p ? { ...p, step: p.step + 1 } : p)), PLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps

  let statusText = '';
  if (status === 'loading') {
    if (!progress) statusText = model ? `Loading ${model.sizeMb} MB…` : 'Loading…';
    else if (progress.phase === 'download') statusText = `Downloading ${mb(progress.loaded)} / ${mb(progress.total)} MB`;
    else statusText = 'Compiling…';
  } else if (status === 'ready' && info) {
    statusText = `${model ? `${(model.params / 1e6).toFixed(0)}M` : info.manifest.name} · ${info.backend}`;
  } else if (status === 'error') statusText = 'Error';
  else if (settings.enabled && models === null && !modelsError) statusText = 'Looking for models…';
  const loadedTitle = status === 'ready' && info ? `${model?.name ?? info.manifest.name}: loaded in ${(info.loadMs / 1000).toFixed(1)} s${info.cached ? ' (cached)' : ''}` : undefined;

  /** The answer's board snapshot in force at part `pi` (hidden-reasoning models may show one), if any. */
  const answerFen = (m: ChatMessage, pi: number): string | undefined => {
    for (let i = pi - 1; i >= 0; i--) {
      const p = m.parts[i];
      if (p.kind === 'fen') return p.fen;
    }
    return undefined;
  };
  /** The node on the asked-at node's path (itself first, then each ancestor back to the start: answers may rewind to
   * any point of the game) whose position is snapshot `snap`'s (placement + side). A decoded snapshot carries no move
   * number or castling rights, so its lines are numbered from this node's full FEN. */
  const snapshotNode = (m: ChatMessage, snap: string): string | null => {
    const key = (f: string) => f.split(' ').slice(0, 2).join(' ');
    const want = key(snap);
    for (let id: string | null = m.originId && state.nodes[m.originId] ? m.originId : ROOT_ID; id && state.nodes[id]; id = state.nodes[id].parent ?? null) {
      if (key(positionAt(state, id).fen()) === want) return id;
      if (id === ROOT_ID) break;
    }
    return null;
  };
  /** A snapshot's full FEN (move number, castling) when it is a position on the asked-at node's path. */
  const snapshotFen = (m: ChatMessage, snap: string): string => {
    const id = snapshotNode(m, snap);
    return id ? positionAt(state, id).fen() : snap;
  };
  /** Node a message's lines start from: the asked-at node for position questions, else the start. After a snapshot in
   * the answer: its snapshotNode, else none. */
  const lineOrigin = (m: ChatMessage, pi?: number): string | null => {
    const snap = pi === undefined ? undefined : answerFen(m, pi);
    if (snap) return snapshotNode(m, snap);
    const origin = m.fen ? (m.originId ?? null) : standardStart ? ROOT_ID : null;
    return origin && state.nodes[origin] ? origin : null;
  };
  const lineAlive = (l: ChatLineState | undefined) => !!l && !!state.nodes[l.fromId] && l.ids.every((id) => state.nodes[id]);

  /** Insert (or revisit) part `pi` of message `m` as a branch and go to its move `goto` (0 = before the line); the
   * line's own branches go in as variations. `at`: go to the move at this chip path instead. */
  const applyLine = (m: ChatMessage, pi: number, goto: number, at?: number[]): ChatLineState | null => {
    const part = m.parts[pi];
    if (part?.kind !== 'line') return null;
    const existing = m.lines?.[pi];
    if (lineAlive(existing)) {
      const target = at ? nodeAtPath(part, existing!, at) : goto <= 0 ? existing!.fromId : existing!.ids[goto - 1];
      if (target && state.nodes[target]) dispatch({ type: 'GOTO', id: target });
      return existing!;
    }
    const origin = lineOrigin(m, pi);
    if (!origin) return null;
    const r = resolveLine(state, origin, part.moves, part.moves.map(() => newId()));
    if (!r) return null;
    const before = m.parts[pi - 1];
    const after = m.parts[pi + 1];
    const notes: { at: 'start' | 'end'; text: string; id: string; color: 'chessmind' }[] = [];
    if (before?.kind === 'text' && before.text.trim()) notes.push({ at: 'start', text: before.text.trim(), id: newId(), color: 'chessmind' });
    if (after?.kind === 'text' && after.text.trim() && r.ids.length) notes.push({ at: 'end', text: after.text.trim(), id: newId(), color: 'chessmind' });
    const plan = planLineInsert(state, origin, part, newId, goto, notes);
    if (!plan) return null;
    for (const a of plan.actions) dispatch(a);
    const lineState: ChatLineState = {
      ...plan.state,
      notes: notes.map((n) => ({ id: n.id, nodeId: n.at === 'start' ? origin : plan.state.ids[plan.state.ids.length - 1] })),
    };
    if (at) {
      const target = nodeAtPath(part, plan.state, at);
      if (target) dispatch({ type: 'GOTO', id: target });
    }
    dispatch({ type: 'CHAT_PATCH', id: m.id, patch: { lines: { ...(m.lines ?? {}), [pi]: lineState } } });
    return lineState;
  };

  const discardLine = (m: ChatMessage, pi: number) => {
    const l = m.lines?.[pi];
    if (!l) return;
    setPlaying(null);
    for (const n of l.notes) if (state.nodes[n.nodeId]) dispatch({ type: 'DELETE_NOTE', id: n.id, nodeId: n.nodeId });
    // Branches first (their nodes may hang off the line's new moves), then the line itself.
    for (const id of createdRoots(l)) if (state.nodes[id]) dispatch({ type: 'DELETE_FROM', id });
    const lines = { ...(m.lines ?? {}) };
    delete lines[pi];
    dispatch({ type: 'CHAT_PATCH', id: m.id, patch: { lines } });
  };

  const echo = (userText: string, reply: string) =>
    dispatch({
      type: 'CHAT_APPEND',
      messages: [
        { id: newId(), role: 'user', kind: 'command', parts: [{ kind: 'text', text: userText }] },
        { id: newId(), role: 'assistant', kind: 'command', parts: [{ kind: 'text', text: reply }], done: true },
      ],
    });

  const send = (raw: string) => {
    const typed = raw.trim();
    if (!typed || chatBusy) return;
    const slashed = typed.startsWith('/');
    const text = slashed ? typed.slice(1).trim() : typed;
    if (!text) return;
    setPrompt('');
    setSlashSel(0);
    const pz = (slashed || /^puzzle$/i.test(text)) && /^puzzle\b/i.test(text) ? parseGoal(text.slice(6)) : false;
    if (pz !== false) {
      if (pz === undefined) return echo(text, 'Puzzle goals: mate N, win queen, piece, material, win, draw, best.');
      puzzle.openHere(pz);
      return echo(text, `Puzzle mode on this position${pz ? ` (${goalLabel(pz)})` : ''}.`);
    }
    const cmd = parseCommand(text, state, chess);
    if (cmd) {
      setPlaying(null);
      if (cmd.reset) {
        cm.detach();
        for (const a of cmd.actions) dispatch(a);
        echo(text, cmd.echo);
      } else {
        echo(text, cmd.echo);
        for (const a of cmd.actions) dispatch(a);
        if (cmd.flip) onFlip();
      }
      return;
    }
    if (isAnalysisRequest(text)) {
      if (!uciMoves) return echo(text, 'ChessMind follows games from the initial position; this game starts from a custom FEN.');
      if (status !== 'ready') return echo(text, 'The model is not loaded yet.');
      cm.analyse(text, uciMoves, state.currentId);
      return;
    }
    if (slashed) return echo(text, 'Not a board command. Type / to see the commands.');
    if (status !== 'ready') return echo(text, 'That is not a board command, and the model is not loaded yet.');
    if (!info?.hasText) return echo(text, 'This model has no text vocabulary.');
    // A goal statement ("White has checkmate in 2"): the puzzle layout (the user's words as the goal, the position,
    // think on, no engine / candidates block) and the answer checked (usePuzzle.ts askGoal)
    if (settings.goalPuzzles !== false && puzzle.askGoal(text)) return;
    const fenOpt = settings.aboutPosition ? fen : undefined;
    const context = !fenOpt && settings.sendMoves && uciMoves && uciMoves.length ? uciMoves : undefined;
    // With a snapshot, the moves are not in the prompt but an answer may still rewind to a position along them
    const gameMoves = fenOpt && uciMoves && uciMoves.length ? uciMoves : undefined;
    // The position under discussion (the snapshot or the end of the sent line; the initial position with no moves
    // yet) goes with its move number, the engine's result for it, or else the model's own top moves.
    const discussed = fenOpt || context || uciMoves?.length === 0 ? fen : null;
    const pred = cm.prediction && uciMoves && cm.prediction.key.split('|')[0] === uciMoves.join(' ') ? cm.prediction.moves : null;
    const minDepth = engine?.settings.depth ? Math.min(MIN_ENGINE_DEPTH, engine.settings.depth) : MIN_ENGINE_DEPTH;
    // Only models trained on the ctx1 blocks get them: an older model reads an [Engine] block as an engine-review cue
    // ("Show me the Najdorf" came back as a mistake review of 1.e4)
    const contextText = discussed && model?.contextBlocks
      ? chatContext({
          fen: discussed,
          engine: engine?.status === 'ready' ? engineInfoFor(discussed, { fen: engine.linesFen, lines: engine.lines, name: engine.engineName }, minDepth) : null,
          candidates: pred,
          sendEngine: settings.engineContext,
          sendCandidates: settings.candidatesContext,
          // [You: White|Black]: the "I'm playing" setting, or (auto) Simulate's non-model colour while a Simulate run
          // is going (running / paused), else the board orientation (chatContext.ts userSide documents the rule)
          // (models trained with it only: manifest user_side; v6 s20k and older never saw a [You] block)
          you: info?.manifest.user_side ? userSide(settings.userSide ?? 'auto', { orientation: app?.orientation ?? 'white', simModelColor: app && app.sim.phase !== 'idle' ? (app.sim.live?.modelColor ?? null) : null }) : null,
        })
      : '';
    cm.ask(text, { originId: state.currentId, fen: fenOpt, context, gameMoves, contextText });
  };

  // "/" menu entries matching what follows the slash.
  const slashQuery = prompt.startsWith('/') && !prompt.includes('\n') ? prompt.slice(1).toLowerCase() : null;
  const slashItems = slashQuery === null ? [] : SLASH.filter((c) => c.insert.startsWith(slashQuery) || c.desc.toLowerCase().includes(slashQuery)).slice(0, 8);
  const slashOpen = slashItems.length > 0 && !slashItems.some((c) => c.insert.trim() === slashQuery?.trim() && slashQuery !== '');
  const sel = Math.min(slashSel, Math.max(0, slashItems.length - 1));
  const pickSlash = (c: (typeof SLASH)[number]) => {
    if (c.run) return send(`/${c.insert}`);
    setPrompt(`/${c.insert}`);
    setSlashSel(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const renderLine = (m: ChatMessage, pi: number, part: ChatLinePart) => {
    const moves = part.moves;
    const origin = lineOrigin(m, pi);
    const snap = answerFen(m, pi);
    const startFen = snap ? snapshotFen(m, snap) : (m.fen ?? undefined);
    const l = m.lines?.[pi];
    const alive = lineAlive(l);
    const usable = !!origin || alive;
    const isPlaying = !!playing && alive && playing.ids === l!.ids;
    return (
      <div key={pi} className={`chat-line ${alive ? 'is-in-tree' : ''}`} data-testid="chessmind-line">
        <LineChips
          line={part}
          fen={startFen}
          usable={usable}
          title={usable ? 'Show this position (adds the line and its variations to the move tree)' : 'This game does not start from the initial position'}
          isActive={(path) => alive && nodeAtPath(part, l!, path) === state.currentId}
          onPick={(chip: LineChip) => {
            setPlaying(null);
            applyLine(m, pi, chip.path.length === 1 ? chip.path[0] + 1 : 0, chip.path.length === 1 ? undefined : chip.path);
          }}
        />
        {moves.length === 0 && (
          <div className="chat-line-moves">
            <span className="faint">(empty line)</span>
            <MarkLabel end={part.end} />
          </div>
        )}
        {/* models without end markers: say how a line that stopped in a finished position ended */}
        {moves.length > 0 && !part.end && !part.branches?.length && <LineEndNote fen={startFen} moves={moves} />}
        {m.done && moves.length > 0 && usable && (
          <div className="chat-line-actions">
            {isPlaying ? (
              <button className="chat-act" onClick={() => setPlaying(null)} data-testid="line-stop">
                <Pause size={12} /> Stop
              </button>
            ) : (
              <button
                className="chat-act"
                onClick={() => {
                  const ls = applyLine(m, pi, 0);
                  if (ls) setPlaying({ ids: ls.ids, step: 0 });
                }}
                title="Add the line to the move tree and step through it"
                data-testid="line-play"
              >
                <Play size={12} /> Play through
              </button>
            )}
            {alive && (
              <>
                <button className="chat-act" onClick={() => dispatch({ type: 'PROMOTE', id: l!.ids[l!.ids.length - 1] })} title="Make this line the main line" data-testid="line-keep">
                  <ArrowUpToLine size={12} /> Keep as main line
                </button>
                {(l!.created.some(Boolean) || l!.notes.length > 0) && (
                  <button className="chat-act danger" onClick={() => discardLine(m, pi)} title="Remove the moves and notes this line added" data-testid="line-discard">
                    <X size={12} /> Discard
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderAnswer = (m: ChatMessage) => {
    if (m.kind === 'analysis') {
      const originFen = m.context
        ? (() => {
            const c = new Chess();
            for (const u of m.context) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
            return c.fen();
          })()
        : undefined;
      return (
        <>
          {m.predictions && (
            <div className="chat-preds">
              {m.predictions.length === 0 && <span className="faint">No legal moves.</span>}
              {m.predictions.map((p) => (
                <button
                  key={p.uci}
                  className="pred-chip"
                  style={{ '--p': `${Math.round(p.p * 100)}%` } as React.CSSProperties}
                  title="Add this move to the move tree"
                  onClick={() => {
                    if (m.originId && state.nodes[m.originId]) dispatch({ type: 'ADD_LINE', fromId: m.originId, moves: [p.uci], newIds: [newId()], gotoIndex: 1 });
                  }}
                >
                  <b>{uciToSan(originFen, p.uci)}</b>
                  <span>{(p.p * 100).toFixed(0)}%</span>
                </button>
              ))}
            </div>
          )}
          {m.parts.some((p) => p.kind === 'text') && (
            <p className="chat-text">{m.parts.map((p, i) => (p.kind === 'text' ? <span key={i}>{p.text} </span> : null))}</p>
          )}
          {!m.predictions && !m.done && <Typing />}
        </>
      );
    }
    // Hidden reasoning (first part) renders as a collapsible block; only the answer parts drive the board.
    const think = m.parts[0]?.kind === 'think' ? m.parts[0] : null;
    const thinkMarks = marks.get(m.id)?.think;
    const thinkBlock = think && (
      <ThinkingBlock
        parts={think.parts}
        open={think.open}
        tokens={think.tokens}
        done={m.done}
        startFen={m.fen}
        resolveFen={(f) => snapshotFen(m, f)}
        renderText={thinkMarks?.size ? (t, i) => (thinkMarks.get(i) ? <MarkedText segments={thinkMarks.get(i)!} /> : t) : undefined}
      />
    );
    if (m.parts.length === (think ? 1 : 0)) {
      if (think?.open && !m.done) return thinkBlock;
      return (
        <>
          {thinkBlock}
          {m.done ? <p className="chat-text faint">No answer; this model may not have learned dialogue yet.</p> : <Typing />}
        </>
      );
    }
    // Consecutive text parts flow as one paragraph; each line is its own block.
    const blocks: React.ReactNode[] = [];
    let run: React.ReactNode[] = [];
    const flush = (key: string) => {
      if (run.length) blocks.push(<p key={key} className="chat-text">{run}</p>);
      run = [];
    };
    const mk = marks.get(m.id);
    m.parts.forEach((p, i) => {
      if (p.kind === 'text') {
        const segs = mk?.answer.get(i);
        run.push(<span key={i}>{segs ? <MarkedText segments={segs} /> : p.text} </span>);
      }
      else if (p.kind === 'line') {
        flush(`t${i}`);
        blocks.push(renderLine(m, i, p));
      } else if (p.kind === 'tool') {
        const snap = answerFen(m, i);
        run.push(<ToolChip key={i} part={p} startFen={snap ? snapshotFen(m, snap) : (m.fen ?? undefined)} />);
      }
    });
    flush('end');
    return (
      <>
        {thinkBlock}
        {blocks}
      </>
    );
  };

  // Board commands pair up (the command, then what was done) and render as one quiet row.
  const rows: React.ReactNode[] = [];
  for (let i = 0; i < chat.length; i++) {
    const m = chat[i];
    const text = m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join(' ');
    if (m.kind === 'command' && m.role === 'user') {
      const reply = chat[i + 1]?.kind === 'command' && chat[i + 1].role === 'assistant' ? chat[++i] : null;
      rows.push(
        <div key={m.id} className="chat-cmd">
          <code>/{text}</code>
          {reply && <span>{reply.parts.map((p) => (p.kind === 'text' ? p.text : '')).join(' ')}</span>}
        </div>,
      );
    } else if (m.kind === 'command') {
      rows.push(
        <div key={m.id} className="chat-cmd">
          <span>{text}</span>
        </div>,
      );
    } else if (m.role === 'user') {
      rows.push(
        <div key={m.id} className="chat-msg chat-user">
          <div className="chat-bubble">{text}</div>
          {puzzle.chatGoals[m.id] && <span className="pz-msg-badge" title="Asked in the puzzle layout (think on); the answer is checked">puzzle</span>}
          {(m.fen || m.context?.length || m.contextText) && (
            <div className="chat-meta">
              {m.fen ? 'about this position' : m.context?.length ? `with the game so far · ${m.context.length} plies` : ''}
              {contextLabel(m.contextText) && (
                <span className="chat-context" title={`Sent with the question:\n${m.contextText}`} data-testid="chessmind-context-sent">
                  {m.fen || m.context?.length ? ' · ' : ''}
                  {contextLabel(m.contextText)} sent
                </span>
              )}
            </div>
          )}
        </div>,
      );
    } else {
      const isLast = m === lastAnswer;
      rows.push(
        <div key={m.id} className={`chat-msg chat-bot ${m.done ? '' : 'is-streaming'}`}>
          <div className="chat-bubble">{renderAnswer(m)}</div>
          {puzzle.chatGoals[m.id] && <GoalCheck check={puzzle.chatGoals[m.id]} state={state} dispatch={dispatch} onRetry={() => puzzle.retryGoal(m.id)} canRetry={status === 'ready' && !chatBusy} />}
          {(m.stopped || (isLast && m.msPerToken)) && (
            <div className="chat-meta" data-testid={isLast ? 'chessmind-latency' : undefined}>
              {m.stopped && 'stopped'}
              {m.stopped && isLast && m.msPerToken ? ' · ' : ''}
              {isLast && m.msPerToken
                ? `${m.tokens} tokens (max ${CHAT_MAX_TOKENS + (info?.thinking && settings.think !== 'off' ? CHAT_MAX_THINK_TOKENS + 2 : 0)}) · ${m.msPerToken.toFixed(0)} ms/token${m.prefillMs !== undefined ? ` · first ${m.prefillMs.toFixed(0)} ms` : ''}`
                : ''}
            </div>
          )}
        </div>,
      );
    }
  }

  const statusDot = status === 'ready' ? (chatBusy ? 'busy' : 'on') : status === 'loading' ? 'busy' : status === 'error' ? 'err' : '';

  return (
    <div className="chat" data-testid="chessmind-panel" data-status={status}>
      <header className="chat-head">
        <span className="chat-title">
          <span className={`status-dot ${statusDot}`} aria-hidden />
          ChessMind
        </span>
        <span className="chat-status" data-testid="chessmind-status" title={loadedTitle}>
          {statusText}
        </span>
        <span className="chat-head-tools">
          <button className="pz-chip" aria-pressed={puzzle.open} onClick={() => (puzzle.open ? puzzle.exit() : puzzle.openHere())} title="Puzzle mode: solve this position, or train on Lichess puzzles" data-testid="puzzle-chip">
            <PuzzleIcon size={11} strokeWidth={2} /> Puzzle
          </button>
          {chat.length > 0 && (
            <button
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => {
                // a completely new conversation: no running answer, no puzzle session / attempts carried over, and
                // the next question starts from empty KV caches
                cm.newChat();
                if (puzzle.open) puzzle.exit();
                setPlaying(null);
                dispatch({ type: 'CHAT_CLEAR' });
              }}
              title="Clear the conversation"
              aria-label="Clear the conversation"
              data-testid="chessmind-clear"
            >
              <Eraser size={14} />
            </button>
          )}
          <ChessMindSettings cm={cm} />
        </span>
      </header>
      {settings.enabled && status === 'loading' && (
        <div className="chat-progress">
          <ProgressBar value={progress && progress.phase === 'download' && progress.total ? (progress.loaded / progress.total) * 100 : null} />
        </div>
      )}
      {settings.enabled && modelsError && <p className="error chat-error">{modelsError}</p>}
      {settings.enabled && error && (
        <p className="error chat-error" data-testid="chessmind-error">
          {error}
        </p>
      )}

      {puzzle.open && (
        <PuzzlePanel
          puzzle={puzzle}
          state={state}
          dispatch={dispatch}
          canAsk={status === 'ready' && !!info?.hasText && !chatBusy}
          askTitle={status !== 'ready' ? 'Load the ChessMind model first' : !info?.hasText ? 'This model has no text vocabulary' : 'ChessMind is busy'}
        />
      )}
      {!settings.enabled ? (
        <div className="chat-intro">
          <span className="chat-intro-icon">
            <Bot size={16} strokeWidth={1.75} />
          </span>
          <div className="chat-intro-text">
            <strong>Load the model to chat</strong>
            <span>Runs in this browser: it predicts moves, answers questions about the game and drives the board.</span>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => update({ enabled: true })} data-testid="chessmind-enable">
            Load{model ? ` · ${model.sizeMb} MB` : ''}
          </button>
        </div>
      ) : (
        <>
          {above}
          <div className="chat-transcript" data-testid="chessmind-chat" ref={transcriptRef}>
            {chat.length === 0 ? (
              <div className="chat-empty">
                <p className="chat-empty-title">Ask about this position</p>
                <div className="chat-suggest">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chat-suggestion" onClick={() => send(s)} disabled={chatBusy} data-testid="chessmind-suggestion">
                      {s}
                    </button>
                  ))}
                </div>
                <p className="chat-empty-hint">
                  Lines in answers are clickable. Type <kbd>/</kbd> for board commands.
                </p>
              </div>
            ) : (
              rows
            )}
          </div>
          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              if (slashOpen) pickSlash(slashItems[sel]);
              else send(prompt);
            }}
          >
            {slashOpen && (
              <div className="slash-menu" role="listbox" aria-label="Board commands" data-testid="chessmind-slash">
                {slashItems.map((c, i) => (
                  <button
                    type="button"
                    key={c.insert}
                    role="option"
                    aria-selected={i === sel}
                    className={`slash-item ${i === sel ? 'sel' : ''}`}
                    onMouseEnter={() => setSlashSel(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickSlash(c)}
                  >
                    <code>/{c.insert.trim()}</code>
                    <span>{c.desc}</span>
                  </button>
                ))}
              </div>
            )}
            {info?.thinking && (
              <div className="chat-think-toggle" title="Hidden reasoning before the answer: off, the model decides, or always">
                <span className="chat-think-label">Think</span>
                <Segmented
                  label="Think mode"
                  value={settings.think}
                  onChange={(v) => update({ think: v })}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'auto', label: 'Auto' },
                    { value: 'on', label: 'On' },
                  ]}
                />
              </div>
            )}
            <div className="chat-input">
              <textarea
                ref={inputRef}
                rows={1}
                value={prompt}
                placeholder={status === 'ready' ? 'Ask ChessMind…' : 'Type / for board commands'}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setSlashSel(0);
                }}
                onKeyDown={(e) => {
                  if (slashOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault();
                    setSlashSel((sel + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length);
                  } else if (slashOpen && e.key === 'Tab') {
                    e.preventDefault();
                    setPrompt(`/${slashItems[sel].insert}`);
                  } else if (e.key === 'Escape' && prompt) {
                    e.stopPropagation();
                    setPrompt('');
                  } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                aria-label="Message ChessMind"
                data-testid="chessmind-prompt"
              />
              {chatBusy ? (
                <button type="button" className="chat-send stop" onClick={cm.stop} title="Stop the answer" aria-label="Stop" data-testid="chessmind-stop">
                  <StopIcon size={12} fill="currentColor" />
                </button>
              ) : (
                <button type="submit" className="chat-send" disabled={!prompt.trim()} title="Send (Enter)" aria-label="Send" data-testid="chessmind-send">
                  <ArrowUp size={15} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function Typing() {
  return (
    <span className="chat-typing" aria-label="Writing">
      <i />
      <i />
      <i />
    </span>
  );
}
