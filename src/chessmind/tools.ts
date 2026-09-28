/*
 * ChessMind tool calling, the parts shared by the worker, the app and the tests (port of chessmind.model.tools;
 * ChessMind docs/tools.md).
 *
 *   <|tool|> engine [<|line|> g1f3 <|end_line|>] <|tool_result|>  [Engine: Stockfish, depth 18 | eval +0.3 | ...] <|end_tool|>
 *   '------------------- written by the model ----------------------' '----------- inserted by the app ------------'
 *
 * The question announces the tools the app offers with a `[Tools: engine]` block (appended to its context part);
 * the worker constrains the call syntax (constraint.ts ToolConstraint), pauses at `<|tool_result|>`, asks the app to
 * run the tool (a `tool-call` message; the app answers with `tool-result`, or the worker times out), inserts the
 * result and resumes on the KV cache. Results are the prompt-context blocks (promptContext.ts): the engine tool
 * renders exactly the `[Engine: ...]` block a question can carry.
 */
import type { ChatPart, ChatToolPart } from '../types';
import type { ChessTokenizer, DialoguePart } from './tokenizer';
import { engineBlock, formatEval, parseContext, type ContextEngineInfo } from './promptContext';

/** Ids reserved per call in the generation budget, and the ids a result must leave free (tools.py). */
export const RESULT_BUDGET = 96;
export const ANSWER_RESERVE = 24;
/** How long the worker waits for the app's result before inserting a timeout result. */
export const DEFAULT_TOOL_TIMEOUT_MS = 12000;

/** The tools NoteMate can run: result title, and whether a call may carry a line. */
export const TOOL_SPECS: Record<string, { title: string; takesLine: boolean; label: string }> = {
  engine: { title: 'Engine', takesLine: true, label: 'Engine' },
};

/** `[Tools: engine, tablebase]` ('' for none). */
export function toolsBlock(names: string[]): string {
  const n = names.filter(Boolean);
  return n.length ? `[Tools: ${n.join(', ')}]` : '';
}

export function parseToolsBlock(text: string | undefined): string[] {
  const m = /\[Tools: ([^[\]]*)\]/.exec(text ?? '');
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** User parts with the tools block: appended to the last text part when that is the context part (it starts with
 * `[`), else as its own last text part (tools.add_tools_block in Python: the block always tokenizes the same way). */
export function addToolsBlock(parts: DialoguePart[], names: string[]): DialoguePart[] {
  const block = toolsBlock(names);
  if (!block) return parts;
  const out = [...parts];
  const last = out[out.length - 1];
  if (last?.kind === 'text' && last.text.trimStart().startsWith('[')) out[out.length - 1] = { kind: 'text', text: `${last.text} ${block}` };
  else out.push({ kind: 'text', text: block });
  return out;
}

/** `[Engine: no result (timeout)]`: what the model reads when a call failed. */
export function errorText(title: string, reason: string): string {
  return `[${title}: no result (${reason})]`;
}

export interface ToolResultData {
  text: string;
  ok: boolean;
  /** Shorter renderings, tried when `text` does not fit the context. */
  compact?: string[];
}

/** The engine tool's result: the `[Engine: ...]` block, then compact fallbacks (tools.engine_result). */
export function engineToolResult(fen: string, info: ContextEngineInfo, numbers = true): ToolResultData {
  const full = engineBlock(fen, info, { numbers });
  if (!full) return { text: errorText('Engine', 'no line'), ok: false };
  const compact = [engineBlock(fen, info, { maxLinePlies: 4, alternatives: 1, numbers }), engineBlock(fen, info, { showLine: false, alternatives: 0, numbers })];
  return { text: full, ok: true, compact: compact.filter((c) => c && c !== full) };
}

/** `[Engine: checkmate, White wins]` / `[Engine: stalemate, draw]` for a finished position (side to move `turn`). */
export function gameOverText(kind: 'checkmate' | 'stalemate' | 'insufficient', turn: 'w' | 'b', title = 'Engine'): string {
  if (kind === 'checkmate') return `[${title}: checkmate, ${turn === 'w' ? 'Black' : 'White'} wins]`;
  if (kind === 'stalemate') return `[${title}: stalemate, draw]`;
  return `[${title}: insufficient material, draw]`;
}

/** The ids inserted after `<|tool_result|>`: the first rendering that leaves ANSWER_RESERVE ids of `room`, else "no room". */
export function fitToolResult(t: ChessTokenizer, result: ToolResultData, room: number, title: string): { ids: number[]; text: string } {
  const limit = room - ANSWER_RESERVE;
  for (const text of [result.text, ...(result.compact ?? []), errorText(title, 'no room')]) {
    const ids = t.encodeToolResult(text);
    if (ids.length <= limit) return { ids, text };
  }
  return { ids: [t.endToolId!], text: '' };
}

/** Every tool call of a message (think included), in order. */
export function toolCalls(parts: ChatPart[]): ChatToolPart[] {
  const out: ChatToolPart[] = [];
  for (const p of parts) {
    if (p.kind === 'tool') out.push(p);
    else if (p.kind === 'think') for (const q of p.parts) if (q.kind === 'tool') out.push(q);
  }
  return out;
}

/** Short chip label of a call: "Engine: +0.4, best Nf3", "Engine: no result (timeout)", "Engine…" while pending. */
export function toolChipLabel(p: ChatToolPart): string {
  const title = TOOL_SPECS[p.name]?.label ?? (p.name ? p.name[0].toUpperCase() + p.name.slice(1) : 'Tool');
  if (p.result === undefined) return `${title}…`;
  const r = p.result.trim();
  const err = /no result \(([^)]*)\)/.exec(r);
  if (err) return `${title}: no result (${err[1]})`;
  const ctx = parseContext(r);
  if (ctx.engine?.eval) {
    const best = ctx.engine.best ? `, best ${ctx.engine.best.replace(/^\d+\.+/, '')}` : '';
    return `${title}: ${ctx.engine.eval ?? '?'}${best}`;
  }
  const m = /^\[[^:]+: ([^\]|]*)/.exec(r);
  return `${title}: ${m ? m[1].trim() : r.slice(0, 40)}`;
}

/** Evaluations the message's tool results state (the claim checker does not flag these as made up). */
export function toolEvals(parts: ChatPart[]): string[] {
  const out: string[] = [];
  for (const c of toolCalls(parts)) {
    const e = parseContext(c.result).engine;
    if (e?.eval) out.push(e.eval, ...e.also.map((a) => a[1]));
  }
  return out;
}

export { formatEval };
