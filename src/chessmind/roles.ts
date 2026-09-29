/*
 * Prompt roles (port of ChessMind chessmind/model/roles.py, format version 1): models whose manifest says
 * `prompt_roles >= 1` get their chat prompt in the role format --
 *
 *   <|eos|> <|system|> You are ChessMind, a chess assistant. [Mode: coach] [Tools: engine] [<|goal|> ... <|end_goal|>]
 *   <|user|> question [snapshot / line] <|context|> [Position: ...] [You: ...] [Engine: ...] <|end_context|>
 *   <|assistant|> <|think|> ... <|plan|> ... <|end_plan|> <|end_think|> answer
 *
 * The app's bracketed blocks leave the user's words for a (never trained) context segment at the end of the user turn,
 * the [Tools] announcement goes to the system turn, and the think may close with the running plan. Older models keep
 * the plain ctx1 layout (the blocks as the user turn's last text part). Checked against Python by
 * scripts/test-roles.mjs (fixtures/roles.json from ChessMind's scripts/roles_fixture.py).
 */
import type { ChatLeafPart, ChatPart } from '../types';
import type { PromptPart, PromptTurn } from './tokenizer';

export const PROMPT_ROLES_VERSION = 1;
export const PERSONA = 'You are ChessMind, a chess assistant.';
/** App modes (`[Mode: M]`), roles.MODES in Python. */
export const MODES = ['chat', 'coach', 'puzzle', 'analysis', 'simulate'] as const;
export type ChatMode = (typeof MODES)[number];
/** The app's bracketed blocks (APP_BLOCK_RE in Python). */
const APP_BLOCK_RE = /\[(Position|You|Engine|Candidates|Tools|Hint): [^[\]]*\]/g;
/** Blocks that describe the session (system turn), not the position (context). */
const SYSTEM_BLOCKS = ['Tools'];

export interface SystemOptions {
  persona?: boolean;
  mode?: ChatMode | null;
  level?: string | null;
  tools?: string[] | null;
  goal?: string | null;
}

/** `You are ChessMind, a chess assistant. [Mode: puzzle] [Level: ...] [Tools: engine]`. */
export function systemText(o: SystemOptions = {}): string {
  if (o.mode && !MODES.includes(o.mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const blocks = o.persona === false ? [] : [PERSONA];
  if (o.mode) blocks.push(`[Mode: ${o.mode}]`);
  if (o.level) blocks.push(`[Level: ${o.level}]`);
  const names = (o.tools ?? []).filter(Boolean);
  if (names.length) blocks.push(`[Tools: ${names.join(', ')}]`);
  return blocks.join(' ');
}

/** The system turn (text, then the goal), or null when empty. */
export function systemTurn(o: SystemOptions = {}): PromptTurn | null {
  const text = systemText(o);
  const parts: PromptTurn['parts'] = text ? [{ kind: 'text', text }] : [];
  if (o.goal?.trim()) parts.push({ kind: 'goal', text: o.goal.trim() });
  return parts.length ? { role: 'system', parts } : null;
}

/** `[text without the app blocks, blocks in order]` (whitespace of the rest normalised when blocks were found). */
export function splitBlocks(text: string): [string, string[]] {
  const blocks = [...(text ?? '').matchAll(APP_BLOCK_RE)].map((m) => m[0]);
  if (!blocks.length) return [text, []];
  return [text.replace(APP_BLOCK_RE, ' ').split(/\s+/).filter(Boolean).join(' '), blocks];
}

/**
 * ctx1 turns -> the role format (roles.to_roles in Python): each user turn's app blocks leave its text parts and
 * become one context part at the end of the turn; `[Tools: ...]` goes to the system turn (put first; a tools-only one
 * when `system` is null). Role-format turns pass through.
 */
export function toRoles(turns: PromptTurn[], system: PromptTurn | null = null): PromptTurn[] {
  const out: PromptTurn[] = [];
  let tools: string | null = null;
  for (const turn of turns) {
    if (turn.role !== 'user') {
      out.push({ role: turn.role, parts: [...turn.parts] });
      continue;
    }
    const kept: PromptTurn['parts'] = [];
    const blocks: string[] = [];
    for (const p of turn.parts) {
      if (p.kind !== 'text') {
        kept.push(p);
        continue;
      }
      const [text, found] = splitBlocks(p.text);
      for (const b of found) {
        if (SYSTEM_BLOCKS.some((k) => b.startsWith(`[${k}`))) tools ??= b;
        else blocks.push(b);
      }
      if (text.trim()) kept.push({ kind: 'text', text });
    }
    if (blocks.length) kept.push({ kind: 'context', text: blocks.join(' ') });
    out.push({ role: 'user', parts: kept });
  }
  if (!system && out[0]?.role === 'system') system = out[0];
  if (system || tools) {
    const sys: PromptTurn['parts'] = system ? [...system.parts] : [];
    if (tools && !sys.some((p) => p.kind === 'text' && p.text.includes('[Tools:'))) {
      const i = sys.findIndex((p) => p.kind === 'text');
      if (i >= 0) sys[i] = { kind: 'text', text: `${(sys[i] as { text: string }).text} ${tools}` };
      else sys.unshift({ kind: 'text', text: tools });
    }
    if (out[0]?.role === 'system') out.shift();
    out.unshift({ role: 'system', parts: sys });
  }
  return out;
}

/**
 * Inference prompt in the role format (roles.prompt_turns): the system turn first (persona / mode / level / tools /
 * goal), the last user turn's `context` text (the ctx1 blocks, chatContext.ts) as its context segment, and app
 * blocks left in earlier user turns moved the same way.
 */
export function promptTurns(turns: PromptTurn[], context: string | null | undefined, o: SystemOptions = {}): PromptTurn[] {
  const ts = turns.map((t) => ({ role: t.role, parts: [...t.parts] }));
  const last = ts[ts.length - 1];
  if (context?.trim() && last?.role === 'user') last.parts.push({ kind: 'text', text: context.trim() });
  return toRoles(ts, systemTurn(o));
}

/** An earlier think reduced to its plan (a carried plan: masked in training), or null without one. */
export function planOnlyThink(think: Extract<ChatPart, { kind: 'think' }>): ChatPart | null {
  return think.plan?.length ? { kind: 'think', parts: [], plan: think.plan } : null;
}

/** History with every assistant think but the last `keepLast` reduced to its plan (dropped without one), as
 * roles.carry_plans: the compact running thread when earlier thinks cannot all stay in the context. */
export function carryPlans<T extends PromptTurn>(history: T[], keepLast = 1): T[] {
  const idx = history.map((t, i) => (t.role === 'assistant' && t.parts[0]?.kind === 'think' ? i : -1)).filter((i) => i >= 0);
  const reduce = new Set(idx.slice(0, Math.max(0, idx.length - keepLast)));
  return history.map((t, i) => {
    if (!reduce.has(i)) return t;
    const carried = planOnlyThink(t.parts[0] as Extract<ChatPart, { kind: 'think' }>);
    return { ...t, parts: [...(carried ? [carried] : []), ...t.parts.slice(1)] };
  });
}

/** Context / goal parts are prompt-only: the leaf parts a decoded answer can hold never include them. */
export function isPromptPart(p: ChatPart | PromptPart | ChatLeafPart): p is PromptPart {
  return p.kind === 'context' || p.kind === 'goal';
}
