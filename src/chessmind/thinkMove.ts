/*
 * Think-then-move (port of chessmind.model.think_move.ThinkMoveConstraint; the format: chessmind.data.game_thinks).
 * After a per-side game prompt `<|bos|> <|game|> <side to move> m1 ... mk` the model writes
 *
 *   [<|think|> <side to move> text / <|line|> ... <|end_line|> ... <|end_think|>] move
 *
 * with no <|move|> after <|end_think|>: the next token is the game move. The mask at every step:
 *   - first token: think true -> <|think|> only; null (auto) -> <|think|> or a legal move; false -> a legal move;
 *   - after <|think|>: the side-to-move token (forced), then (`anchorIds`) the perspective anchor, teacher-forced one
 *     id at a time: "I'm playing White, and it's my move." (anchorIds(); every training think opens with the player's
 *     side, ChessMind chessmind.data.perspective.GAME_ANCHOR). The forced ids count as think tokens;
 *   - in the think: text, <|line|> and <|end_think|> (no <|fen|>: in-game lines always start from the game position;
 *     no <|eos|>, no <|move|>); inside a line the LineWalker masks (legal moves, branches, forced markers) with the
 *     think cap of LineRules; after `maxThinkTokens` think tokens the line (if open) and then the think are closed;
 *   - after <|end_think|>: a legal move of the game position; after the move, <|eos|> (generation stops).
 * Parity: scripts/test-think-move.mjs against fixtures/think-move.json (ChessMind's scripts/think_move_fixture.py); the
 * anchor: scripts/test-perspective.mjs against fixtures/perspective.json (ChessMind's scripts/perspective_fixture.py).
 */
import { Chess } from 'chess.js';
import type { ChessTokenizer } from './tokenizer';
import { DEFAULT_LINE_RULES, LineWatch, type LineRules } from './lineRules.ts';
import { LineWalker } from './lines.ts';
import type { GenConstraint } from './constraint';
import { DEFAULT_THINK_MOVE_TOKENS } from './protocol.ts';
import type { ChatLeafPart } from '../types';

export type ThinkMovePhase = 'start' | 'side' | 'think' | 'move' | 'done';

/** The in-game think's perspective anchor (ChessMind chessmind.data.perspective.GAME_ANCHOR, the canonical form). */
export const GAME_ANCHOR = "I'm playing {S}, and it's my move.";

export function anchorText(white: boolean): string {
  return GAME_ANCHOR.replace('{S}', white ? 'White' : 'Black');
}

/** Text ids of the anchor for the player of `white` (ChessMind think_move.anchor_ids: encoded as the first text part
 * of a training think is). */
export function anchorIds(t: ChessTokenizer, white: boolean): number[] {
  return t.encodeText(anchorText(white));
}

export class ThinkMoveConstraint implements GenConstraint {
  readonly think: boolean | null;
  phase: ThinkMovePhase = 'start';
  thinkTokens = 0;
  /** The game move (UCI) once chosen. */
  move: string | null = null;
  private readonly t: ChessTokenizer;
  private readonly fen: string | undefined;
  private readonly legal: number[];
  private readonly sideId: number;
  private readonly thinkText: number[];
  private readonly maxThinkTokens: number | null;
  private readonly rules: LineRules;
  /** Tokenizers with branches / markers: the open line's walker; older ones: the open line's board. */
  private walker: LineWalker | null = null;
  private line: LineWatch | null = null;
  private seen = 0;
  private readonly anchor: number[];
  /** The anchor ids still to force (after the side token). */
  private forced: number[] = [];
  /** The running plan closing the think (ChessMind think_chain plan_part, the prompt-role tokens): <|plan|> once, not
   * as the first content token, inside it text / lines / <|end_plan|>, then only <|end_think|>. */
  private readonly planId: number | null;
  private readonly endPlanId: number | null;
  private inPlan = false;
  private planDone = false;

  /** `fen`: the game position (undefined = the initial position). Tokenizers without <|end_think|> never think.
   * `anchorIds`: forced right after the side token (anchorIds(t, side to move is White)); null = none. `plan`: the
   * think may close with <|plan|> ... <|end_plan|> (models trained with it: manifest think_plan). */
  constructor(t: ChessTokenizer, fen: string | undefined, think: boolean | null = true, maxThinkTokens: number | null = DEFAULT_THINK_MOVE_TOKENS, rules: LineRules = DEFAULT_LINE_RULES, anchorIds: number[] | null = null, plan = false) {
    this.t = t;
    this.planId = plan && t.supportsRoles ? t.planId : null;
    this.endPlanId = this.planId !== null ? t.endPlanId : null;
    this.anchor = [...(anchorIds ?? [])];
    this.fen = fen;
    const endThink = t.endThinkId;
    this.think = endThink === null ? false : think;
    this.maxThinkTokens = maxThinkTokens;
    this.rules = rules;
    const board = new Chess(fen);
    this.legal = board.moves({ verbose: true }).map((m) => t.moveToId(m.lan));
    this.sideId = board.turn() === 'w' ? t.whiteId : t.blackId;
    const text: number[] = [];
    for (let i = t.textOffset; i < t.extraOffset; i++) text.push(i);
    this.thinkText = endThink === null ? text : [...text, t.lineId, endThink];
  }

  get inLine(): boolean {
    return this.walker !== null || this.line !== null;
  }
  get done(): boolean {
    return this.phase === 'done';
  }
  /** Main-line plies of the open line. */
  private get linePlies(): number {
    return this.walker ? this.walker.plies : (this.line?.plies ?? 0);
  }

  feed(id: number) {
    const t = this.t;
    switch (this.phase) {
      case 'start':
        if (id === t.thinkId) this.phase = 'side';
        else if (t.isMoveId(id)) {
          this.move = t.idToMove(id);
          this.phase = 'done';
        }
        return;
      case 'side':
        this.phase = 'think';
        this.thinkTokens = 1;
        this.forced = [...this.anchor];
        return;
      case 'think':
        this.thinkTokens++;
        if (this.forced.length) {
          this.forced.shift();
          return;
        }
        if (this.inLine) {
          if (id === t.endLineId) {
            this.walker = null;
            this.line = null;
          } else if (this.walker) this.walker.feed(id);
          else if (this.line && t.isMoveId(id)) this.line.push(t.idToMove(id));
          return;
        }
        if (this.planId !== null && id === this.planId && !this.inPlan) {
          this.inPlan = true;
          return;
        }
        if (this.endPlanId !== null && id === this.endPlanId && this.inPlan) {
          this.inPlan = false;
          this.planDone = true;
          return;
        }
        if (id === t.lineId) {
          if (t.supportsBranches) this.walker = new LineWalker(t, this.fen);
          else this.line = new LineWatch(this.fen);
        } else if (id === t.endThinkId) this.phase = 'move';
        return;
      case 'move':
        if (t.isMoveId(id)) {
          this.move = t.idToMove(id);
          this.phase = 'done';
        }
        return;
    }
  }

  /** Follow `out` (the ids generated after the game prompt). */
  sync(out: number[]) {
    for (let i = this.seen; i < out.length; i++) this.feed(out[i]);
    this.seen = Math.max(this.seen, out.length);
  }

  /** Ids allowed next (after the ids fed so far). */
  allowedIds(): number[] {
    const t = this.t;
    switch (this.phase) {
      case 'start':
        if (this.think === true) return [t.thinkId];
        if (this.think === null) return [t.thinkId, ...this.legal];
        return [...this.legal];
      case 'side':
        return [this.sideId];
      case 'think': {
        if (this.forced.length) return [this.forced[0]];
        const over = this.maxThinkTokens !== null && this.thinkTokens >= this.maxThinkTokens;
        const max = this.rules.maxPlies.think;
        if (this.walker) return this.walker.allowed(over || this.walker.plies >= max);
        if (this.line) {
          if (over || this.line.plies >= max || (this.rules.stopFinished && this.line.ended())) return [t.endLineId];
          const moves = this.line.board.moves({ verbose: true }).map((m) => t.moveToId(m.lan));
          return [...moves, t.endLineId];
        }
        if (this.planId !== null) {
          if (this.planDone) return [t.endThinkId!];
          if (this.inPlan) return over ? [this.endPlanId!] : [...this.thinkText.filter((i) => i !== t.endThinkId), this.endPlanId!];
          if (!over && this.thinkTokens >= 2 + this.anchor.length) return [...this.thinkText, this.planId];
        }
        if (over) return [t.endThinkId!];
        return this.thinkText;
      }
      case 'move':
        return [...this.legal];
      default:
        return [t.eosId];
    }
  }

  allowed(out: number[]): number[] {
    this.sync(out);
    return this.allowedIds();
  }

  /** Inside a think line with a main-line move (outside branches): the P(<|end_line|>) that ends it. */
  endThreshold(): number | null {
    if (this.phase !== 'think' || !this.inLine || this.linePlies === 0) return null;
    if (this.walker?.inBranch) return null;
    return this.rules.endP.think;
  }
}

/** SAN-like move tokens inside free text: pieces, disambiguation, captures, destination square, promotion,
 * check/mate suffix, or castling (both "O-O"/"O-O-O" and "0-0"/"0-0-0" spellings). Permissive on purpose: a leading
 * move number ("13...", "30.") is not part of the token and is left out by not matching it. */
const SAN_TOKEN = /O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?/g;

/** The last non-empty sentence of `text` (split at ". " / "! " / "? " boundaries; a bare "13..." or "30." move-number
 * prefix has no following space before its move, so it never splits a decision sentence off its move). */
function lastSentence(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length ? sentences[sentences.length - 1] : text.trim();
}

/**
 * The move a closed think's own decision sentence names, if it parses unambiguously to one legal move of `fen`.
 * Training guarantees the move right after `<|end_think|>` is always identical to the move named in the think's own
 * closing decision sentence (ChessMind `chessmind/data/game_thinks.py::encode_think_game` appends the exact same
 * `moves[ply]` that `game_thinks_build.py::render_engine_think` phrases via `engine_dialogues.move_label()`; see
 * ChessMind docs/v5-rl.md section 1 for the phrasings this is built to parse: "So e4.", "13...fxe6 it is.",
 * "So 30.Qh7+.", "Nb6#" style declarations). At inference the move token is only sampled independently and legality-
 * constrained (`ThinkMoveConstraint` above), so nothing ties it back to what the think's prose just concluded --
 * this is the override that restores that link.
 *
 * Finds the last `{kind:'text'}` part of `parts` (the decision sentence is always at the very end of the think),
 * takes its last sentence, extracts SAN-like tokens (`SAN_TOKEN`) and resolves each against a fresh board at `fen`
 * with chess.js (permissive SAN parsing, not sloppy in the piece sense but tolerant of the usual variations).
 * Returns the move's UCI when every candidate that resolves agrees on exactly one legal move; null when nothing
 * named parses/is legal, or when more than one distinct legal move is named (ambiguous) -- callers should fall back
 * to the independently sampled move token unchanged in either case.
 */
export function decisionMove(parts: ChatLeafPart[], fen: string): string | null {
  let text: string | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === 'text') {
      text = p.text;
      break;
    }
  }
  if (!text) return null;
  const trimmed = text.trim();
  // Every documented decision sentence ends with terminal punctuation ("So e4.", "13...fxe6 it is.", "So 30.Qh7+.").
  // When the think was force-closed by hitting its token budget mid-sentence, the trailing text has none: it is a
  // half-finished clause (maybe naming a candidate still under comparison, not the actual decision), so it is never
  // treated as a decision here.
  if (!trimmed || !/[.!?]$/.test(trimmed)) return null;
  const sentence = lastSentence(trimmed);
  const candidates = sentence.match(SAN_TOKEN);
  if (!candidates || !candidates.length) return null;
  const found = new Set<string>();
  for (const c of candidates) {
    try {
      const board = new Chess(fen);
      const mv = board.move(c);
      found.add(`${mv.from}${mv.to}${mv.promotion ?? ''}`);
    } catch {
      // Not a legal move of this position (or not really SAN at all): ignored, not an error.
    }
  }
  return found.size === 1 ? [...found][0] : null;
}
