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
  notes: { title: 'Notes', takesLine: true, label: 'Notes' },
  all_notes: { title: 'Notes', takesLine: false, label: 'Notes' },
};
/** What NoteMate offers when tools are on (the order of the `[Tools: ...]` block). */
export const OFFERED_TOOLS = ['engine', 'notes', 'all_notes'];

// ---------------------------------------------------------------------------------------------- notes results
/** Characters per note in a result, and per `all_notes` result (the compact fallbacks halve them), as in Python. */
export const NOTE_CHARS = 240;
export const NOTES_CHARS = 600;

export interface NoteEntry {
  /** The move the note is on (`14...Nf6`), or `the start`. */
  label: string;
  texts: string[];
  main: boolean;
}

/** Note text as inert data inside a result block (tools.sanitize_note): one line, no special-token-like markup, no
 * brackets or field bars, at most `limit` characters. */
export function sanitizeNote(text: string, limit = NOTE_CHARS): string {
  let t = text.split(/\s+/).filter(Boolean).join(' ');
  t = t.replaceAll('<|', '<').replaceAll('|>', '>').replaceAll('|', '/').replaceAll('[', '(').replaceAll(']', ')').replaceAll('"', "'");
  if (t.length > limit) t = t.slice(0, Math.max(1, limit - 3)).trimEnd() + '...';
  return t;
}

const quoted = (texts: string[], limit: number) =>
  texts
    .filter((t) => t.trim())
    .map((t) => `"${sanitizeNote(t, limit)}"`)
    .join('; ');

/** The notes tools' result block (tools.notes_result_text): `notes` about one move (`about` null = the start) or
 * `all_notes` (main line first, entries past `totalChars` become `+K more`). */
export function notesResultText(entries: NoteEntry[], about: string | null, allNotes = false, noteChars = NOTE_CHARS, totalChars = NOTES_CHARS): string {
  if (!allNotes) {
    const texts = entries.flatMap((e) => e.texts).filter((t) => t.trim());
    if (about === null) return texts.length ? `[Notes: at the start: ${quoted(texts, noteChars)}]` : '[Notes: none at the start]';
    return texts.length ? `[Notes: on ${about}: ${quoted(texts, noteChars)}]` : `[Notes: none on ${about}]`;
  }
  const live = entries.filter((e) => e.texts.some((t) => t.trim()));
  if (!live.length) return '[Notes: none in this game]';
  const ordered = [...live.filter((e) => e.main), ...live.filter((e) => !e.main)];
  const fields = [`${ordered.length} in this game`];
  let used = 0;
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    const f = `${e.label}${e.main ? '' : ' (variation)'}: ${quoted(e.texts, noteChars)}`;
    if (used + f.length > totalChars && i > 0) {
      fields.push(`+${ordered.length - i} more`);
      break;
    }
    fields.push(f);
    used += f.length;
  }
  return `[Notes: ${fields.join(' | ')}]`;
}

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
  if (p.result === undefined || (!p.result.trim() && p.ok === undefined)) return `${title}…`; // still running
  const r = p.result.trim();
  const err = /no result \(([^)]*)\)/.exec(r);
  if (err) return `${title}: no result (${err[1]})`;
  if (r.startsWith('[Notes: ')) {
    const on = /^\[Notes: on (\S+):/.exec(r);
    if (on) return `Read your note on ${on[1]}`;
    const none = /^\[Notes: none (?:on this position|on ([^\]\s]+)|in this game|at the start)/.exec(r);
    if (none) return none[1] ? `No note on ${none[1]}` : 'No notes';
    const n = /^\[Notes: (\d+) in this game/.exec(r);
    if (n) return `Read your ${n[1]} note${n[1] === '1' ? '' : 's'}`;
    return 'Read your notes';
  }
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
