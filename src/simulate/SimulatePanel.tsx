import { Pause, Play, Settings2, Square, StepForward } from 'lucide-react';
import type { useSimulate, SimGame } from './useSimulate';
import { limitLabel } from './useSimulate';
import { eloDiffFromScore, skillElo } from './elo';
import type { useChessMind } from '../chessmind/useChessMind';
import type { GameAction } from '../state/gameReducer';
import { toPgn } from '../state/gameReducer';
import { ROOT_ID, type GameState, type MoveNode } from '../types';
import { keepArrows } from '../ui/keepArrows';
import { MenuLabel, Popover } from '../ui/Popover';
import { ThinkingBlock } from '../chessmind/ThinkingBlock';
import { DEFAULT_THINK_MOVE_TOKENS } from '../chessmind/protocol';

interface Props {
  sim: ReturnType<typeof useSimulate>;
  cm: ReturnType<typeof useChessMind>;
  state: GameState;
  dispatch: (a: GameAction) => void;
  onExport: (pgn: string) => void;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function tally(games: SimGame[]) {
  const w = games.filter((g) => g.score === 1).length;
  const d = games.filter((g) => g.score === 0.5).length;
  const l = games.filter((g) => g.score === 0).length;
  return { w, d, l, n: games.length, score: games.length ? (w + d / 2) / games.length : 0 };
}

/** One PGN per game (headers from the game, notes as comments), written with the app's PGN writer. */
function gamePgn(g: SimGame): string {
  const nodes: Record<string, MoveNode> = { [ROOT_ID]: { id: ROOT_ID, san: '', parent: null, children: [] } };
  let parent = ROOT_ID;
  g.sans.forEach((san, i) => {
    const id = `s${i}`;
    nodes[id] = { id, san, parent, children: [] };
    nodes[parent].children.push(id);
    parent = id;
  });
  const chessmind = `ChessMind ${g.modelId}`;
  const game: GameState = {
    version: 2,
    startFen: g.startFen,
    nodes,
    currentId: ROOT_ID,
    meta: {
      event: `NoteMate simulation game ${g.n} of ${g.total}: ${g.reason}`,
      date: g.date,
      white: g.modelColor === 'w' ? chessmind : g.opponent,
      black: g.modelColor === 'w' ? g.opponent : chessmind,
      result: g.result,
    },
  };
  return toPgn(game);
}

/** "12...Nf6" for the move played from `fen` ("12..." while it is still being chosen). */
function moveLabel(fen: string, san: string | null): string {
  const [, side, , , , full] = fen.split(' ');
  return `${full}${side === 'w' ? '.' : '...'}${san ?? ''}`;
}

export function SimulatePanel({ sim, cm, state, dispatch, onExport }: Props) {
  const { settings: s, update, phase, games, live, error, latency, thought } = sim;
  // Models without <|end_think|> ignore the think option (known once a model is loaded).
  const canThink = cm.info ? cm.info.thinking : true;
  const busy = phase !== 'idle';
  const t = tally(games);
  const asWhite = tally(games.filter((g) => g.modelColor === 'w'));
  const asBlack = tally(games.filter((g) => g.modelColor === 'b'));
  const avgPlies = games.length ? avg(games.map((g) => g.plies)) : 0;
  const skillsUsed = [...new Set(games.map((g) => g.opponent))];
  const skillOfGames = games.length && skillsUsed.length === 1 ? Number(/Skill (\d+)/.exec(skillsUsed[0])?.[1] ?? s.skill) : null;
  // Score shrunk towards 50% by one virtual draw so a short, one-sided run gives a finite estimate.
  const elo = skillOfGames !== null && t.n > 0 ? Math.round(skillElo(skillOfGames) + eloDiffFromScore((t.w + t.d / 2 + 0.5) / (t.n + 1))) : null;
  const modelReady = cm.settings.enabled && cm.status === 'ready';
  const num = (v: string, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
  };

  const colorLabel = s.modelColor === 'alternate' ? 'alternating colours' : `as ${s.modelColor === 'white' ? 'White' : 'Black'}`;
  const running = phase === 'running' || phase === 'loading';

  return (
    <div className="sim-panel" data-testid="sim-panel">
      <header className="sim-head">
        <span className="sim-title">
          ChessMind vs Stockfish <span className="sim-dev">dev</span>
        </span>
        <span className={`sim-status ${busy ? 'is-busy' : ''}`} data-testid="sim-status">
          {busy && <span className={`status-dot ${phase === 'paused' ? 'busy' : 'on'}`} aria-hidden />}
          {phase === 'idle' ? (games.length ? `${t.w}W ${t.d}D ${t.l}L` : 'idle') : phase === 'loading' ? 'starting…' : phase}
        </span>
      </header>

      <div className="sim-setup">
        <p className="sim-summary" data-testid="sim-summary">
          ChessMind <b>{colorLabel}</b>, {s.choice === 'sample' ? `sampling at ${s.temperature.toFixed(2)}` : 'most likely move'}
          {s.think !== 'off' && `, ${s.think === 'on' ? 'thinking' : 'thinking when it chooses'} (≤${s.thinkTokens} tokens)`} vs Stockfish <b>skill {s.skill}</b>{' '}
          <span className="faint">(≈{skillElo(s.skill)})</span> at {limitLabel(s)}/move · <b>{s.games}</b> game{s.games === 1 ? '' : 's'} from the {s.start === 'current' ? 'current' : 'initial'} position
        </p>
        <Popover
          label="Simulation setup"
          width={340}
          trigger={(p) => (
            <button {...p} className="btn btn-sm" disabled={busy} data-testid="sim-edit">
              <Settings2 size={13} /> Edit
            </button>
          )}
        >
          {() => (
            <div className="pop-form" tabIndex={0} onKeyDown={keepArrows}>
              <MenuLabel>Simulation setup</MenuLabel>
              <fieldset className="sim-controls" disabled={busy}>
                <div className="sim-grid">
                  <label>
                    ChessMind plays
                    <select value={s.modelColor} onChange={(e) => update({ modelColor: e.target.value as typeof s.modelColor })} data-testid="sim-color">
                      <option value="alternate">alternate colours</option>
                      <option value="white">White</option>
                      <option value="black">Black</option>
                    </select>
                  </label>
                  <label>
                    Model move
                    <select value={s.choice} onChange={(e) => update({ choice: e.target.value as typeof s.choice })} data-testid="sim-choice">
                      <option value="argmax">most likely (argmax)</option>
                      <option value="sample">sample</option>
                    </select>
                  </label>
                  {s.choice === 'sample' && (
                    <label>
                      Temperature {s.temperature.toFixed(2)}
                      <input type="range" min={0.3} max={1} step={0.05} value={s.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} data-testid="sim-temp" />
                    </label>
                  )}
                  <label>
                    Stockfish skill (0–20)
                    <input type="number" min={0} max={20} value={s.skill} onChange={(e) => update({ skill: num(e.target.value, 0, 20, 3) })} data-testid="sim-skill" />
                  </label>
                  <label className="sim-wide">
                    Stockfish limit
                    <span className="sim-pair">
                      <select value={s.limitKind} onChange={(e) => update({ limitKind: e.target.value as typeof s.limitKind })} data-testid="sim-limit-kind">
                        <option value="movetime">ms / move</option>
                        <option value="nodes">nodes / move</option>
                      </select>
                      {s.limitKind === 'movetime' ? (
                        <input type="number" min={1} max={60000} value={s.movetime} onChange={(e) => update({ movetime: num(e.target.value, 1, 60000, 100) })} data-testid="sim-limit" />
                      ) : (
                        <input type="number" min={1} max={100000000} value={s.nodes} onChange={(e) => update({ nodes: num(e.target.value, 1, 1e8, 5000) })} data-testid="sim-limit" />
                      )}
                    </span>
                  </label>
                  <label>
                    Start from
                    <select value={s.start} onChange={(e) => update({ start: e.target.value as typeof s.start })} data-testid="sim-start-pos">
                      <option value="current">current position</option>
                      <option value="initial">initial position</option>
                    </select>
                  </label>
                  <label>
                    Games (1–50)
                    <input type="number" min={1} max={50} value={s.games} onChange={(e) => update({ games: num(e.target.value, 1, 50, 4) })} data-testid="sim-games" />
                  </label>
                  <label>
                    Move delay (ms)
                    <input type="number" min={0} max={1000} step={50} value={s.delay} onChange={(e) => update({ delay: num(e.target.value, 0, 1000, 300) })} data-testid="sim-delay" />
                  </label>
                  <label>
                    Think before moving
                    <select value={s.think} onChange={(e) => update({ think: e.target.value as typeof s.think })} data-testid="sim-think">
                      <option value="off">off</option>
                      <option value="auto">model decides</option>
                      <option value="on">always</option>
                    </select>
                  </label>
                  {s.think !== 'off' && (
                    <label>
                      Think budget (tokens)
                      <input type="number" min={16} max={2048} step={16} value={s.thinkTokens} onChange={(e) => update({ thinkTokens: num(e.target.value, 16, 2048, DEFAULT_THINK_MOVE_TOKENS) })} data-testid="sim-think-tokens" />
                    </label>
                  )}
                  <label>
                    Max plies
                    <input type="number" min={2} max={2000} value={s.maxPlies} onChange={(e) => update({ maxPlies: num(e.target.value, 2, 2000, 300) })} data-testid="sim-max-plies" />
                  </label>
                </div>
              </fieldset>
              <p className="field-hint">
                Opponent: a separate Stockfish ({sim.engineName || 'the analysis engine’s build, else Lite'}) with Threads 1. Each game is a new variation with notes on its first and last moves.
              </p>
              {s.think !== 'off' && !canThink && <p className="field-hint">This model cannot think (no &lt;|end_think|&gt; token): it moves directly.</p>}
            </div>
          )}
        </Popover>
      </div>

      {!modelReady && (
        <p className="sim-note" data-testid="sim-model-hint">
          {cm.settings.enabled ? (
            cm.status === 'loading' ? 'The ChessMind model is loading…' : 'Load a ChessMind model first.'
          ) : (
            <>
              Load a ChessMind model first.{' '}
              <button className="btn btn-sm" onClick={() => cm.update({ enabled: true })} data-testid="sim-enable-model">
                Load model
              </button>
            </>
          )}
        </p>
      )}

      <div className="sim-buttons">
        {!busy ? (
          <button className="btn btn-sm btn-primary" onClick={sim.start} data-testid="sim-start">
            <Play size={12} /> Start
          </button>
        ) : phase === 'paused' ? (
          <button className="btn btn-sm btn-primary" onClick={sim.resume} data-testid="sim-resume">
            <Play size={12} /> Resume
          </button>
        ) : (
          <button className="btn btn-sm" onClick={sim.pause} disabled={phase === 'loading'} data-testid="sim-pause">
            <Pause size={12} /> Pause
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={sim.step} disabled={phase === 'loading'} data-testid="sim-step" title="Play one move">
          <StepForward size={12} /> Step
        </button>
        <button className="btn btn-sm btn-ghost" onClick={sim.stop} disabled={!busy} data-testid="sim-stop">
          <Square size={11} /> Stop
        </button>
        {running && <span className="spinner" aria-hidden />}
      </div>

          {live && (
            <p className="sim-live" data-testid="sim-live">
              {live.game > 0 && phase !== 'idle' ? `Game ${live.game}/${live.total} · ply ${live.ply} · ChessMind ${live.modelColor === 'w' ? 'White' : 'Black'} · ` : ''}
              {live.message}
            </p>
          )}
          {error && <p className="error" data-testid="sim-error">{error}</p>}
          {thought && (
            <div className="sim-thought" data-testid="sim-thought">
              <p className="sim-meta">
                Think before {moveLabel(thought.fen, thought.san)}
              </p>
              <ThinkingBlock
                key={`${thought.fen}|${thought.ply}`}
                parts={thought.think.parts}
                open={thought.think.open}
                tokens={thought.think.tokens}
                done={thought.san !== null || phase === 'idle'}
                startFen={thought.fen}
                budget={s.thinkTokens}
              />
            </div>
          )}
          {(latency.model.length > 0 || latency.engine.length > 0) && (
            <p className="sim-meta" data-testid="sim-latency">
              ChessMind {avg(latency.modelWall).toFixed(0)} ms/move (model {avg(latency.model).toFixed(0)} ms, {latency.model.length} moves) · Stockfish{' '}
              {avg(latency.engine).toFixed(0)} ms/move{sim.engineName ? ` (${sim.engineName})` : ''}
            </p>
          )}

          {games.length > 0 && (
            <div className="sim-score" data-testid="sim-score">
              <table>
                <thead>
                  <tr>
                    <th>ChessMind</th>
                    <th>W</th>
                    <th>D</th>
                    <th>L</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {([['total', t], ['as White', asWhite], ['as Black', asBlack]] as const).map(([name, x]) => (
                    <tr key={name} data-testid={`sim-row-${name.replace(' ', '-')}`}>
                      <td>{name}</td>
                      <td>{x.w}</td>
                      <td>{x.d}</td>
                      <td>{x.l}</td>
                      <td>{x.n ? `${(x.score * 100).toFixed(0)}%` : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="sim-meta">
                {games.length} game{games.length === 1 ? '' : 's'} · average {avgPlies.toFixed(0)} plies
                {elo !== null && (
                  <>
                    {' '}· rough Elo <b data-testid="sim-elo">{elo}</b> vs Skill {skillOfGames} ≈ {skillElo(skillOfGames!)}
                  </>
                )}
              </p>
              <p className="sim-meta faint">
                Elo uses ChessMind's approximate Skill Level table (a community mapping for timed play; at short limits Stockfish is weaker), so treat it as a scale, not a rating. The score includes one virtual draw.
              </p>
              <ol className="sim-games" data-testid="sim-games-list">
                {games.map((g, i) => {
                  const alive = g.firstId !== null && !!state.nodes[g.firstId];
                  return (
                    <li key={i} data-result={g.result} data-plies={g.plies} data-first-id={g.firstId ?? ''} data-last-id={g.lastId} data-uci={g.moves.join(' ')} data-start-fen={g.startFen}>
                      <button className="link-btn" disabled={!alive} onClick={() => g.firstId && dispatch({ type: 'GOTO', id: g.firstId })} title="Jump to this game's branch">
                        #{i + 1} {g.modelColor === 'w' ? 'CM–SF' : 'SF–CM'} {g.result}
                      </button>{' '}
                      <span className="faint">
                        {g.score === 1 ? 'win' : g.score === 0 ? 'loss' : 'draw'} · {g.reason} · {g.plies} plies
                      </span>
                      {alive && (
                        <button className="link-btn sim-end" onClick={() => dispatch({ type: 'GOTO', id: g.lastId })} title="Jump to the final position">
                          end
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
              <div className="sim-buttons">
                <button className="link-btn" onClick={() => onExport(games.map(gamePgn).join('\n'))} data-testid="sim-export">Export PGN</button>
                <button className="link-btn" onClick={sim.clear} disabled={busy}>Clear scoreboard</button>
              </div>
            </div>
          )}
    </div>
  );
}
