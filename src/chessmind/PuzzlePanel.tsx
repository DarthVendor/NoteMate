/*
 * Puzzle mode panel (inside the ChessMind panel, above the chat): the position being solved, the goal, and Ask
 * ChessMind / Hint / Solve it myself / Show solution; plus the Lichess puzzle trainer (theme + rating, Next puzzle).
 * State and logic: usePuzzle.ts. The model's answers stream into the chat below (lines stay clickable there).
 */
import { useEffect, useState } from 'react';
import { Bot, Check, Eye, Hand, Lightbulb, Play, RotateCcw, Shuffle, Square as StopIcon, Target, X } from 'lucide-react';
import type { ChatGoalCheck } from './usePuzzle';
import type { GameAction } from '../state/gameReducer';
import { resolveLine } from '../state/gameReducer';
import { newId } from '../state/pgn';
import type { GameState } from '../types';
import { LineChips } from './LineChips';
import type { LineChip } from './lines';
import { GOAL_KINDS, MAX_MATE_N, RATING_BANDS, TRAINER_THEMES, goalLabel, sanLine, sideName, type GoalKind } from './puzzle';
import type { PuzzleState } from './usePuzzle';
import './PuzzlePanel.css';

interface Props {
  puzzle: PuzzleState;
  state: GameState;
  dispatch: (a: GameAction) => void;
  /** The model is loaded and idle. */
  canAsk: boolean;
  askTitle?: string;
}

const PLAY_MS = 700;
const TAB_KEY = 'notemate.puzzles.tab';

function readTab(): 'position' | 'trainer' {
  try {
    return localStorage.getItem(TAB_KEY) === 'trainer' ? 'trainer' : 'position';
  } catch {
    return 'position';
  }
}

export function PuzzlePanel({ puzzle, state, dispatch, canAsk, askTitle }: Props) {
  const { session, goal, solve, run, hint, solution, outcome, stats, trainerSet, trainerError } = puzzle;
  const [tab, setTab] = useState<'position' | 'trainer'>(() => (session?.trainer ? 'trainer' : readTab()));
  const [theme, setTheme] = useState('random');
  const [band, setBand] = useState('any');
  const [nextBusy, setNextBusy] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);
  useEffect(() => {
    if (session?.trainer) setTab('trainer');
  }, [session?.trainer]);

  const pos = session?.spec.position;
  const side = pos ? sideName(pos) : null;
  const running = !!run?.running;
  const solving = !!solve && solve.status !== 'done';

  const lineBlock = (moves: string[], testid: string) =>
    pos && session ? <PuzzleLine moves={moves} fen={pos} fromId={session.nodeId} state={state} dispatch={dispatch} testid={testid} /> : null;

  const setKind = (kind: GoalKind) => puzzle.setGoal(kind === 'mate' ? { kind, n: goal.n ?? 2 } : { kind });
  const lastAttempt = run?.attempts[run.attempts.length - 1];
  const failedAll = !!run && !run.running && run.solved === false && !run.explain;

  const trainerStats = stats.themes[theme === 'random' ? 'all' : theme];

  return (
    <section className="pz" data-testid="puzzle-panel" aria-label="Puzzle mode">
      <header className="pz-head">
        <span className="pz-title">
          <Target size={13} strokeWidth={2} />
          Puzzle
        </span>
        <div className="segmented pz-tabs" role="group" aria-label="Puzzle source">
          <button type="button" aria-pressed={tab === 'position'} onClick={() => setTab('position')}>
            This position
          </button>
          <button
            type="button"
            aria-pressed={tab === 'trainer'}
            onClick={() => {
              setTab('trainer');
              void puzzle.loadTrainer();
            }}
            data-testid="puzzle-tab-trainer"
          >
            Trainer
          </button>
        </div>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={puzzle.exit} title="Exit puzzle mode" aria-label="Exit puzzle mode" data-testid="puzzle-exit">
          <X size={14} />
        </button>
      </header>

      {tab === 'trainer' && (
        <div className="pz-trainer">
          <div className="pz-row">
            <select className="select pz-select" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
              {TRAINER_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <select className="select pz-select" value={band} onChange={(e) => setBand(e.target.value)} aria-label="Rating">
              {RATING_BANDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
            <button
              className="btn btn-sm btn-primary"
              disabled={nextBusy || running}
              onClick={async () => {
                setNextBusy(true);
                await puzzle.nextPuzzle(theme, band);
                setNextBusy(false);
              }}
              data-testid="puzzle-next"
            >
              <Shuffle size={12} /> Next puzzle
            </button>
          </div>
          {session?.trainer && (
            <div className="pz-meta">
              <a href={`https://lichess.org/training/${session.trainer.id}`} target="_blank" rel="noreferrer">
                #{session.trainer.id}
              </a>
              <span>rating {session.trainer.rating}</span>
              <span className="pz-themes">{session.trainer.themes.slice(0, 4).join(' · ')}</span>
              {session.trainer.heldout && (
                <span className="pz-badge" title="Never shown to ChessMind in training">
                  held out
                </span>
              )}
            </div>
          )}
          {trainerError && <p className="pz-note error">{trainerError}</p>}
          <p className="pz-foot">
            {trainerStats ? `${trainerStats.solved} solved · ${trainerStats.failed} failed${theme === 'random' ? '' : ' in this theme'} · ` : ''}
            {trainerSet ? `${trainerSet.puzzles.length} puzzles · ` : ''}Lichess puzzle database, CC0
          </p>
        </div>
      )}

      {session && pos ? (
        <div className="pz-body">
          <div className="pz-row pz-goal">
            <span className={`pz-side side-${side === 'White' ? 'w' : 'b'}`} title="Side to move">
              {side} to move
            </span>
            <select className="select pz-select" value={goal.kind} onChange={(e) => setKind(e.target.value as GoalKind)} aria-label="Goal" data-testid="puzzle-goal" disabled={running || solving}>
              {GOAL_KINDS.map((g) => (
                <option key={g.kind} value={g.kind}>
                  {g.label}
                </option>
              ))}
            </select>
            {goal.kind === 'mate' && (
              <select className="select pz-select pz-narrow" value={goal.n ?? 1} onChange={(e) => puzzle.setGoal({ kind: 'mate', n: Number(e.target.value) })} aria-label="Mate in" disabled={running || solving}>
                {Array.from({ length: MAX_MATE_N }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    in {n}
                  </option>
                ))}
              </select>
            )}
            <label className="pz-attempts" title="Tries ChessMind gets (a wrong try is refuted and it tries again)">
              Tries
              <select className="select pz-select pz-narrow" value={puzzle.attempts} onChange={(e) => puzzle.setAttempts(Number(e.target.value))} aria-label="Attempts">
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="pz-sentence" data-testid="puzzle-goal-text">
            {puzzle.goalSentence}
            {session.spec.setup && session.spec.start ? <span className="faint"> After {sanLine(session.spec.start, [session.spec.setup])}.</span> : null}
          </p>

          <div className="pz-actions">
            {running ? (
              <button className="btn btn-sm" onClick={puzzle.stopModel} data-testid="puzzle-stop">
                <StopIcon size={11} fill="currentColor" /> Stop
              </button>
            ) : (
              <button className="btn btn-sm pz-ask" disabled={!canAsk} title={canAsk ? 'Ask the model (it thinks first); each try is checked' : askTitle} onClick={() => void puzzle.askModel('try')} data-testid="puzzle-ask">
                <Bot size={12} /> {session.trainer ? 'Let ChessMind try' : 'Ask ChessMind'}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void puzzle.giveHint()} disabled={hint.busy} data-testid="puzzle-hint">
              <Lightbulb size={12} /> Hint
            </button>
            {!solving && (
              <button className="btn btn-sm" onClick={puzzle.solveMyself} disabled={running} data-testid="puzzle-solve">
                <Hand size={12} /> Solve it myself
              </button>
            )}
            <button className={`btn btn-sm ${failedAll || solve?.status === 'wrong' ? 'pz-emph' : ''}`} onClick={() => void puzzle.showSolution()} disabled={solution?.busy} data-testid="puzzle-solution">
              <Eye size={12} /> Show solution
            </button>
            {session.trainer && (
              <button className="btn btn-sm" disabled={!canAsk || running} title={canAsk ? 'ChessMind explains the solution (think on)' : askTitle} onClick={() => void puzzle.askModel('explain')} data-testid="puzzle-explain">
                <Bot size={12} /> Explain
              </button>
            )}
          </div>

          {hint.text && (
            <p className="pz-note pz-hint" data-testid="puzzle-hint-text">
              <Lightbulb size={12} /> {hint.text}
            </p>
          )}

          {solve && solve.status !== 'done' && (
            <div className={`pz-status is-${solve.status}`} data-testid="puzzle-solve-status">
              {solve.status === 'waiting' && <span>{solve.message ?? 'Your move: play it on the board.'}</span>}
              {solve.status === 'checking' && (
                <span>
                  <span className="spinner" aria-hidden /> Checking…
                </span>
              )}
              {(solve.status === 'wrong' || solve.status === 'unknown') && (
                <>
                  <span>
                    {solve.status === 'wrong' ? <X size={12} /> : null} {solve.message}
                  </span>
                  {solve.verdict?.line && solve.verdict.line.length > 1 && lineBlock(solve.verdict.line, 'puzzle-refutation')}
                  <div className="pz-actions">
                    <button className="chat-act" onClick={puzzle.tryAgain} data-testid="puzzle-try-again">
                      <RotateCcw size={12} /> Try again
                    </button>
                    <button className="chat-act" disabled={!canAsk} title={canAsk ? undefined : askTitle} onClick={() => void puzzle.askModel('explain')}>
                      <Bot size={12} /> Ask ChessMind to explain
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {run && (run.attempts.length > 0 || run.running) && (
            <ol className="pz-attempts-list" data-testid="puzzle-attempts">
              {run.attempts.map((a) => {
                const ok = a.verdict?.ok;
                return (
                  <li key={a.attempt} className={ok === true ? 'is-ok' : ok === null || a.reason === 'Stopped' ? 'is-unknown' : 'is-bad'}>
                    <span className="pz-mark">{ok === true ? <Check size={12} /> : ok === null || a.reason === 'Stopped' ? '?' : <X size={12} />}</span>
                    <span>
                      {run.explain ? 'Explanation' : `Try ${a.attempt}`}: {a.line ? <b>{sanLine(pos, a.line.slice(0, 1))}</b> : null} {a.verdict?.reason ?? a.reason}
                      {a.where === 'think' ? <span className="faint"> (from its think)</span> : null}
                      {a.lineOk === false && a.lineReason ? <span className="faint"> Its line: {a.lineReason}</span> : null}
                    </span>
                  </li>
                );
              })}
              {run.running && (
                <li className="is-pending">
                  <span className="spinner" aria-hidden /> {run.explain ? 'ChessMind is explaining…' : `ChessMind is thinking (try ${run.attempts.length + 1} of ${puzzle.attempts})…`}
                </li>
              )}
            </ol>
          )}
          {failedAll && lastAttempt && <p className="pz-note">ChessMind did not find it in {run!.attempts.length} {run!.attempts.length === 1 ? 'try' : 'tries'}.</p>}

          {outcome?.ok && (
            <div className="pz-success" data-testid="puzzle-success">
              <span className="pz-success-icon" aria-hidden>
                <Check size={16} strokeWidth={2.5} />
              </span>
              <div className="pz-success-text">
                <strong>{outcome.by === 'you' ? 'Solved!' : 'ChessMind solved it!'}</strong>
                <span>{outcome.message}</span>
              </div>
              {lineBlock(outcome.line, 'puzzle-success-line')}
            </div>
          )}

          {solution && (
            <div className="pz-solution" data-testid="puzzle-solution-line">
              <span className="pz-label">Solution{solution.source === 'engine' ? ' (engine)' : ''}</span>
              {solution.busy ? <span className="spinner" aria-hidden /> : solution.line.length ? lineBlock(solution.line, 'puzzle-solution-chips') : <span className="faint">No engine available to find it.</span>}
            </div>
          )}
          {goal.kind !== 'mate' && !session.trainer && <p className="pz-foot">{goalLabel(goal)}: checked with Stockfish (a dedicated instance).</p>}
        </div>
      ) : (
        tab === 'position' && <p className="pz-note">Open a position to solve.</p>
      )}
    </section>
  );
}

/** A line from the puzzle position as clickable chips (each adds the line to the move tree up to it) + Play through. */
export function PuzzleLine({ moves, fen, fromId, state, dispatch, testid }: { moves: string[]; fen: string; fromId: string; state: GameState; dispatch: (a: GameAction) => void; testid?: string }) {
  const [playing, setPlaying] = useState<{ ids: string[]; step: number } | null>(null);
  useEffect(() => {
    if (!playing) return;
    if (playing.step >= playing.ids.length || !state.nodes[playing.ids[playing.step]]) {
      setPlaying(null);
      return;
    }
    dispatch({ type: 'GOTO', id: playing.ids[playing.step] });
    const t = setTimeout(() => setPlaying((p) => (p ? { ...p, step: p.step + 1 } : p)), PLAY_MS);
    return () => clearTimeout(t);
  }, [playing, dispatch]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!moves.length) return null;
  const usable = !!state.nodes[fromId];
  /** Put the line into the move tree; go to move `upto` (1-based). Returns the node ids. */
  const insert = (upto: number): string[] | null => {
    if (!usable) return null;
    const r = resolveLine(state, fromId, moves, moves.map(() => newId()));
    if (!r) return null;
    dispatch({ type: 'ADD_LINE', fromId, moves, newIds: r.ids, gotoIndex: upto });
    return r.ids;
  };
  return (
    <div className="pz-line" data-testid={testid}>
      <LineChips
        line={{ kind: 'line', moves }}
        fen={fen}
        usable={usable}
        title="Show this position (adds the line to the move tree)"
        isActive={() => false}
        onPick={(chip: LineChip) => {
          setPlaying(null);
          insert(chip.path[0] + 1);
        }}
      />
      {usable && (
        <button
          className="chat-act"
          onClick={() => {
            const ids = insert(0);
            if (ids) setPlaying({ ids, step: 0 });
          }}
          title="Add the line to the move tree and step through it"
        >
          <Play size={12} /> Play through
        </button>
      )}
    </div>
  );
}

/** Under a puzzle answer in the chat: the check of the model's move (correct / wrong + the refutation), and Retry
 * (the retry layout: its try and the refutation, then the puzzle position again). */
export function GoalCheck({ check, state, dispatch, onRetry, canRetry }: { check: ChatGoalCheck; state: GameState; dispatch: (a: GameAction) => void; onRetry: () => void; canRetry: boolean }) {
  const v = check.verdict;
  const pos = check.spec.position;
  if (check.status === 'thinking') return null;
  if (check.status === 'checking')
    return (
      <div className="pz-check is-pending" data-testid="puzzle-check">
        <span className="spinner" aria-hidden /> Checking {check.line?.length ? sanLine(pos, check.line.slice(0, 1)) : 'the answer'}…
      </div>
    );
  const ok = v?.ok;
  const cls = ok === true ? 'is-ok' : ok === null ? 'is-unknown' : 'is-bad';
  return (
    <div className={`pz-check ${cls}`} data-testid="puzzle-check" data-ok={ok === true ? 'true' : ok === false || !v ? 'false' : 'unknown'}>
      <div className="pz-check-head">
        <span className="pz-mark">{ok === true ? <Check size={12} /> : ok === null ? '?' : <X size={12} />}</span>
        <span>
          {v ? v.reason : (check.reason ?? 'No move given')}
          {check.where === 'think' ? <span className="faint"> (move from its think)</span> : null}
          {ok === true && check.lineOk === false && check.lineReason ? <span className="faint"> Its line: {check.lineReason}</span> : null}
        </span>
      </div>
      {ok === false && v?.line && v.line.length > 1 && <PuzzleLine moves={v.line} fen={pos} fromId={check.nodeId} state={state} dispatch={dispatch} testid="puzzle-check-refutation" />}
      {ok !== true && !check.auto && !check.retried && (
        <button className="chat-act" onClick={onRetry} disabled={!canRetry} title="Ask again with the refutation (the retry layout)" data-testid="puzzle-retry">
          <RotateCcw size={12} /> Retry
        </button>
      )}
    </div>
  );
}
