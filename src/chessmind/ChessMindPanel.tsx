import { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { useChessMind } from './useChessMind';
import { CHAT_MAX_TOKENS } from './useChessMind';
import { COMMAND_HINT, isAnalysisRequest, parseCommand } from './commands';
import type { GameAction } from '../state/gameReducer';
import { resolveLine } from '../state/gameReducer';
import { newId } from '../state/pgn';
import { ROOT_ID, type Arrow, type ChatLineState, type ChatMessage, type GameState, type Square } from '../types';

type ChessMindState = ReturnType<typeof useChessMind>;

interface Props {
  cm: ChessMindState;
  state: GameState;
  dispatch: (a: GameAction) => void;
  chess: Chess;
  fen: string;
  /** Moves (UCI) from the standard start to the current node; null for games with a custom start. */
  uciMoves: string[] | null;
  onPlayUci: (uci: string) => void;
  onFlip: () => void;
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

function uciToSan(fen: string | undefined, uci: string): string {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return uci;
  }
}

/** Each move of a UCI line as { label (with move number when due), san }, starting from `fen`. */
function lineTokens(fen: string | undefined, moves: string[]): { num: string; san: string }[] {
  const c = new Chess(fen);
  const out: { num: string; san: string }[] = [];
  for (const uci of moves) {
    const no = c.moveNumber();
    const white = c.turn() === 'w';
    let san = uci;
    try {
      san = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      /* keep uci */
    }
    out.push({ num: white ? `${no}.` : out.length === 0 ? `${no}...` : '', san });
  }
  return out;
}

const PLAY_STEP_MS = 800;

export function ChessMindPanel({ cm, state, dispatch, chess, fen, uciMoves, onPlayUci, onFlip }: Props) {
  const { settings, update, models, modelsError, modelId, status, error, progress, info, prediction, chatBusy } = cm;
  const chat = state.chat ?? [];
  const standardStart = uciMoves !== null;
  const [prompt, setPrompt] = useState('');
  const [playing, setPlaying] = useState<{ ids: string[]; step: number } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const model = models?.find((m) => m.id === modelId);
  const lastAnswer = [...chat].reverse().find((m) => m.role === 'assistant' && m.msPerToken);
  const current = state.nodes[state.currentId];
  const pinned = (current.annotation?.arrows ?? []).filter((a) => a.color === 'chessmind');

  // Keep the newest message in view.
  const lastParts = chat.length ? JSON.stringify(chat[chat.length - 1].parts).length : 0;
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, lastParts]);

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
    if (!progress) statusText = model ? `loading ${model.sizeMb} MB…` : 'loading…';
    else if (progress.phase === 'download') statusText = `downloading ${mb(progress.loaded)} / ${mb(progress.total)} MB`;
    else statusText = 'compiling…';
  } else if (status === 'ready' && info) {
    statusText = `${info.backend} · loaded in ${(info.loadMs / 1000).toFixed(1)} s${info.cached ? ' (cached)' : ''}`;
  } else if (status === 'error') statusText = 'error';
  else if (settings.enabled && models === null && !modelsError) statusText = 'looking for models…';

  /** Node a message's lines start from: the asked-at node for position questions, else the start. */
  const lineOrigin = (m: ChatMessage): string | null => {
    const origin = m.fen ? (m.originId ?? null) : standardStart ? ROOT_ID : null;
    return origin && state.nodes[origin] ? origin : null;
  };
  const lineAlive = (l: ChatLineState | undefined) => !!l && !!state.nodes[l.fromId] && l.ids.every((id) => state.nodes[id]);

  /** Insert (or revisit) part `pi` of message `m` as a branch and go to its move `goto` (0 = before the line). */
  const applyLine = (m: ChatMessage, pi: number, goto: number): ChatLineState | null => {
    const part = m.parts[pi];
    if (part?.kind !== 'line') return null;
    const existing = m.lines?.[pi];
    if (lineAlive(existing)) {
      dispatch({ type: 'GOTO', id: goto <= 0 ? existing!.fromId : existing!.ids[goto - 1] });
      return existing!;
    }
    const origin = lineOrigin(m);
    if (!origin) return null;
    const newIds = part.moves.map(() => newId());
    const r = resolveLine(state, origin, part.moves, newIds);
    if (!r) return null;
    const before = m.parts[pi - 1];
    const after = m.parts[pi + 1];
    const notes: { at: 'start' | 'end'; text: string; id: string; color: 'chessmind' }[] = [];
    if (before?.kind === 'text' && before.text.trim()) notes.push({ at: 'start', text: before.text.trim(), id: newId(), color: 'chessmind' });
    if (after?.kind === 'text' && after.text.trim() && r.ids.length) notes.push({ at: 'end', text: after.text.trim(), id: newId(), color: 'chessmind' });
    dispatch({ type: 'ADD_LINE', fromId: origin, moves: part.moves, newIds, gotoIndex: goto, notes });
    const lineState: ChatLineState = {
      fromId: origin,
      ids: r.ids,
      created: r.created,
      notes: notes.map((n) => ({ id: n.id, nodeId: n.at === 'start' ? origin : r.ids[r.ids.length - 1] })),
    };
    dispatch({ type: 'CHAT_PATCH', id: m.id, patch: { lines: { ...(m.lines ?? {}), [pi]: lineState } } });
    return lineState;
  };

  const discardLine = (m: ChatMessage, pi: number) => {
    const l = m.lines?.[pi];
    if (!l) return;
    setPlaying(null);
    for (const n of l.notes) if (state.nodes[n.nodeId]) dispatch({ type: 'DELETE_NOTE', id: n.id, nodeId: n.nodeId });
    const firstNew = l.ids[l.created.indexOf(true)];
    if (firstNew && state.nodes[firstNew]) dispatch({ type: 'DELETE_FROM', id: firstNew });
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

  const submit = () => {
    const text = prompt.trim();
    if (!text || chatBusy) return;
    setPrompt('');
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
    if (status !== 'ready') return echo(text, 'That is not a board command, and the model is not loaded yet.');
    if (!info?.hasText) return echo(text, 'This model has no text vocabulary.');
    const fenOpt = settings.aboutPosition ? fen : undefined;
    const context = !fenOpt && settings.sendMoves && uciMoves && uciMoves.length ? uciMoves : undefined;
    cm.ask(text, { originId: state.currentId, fen: fenOpt, context });
  };

  const pinArrows = () => {
    if (!prediction?.moves.length) return;
    const top = prediction.moves[0].p || 1;
    const arrows: Arrow[] = prediction.moves.map((m) => ({
      from: m.uci.slice(0, 2) as Square,
      to: m.uci.slice(2, 4) as Square,
      color: 'chessmind',
      opacity: Math.round((0.25 + 0.6 * (m.p / top)) * 100) / 100,
    }));
    dispatch({ type: 'ADD_ARROWS', arrows });
  };
  const unpinArrows = () => {
    for (const a of pinned) dispatch({ type: 'TOGGLE_ARROW', arrow: a });
  };

  const renderLine = (m: ChatMessage, pi: number, moves: string[]) => {
    const origin = lineOrigin(m);
    const startFen = m.fen ?? undefined;
    const l = m.lines?.[pi];
    const alive = lineAlive(l);
    const tokens = lineTokens(startFen, moves);
    return (
      <span key={pi} className="cm-line-block">
        <span className="cm-line" data-testid="chessmind-line">
          {tokens.map((t, k) => {
            const active = alive && l!.ids[k] === state.currentId;
            return (
              <span key={k}>
                {t.num && <span className="cm-num">{t.num}</span>}
                <button
                  className={`cm-san ${active ? 'active' : ''}`}
                  disabled={!origin && !alive}
                  title={origin || alive ? 'Show this position on the board (adds the line as a variation)' : 'This game does not start from the initial position'}
                  onClick={() => {
                    setPlaying(null);
                    applyLine(m, pi, k + 1);
                  }}
                >
                  {t.san}
                </button>{' '}
              </span>
            );
          })}
          {moves.length === 0 && <span className="hint">(empty line)</span>}
        </span>
        {m.done && moves.length > 0 && (origin || alive) && (
          <span className="cm-line-tools">
            {playing && alive && playing.ids === l!.ids ? (
              <button className="cm-link" onClick={() => setPlaying(null)}>■ stop</button>
            ) : (
              <button
                className="cm-link"
                onClick={() => {
                  const ls = applyLine(m, pi, 0);
                  if (ls) setPlaying({ ids: ls.ids, step: 0 });
                }}
              >
                ▶ play through
              </button>
            )}
            {alive && (
              <>
                <button className="cm-link" onClick={() => dispatch({ type: 'PROMOTE', id: l!.ids[l!.ids.length - 1] })}>keep as main line</button>
                {l!.created.some(Boolean) || l!.notes.length ? (
                  <button className="cm-link" onClick={() => discardLine(m, pi)}>discard</button>
                ) : null}
              </>
            )}
          </span>
        )}
      </span>
    );
  };

  const renderAnswer = (m: ChatMessage) => {
    if (m.kind === 'analysis') {
      const originFen = m.context ? (() => {
        const c = new Chess();
        for (const u of m.context) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        return c.fen();
      })() : undefined;
      return (
        <>
          {m.predictions && (
            <span className="cm-analysis">
              {m.predictions.length === 0 ? 'No legal moves.' : 'Top moves: '}
              {m.predictions.map((p) => (
                <span key={p.uci}>
                  <button
                    className="cm-san"
                    onClick={() => {
                      if (m.originId && state.nodes[m.originId]) dispatch({ type: 'ADD_LINE', fromId: m.originId, moves: [p.uci], newIds: [newId()], gotoIndex: 1 });
                    }}
                  >
                    {uciToSan(originFen, p.uci)}
                  </button>
                  <span className="cm-fen"> {(p.p * 100).toFixed(0)}%</span>{' '}
                </span>
              ))}
            </span>
          )}
          {m.parts.map((p, i) => (p.kind === 'text' ? <span key={i} className="cm-text"> {p.text}</span> : null))}
          {!m.predictions && !m.done && <span className="hint">…</span>}
        </>
      );
    }
    if (m.parts.length === 0) {
      return m.done ? <span className="hint">(no answer; this model may not have learned dialogue yet)</span> : <span className="hint">…</span>;
    }
    return m.parts.map((p, i) =>
      p.kind === 'text' ? <span key={i} className="cm-text">{p.text} </span> : p.kind === 'line' ? renderLine(m, i, p.moves) : null,
    );
  };

  return (
    <div className="engine-panel chessmind-panel" data-testid="chessmind-panel">
      <header className="engine-header">
        <label className="switch">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span>ChessMind</span>
        </label>
        <span className={`engine-status status-${status}`} data-testid="chessmind-status">{statusText}</span>
      </header>

      {settings.enabled && (
        <div className="engine-controls">
          {models && models.length > 0 && (
            <div className="cm-row">
              <label>
                Model
                <select value={modelId} onChange={(e) => update({ modelId: e.target.value })} data-testid="chessmind-model">
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {(m.params / 1e6).toFixed(0)}M{m.boards ? ' · board' : ''} · {m.sizeMb} MB
                    </option>
                  ))}
                </select>
              </label>
              <label className="cm-backend">
                Backend
                <select value={settings.backend} onChange={(e) => update({ backend: e.target.value as typeof settings.backend })}>
                  <option value="auto">auto</option>
                  <option value="wasm">wasm (CPU)</option>
                  <option value="webgpu">WebGPU</option>
                </select>
              </label>
            </div>
          )}
          {model?.description && <p className="hint engine-desc">{model.description}</p>}
          <details className="cm-advanced">
            <summary>Advanced</summary>
            <label>
              Move context for predictions
              <select
                value={String(settings.contextPlies)}
                disabled={!!info && !info.manifest.boards}
                onChange={(e) => update({ contextPlies: e.target.value === 'full' ? 'full' : (Number(e.target.value) as 8 | 16 | 32) })}
                data-testid="chessmind-context"
              >
                <option value="full">full game</option>
                <option value="8">last 8 plies + board</option>
                <option value="16">last 16 plies + board</option>
                <option value="32">last 32 plies + board</option>
              </select>
            </label>
            <p className="hint engine-desc">
              {info && !info.manifest.boards
                ? 'This model has no board input, so it always reads the full game.'
                : 'Board-input models see the current position directly, so a short move history keeps deep branches fast.'}
            </p>
          </details>
        </div>
      )}

      {settings.enabled && status === 'loading' && progress && (
        <progress className="cm-progress" max={progress.total} value={progress.phase === 'compile' ? undefined : progress.loaded} />
      )}
      {settings.enabled && modelsError && <p className="error">{modelsError}</p>}
      {settings.enabled && error && <p className="error" data-testid="chessmind-error">{error}</p>}

      {settings.enabled && status === 'ready' && (
        <>
          <div className="cm-section-head">
            <span>Predicted move</span>
            <span className="cm-head-tools">
              {pinned.length > 0 ? (
                <button className="cm-link" onClick={unpinArrows} data-testid="chessmind-unpin">unpin arrows</button>
              ) : (
                <button className="cm-link" onClick={pinArrows} disabled={!prediction?.moves.length} data-testid="chessmind-pin" title="Save these arrows on this position">pin arrows</button>
              )}
              <label className="cm-inline">
                <input type="checkbox" checked={settings.arrows} onChange={(e) => update({ arrows: e.target.checked })} data-testid="chessmind-arrows" /> live arrows
              </label>
            </span>
          </div>
          {!standardStart ? (
            <p className="hint engine-desc">ChessMind follows games from the initial position; this game starts from a custom FEN.</p>
          ) : (
            <ol className="engine-lines" data-testid="chessmind-predictions">
              {prediction === null && <li className="hint engine-desc">Thinking…</li>}
              {prediction?.moves.length === 0 && <li className="hint engine-desc">No legal moves.</li>}
              {prediction?.moves.map((m) => (
                <li key={m.uci} className="engine-line">
                  <button className="engine-score cm-move" data-uci={m.uci} title="Play this move" onClick={() => onPlayUci(m.uci)}>
                    {uciToSan(fen, m.uci)}
                  </button>
                  <span className="cm-bar"><span style={{ width: `${Math.round(m.p * 100)}%` }} /></span>
                  <span className="cm-prob">{(m.p * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ol>
          )}
          {prediction && prediction.moves.length > 0 && (
            <p className="hint engine-desc">{prediction.tokens} tokens · {prediction.ms.toFixed(0)} ms per prediction</p>
          )}
        </>
      )}

      {settings.enabled && (
        <div className="cm-chat">
          <div className="cm-section-head">
            <span>Ask ChessMind</span>
            {chat.length > 0 && (
              <button
                className="cm-link"
                onClick={() => {
                  cm.detach();
                  setPlaying(null);
                  dispatch({ type: 'CHAT_CLEAR' });
                }}
              >
                clear chat
              </button>
            )}
          </div>
          <div className="cm-transcript" data-testid="chessmind-chat" ref={transcriptRef}>
            {chat.map((m) => (
              <div key={m.id} className={`cm-msg cm-${m.role} cm-kind-${m.kind}`}>
                {m.role === 'user' ? (
                  <>
                    {m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join(' ')}
                    {m.fen ? <span className="cm-fen"> (this position)</span> : m.context?.length ? <span className="cm-fen"> (after {m.context.length} plies)</span> : null}
                  </>
                ) : (
                  renderAnswer(m)
                )}
                {m.role === 'assistant' && m.stopped && <span className="cm-fen"> (stopped)</span>}
              </div>
            ))}
          </div>
          <form
            className="cm-ask"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              type="text"
              value={prompt}
              placeholder={status === 'ready' ? 'Ask, or type a command (e.g. back 2)' : 'Type a board command (e.g. back 2)'}
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="chessmind-prompt"
            />
            {chatBusy ? (
              <button type="button" className="button" onClick={cm.stop}>Stop</button>
            ) : (
              <button type="submit" className="button" disabled={!prompt.trim()}>Ask</button>
            )}
          </form>
          <p className="cm-hint">{COMMAND_HINT}</p>
          <div className="cm-options">
            <label className="cm-inline" title="Append the moves that led to this position to your question">
              <input type="checkbox" checked={settings.sendMoves} onChange={(e) => update({ sendMoves: e.target.checked })} /> send game moves
            </label>
            <label className="cm-inline" title="Send a board snapshot; lines in the answer continue from this position">
              <input type="checkbox" checked={settings.aboutPosition} onChange={(e) => update({ aboutPosition: e.target.checked })} /> lines from this position
            </label>
          </div>
          {lastAnswer && (
            <p className="hint engine-desc" data-testid="chessmind-latency">
              {lastAnswer.tokens} tokens (max {CHAT_MAX_TOKENS}) · {lastAnswer.msPerToken!.toFixed(0)} ms/token
              {lastAnswer.prefillMs !== undefined ? ` · first ${lastAnswer.prefillMs.toFixed(0)} ms` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
