/** ChessMind model settings in a popover: model, backend, reasoning, context and chat options. */
import { SlidersHorizontal } from 'lucide-react';
import type { useChessMind } from './useChessMind';
import { CHAT_MAX_THINK_TOKENS } from './useChessMind';
import { DEFAULT_LINE_RULES } from './lineRules';
import { MenuDivider, MenuLabel, Popover } from '../ui/Popover';
import { keepArrows } from '../ui/keepArrows';

type ChessMindState = ReturnType<typeof useChessMind>;

export function ChessMindSettings({ cm }: { cm: ChessMindState }) {
  const { settings, update, models, modelId, info, status } = cm;
  const model = models?.find((m) => m.id === modelId);
  return (
    <Popover
      label="ChessMind settings"
      width={300}
      trigger={(p) => (
        <button {...p} className="btn btn-ghost btn-icon btn-sm" title="ChessMind settings" aria-label="ChessMind settings" data-testid="chessmind-settings">
          <SlidersHorizontal size={14} />
        </button>
      )}
    >
      {() => (
        <div className="pop-form" tabIndex={0} onKeyDown={keepArrows}>
          <MenuLabel>ChessMind</MenuLabel>
          <label className="check-row">
            <span className="check-text">
              <span>Model loaded</span>
              <span className="field-hint">
                {status === 'ready' && info ? `${info.backend} · loaded in ${(info.loadMs / 1000).toFixed(1)} s${info.cached ? ' (cached)' : ''}` : 'Runs in this browser; cached after the first download'}
              </span>
            </span>
            <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} data-testid="chessmind-toggle" />
          </label>
          {models && models.length > 0 && (
            <>
              <label className="field">
                <span className="field-label">Model</span>
                <select className="select" value={modelId} onChange={(e) => update({ modelId: e.target.value })} data-testid="chessmind-model">
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {(m.params / 1e6).toFixed(0)}M{m.boards ? ' · board' : ''} · {m.sizeMb} MB
                    </option>
                  ))}
                </select>
                {model?.description && <span className="field-hint">{model.description}</span>}
              </label>
              <label className="field">
                <span className="field-label">Backend</span>
                <select className="select" value={settings.backend} onChange={(e) => update({ backend: e.target.value as typeof settings.backend })} data-testid="chessmind-backend">
                  <option value="auto">Automatic</option>
                  <option value="wasm">WebAssembly (CPU)</option>
                  <option value="webgpu">WebGPU</option>
                </select>
              </label>
            </>
          )}
          <MenuDivider />
          <MenuLabel>Chat</MenuLabel>
          {info?.thinking && (
            <label className="field">
              <span className="field-label">Think before answering</span>
              <select className="select" value={settings.think} onChange={(e) => update({ think: e.target.value as typeof settings.think })} data-testid="chessmind-think-mode">
                <option value="auto">Model decides</option>
                <option value="on">Always</option>
                <option value="off">Never</option>
              </select>
              <span className="field-hint">
                Hidden reasoning, up to {CHAT_MAX_THINK_TOKENS} tokens, shown collapsed above the answer. The model learned to reason on engine reviews of game positions: forced on other questions (openings, plans) it tends to review an invented game.
              </span>
            </label>
          )}
          {info?.thinking && (
            <label className="check-row">
              <span className="check-text">
                <span>Anchor game thinks</span>
                <span className="field-hint">When ChessMind thinks before a move (Simulate), its think opens with "I'm playing White, and it's my move." (its side), as every training think does.</span>
              </span>
              <input type="checkbox" checked={settings.thinkAnchor} onChange={(e) => update({ thinkAnchor: e.target.checked })} data-testid="chessmind-think-anchor" />
            </label>
          )}
          <label className="field">
            <span className="field-label">
              Text temperature <span className="mono faint">{settings.temperature.toFixed(2)}</span>
            </span>
            <input type="range" min={0} max={1.5} step={0.05} value={settings.temperature} onChange={(e) => update({ temperature: Number(e.target.value) })} data-testid="chessmind-temperature" />
            <span className="field-hint">Applies to the words only: move lines always use the model's top choice.</span>
          </label>
          <label className="field">
            <span className="field-label">
              Line end threshold <span className="mono faint">answer {settings.lineEndAnswer.toFixed(2)}</span>
            </span>
            <input type="range" min={0.05} max={1} step={0.05} value={settings.lineEndAnswer} onChange={(e) => update({ lineEndAnswer: Number(e.target.value) })} data-testid="chessmind-line-end-answer" />
            <span className="field-label">
              <span className="mono faint">reasoning {settings.lineEndThink.toFixed(2)}</span>
            </span>
            <input type="range" min={0.05} max={1} step={0.05} value={settings.lineEndThink} onChange={(e) => update({ lineEndThink: Number(e.target.value) })} data-testid="chessmind-line-end-think" />
            <span className="field-hint">
              A line stops once the model gives ending it this much probability (1 = only as its top choice), at the length cap below, or at mate, stalemate or a repeated position.
            </span>
          </label>
          <label className="field">
            <span className="field-label">
              Line length cap <span className="mono faint">answer {settings.maxLinePliesAnswer} plies</span>
            </span>
            <input type="range" min={2} max={40} step={1} value={settings.maxLinePliesAnswer} onChange={(e) => update({ maxLinePliesAnswer: Number(e.target.value) })} data-testid="chessmind-max-plies-answer" />
            <span className="field-label">
              <span className="mono faint">reasoning {settings.maxLinePliesThink} plies</span>
            </span>
            <input type="range" min={2} max={40} step={1} value={settings.maxLinePliesThink} onChange={(e) => update({ maxLinePliesThink: Number(e.target.value) })} data-testid="chessmind-max-plies-think" />
            <span className="field-hint">A move line is cut after this many half-moves; the model can end it sooner (it is trained on lines of at most {DEFAULT_LINE_RULES.maxPlies.think} plies).</span>
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Send the game moves</span>
              <span className="field-hint">The moves that led here go with each question</span>
            </span>
            <input type="checkbox" checked={settings.sendMoves} onChange={(e) => update({ sendMoves: e.target.checked })} data-testid="chessmind-send-moves" />
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Lines start from this position</span>
              <span className="field-hint">Sends a board snapshot instead of the move list. A snapshot has no history, so the model may invent how the game got here; the move list grounds it better.</span>
            </span>
            <input type="checkbox" checked={settings.aboutPosition} onChange={(e) => update({ aboutPosition: e.target.checked })} data-testid="chessmind-about-position" />
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Send engine result to ChessMind</span>
              <span className="field-hint">With each question: the move number and, when the analysis engine has searched this position, its evaluation, best move and line. The model quotes these instead of inventing them.</span>
            </span>
            <input type="checkbox" checked={settings.engineContext} onChange={(e) => update({ engineContext: e.target.checked })} data-testid="chessmind-engine-context" />
          </label>
          {info?.thinking && (
            <label className="field">
              <span className="field-label">Tools</span>
              <select className="select" value={settings.tools} onChange={(e) => update({ tools: e.target.value as typeof settings.tools })} data-testid="chessmind-tools">
                <option value="off">Off</option>
                <option value="on">Engine + your notes (model decides)</option>
                <option value="force">Same, first engine call forced (demo)</option>
              </select>
              <span className="field-hint">
                The model may call Stockfish (up to 3 calls, {'≤'} 2.5 s each, on a separate engine) and read the notes you left on moves (read-only) while it thinks or answers; each result is inserted and shown as a chip. Only models trained with tools call on their own; forcing shows the plumbing on older ones.
              </span>
            </label>
          )}
          <label className="field">
            <span className="field-label">I'm playing</span>
            <select className="select" value={settings.userSide} onChange={(e) => update({ userSide: e.target.value as typeof settings.userSide })} data-testid="chessmind-user-side">
              <option value="auto">Auto (board orientation; in Simulate, ChessMind's opponent)</option>
              <option value="white">White</option>
              <option value="black">Black</option>
              <option value="off">Don't say</option>
            </select>
            <span className="field-hint">Sent with each question as [You: White] so answers say "you" for your side and "your opponent" for the other, even when it is not your move.</span>
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Send the model's top moves</span>
              <span className="field-hint">Without an engine result: the prediction chips go along as candidates, so the recommended move matches them.</span>
            </span>
            <input type="checkbox" checked={settings.candidatesContext} onChange={(e) => update({ candidatesContext: e.target.checked })} data-testid="chessmind-candidates-context" />
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Check answers against the board</span>
              <span className="field-hint">Underlines sentences whose facts (material, pawn structure, pieces, checks, open files…) the board contradicts, and evaluations given without an engine result.</span>
            </span>
            <input type="checkbox" checked={settings.checkClaims} onChange={(e) => update({ checkClaims: e.target.checked })} data-testid="chessmind-check-claims" />
          </label>
          <label className="check-row">
            <span className="check-text">
              <span>Treat goal statements as puzzles</span>
              <span className="field-hint">“White has mate in 2”, “Black to play and win”: asked in the puzzle layout (think on, no engine block) and the answer checked with Stockfish.</span>
            </span>
            <input type="checkbox" checked={settings.goalPuzzles !== false} onChange={(e) => update({ goalPuzzles: e.target.checked })} data-testid="chessmind-goal-puzzles" />
          </label>
          <MenuDivider />
          <MenuLabel>Predictions</MenuLabel>
          <label className="check-row">
            <span>Live arrows on the board</span>
            <input type="checkbox" checked={settings.arrows} onChange={(e) => update({ arrows: e.target.checked })} />
          </label>
          <label className="field">
            <span className="field-label">Move context</span>
            <select
              className="select"
              value={String(settings.contextPlies)}
              disabled={!!info && !info.manifest.boards}
              onChange={(e) => update({ contextPlies: e.target.value === 'full' ? 'full' : (Number(e.target.value) as 8 | 16 | 32) })}
              data-testid="chessmind-context"
            >
              <option value="full">Full game</option>
              <option value="8">Last 8 plies + board</option>
              <option value="16">Last 16 plies + board</option>
              <option value="32">Last 32 plies + board</option>
            </select>
            <span className="field-hint">
              {info && !info.manifest.boards
                ? 'This model has no board input, so it always reads the full game.'
                : 'Board-input models see the position directly; a short history keeps deep branches fast.'}
            </span>
          </label>
        </div>
      )}
    </Popover>
  );
}
