/*
 * Simulate export: every game with a per-move trace (the model's probability, time and hidden reasoning before its
 * moves; Stockfish's move and search eval) as JSON for offline analysis, plus the PGN with the thinks as comments.
 */
import { Chess } from 'chess.js';
import type { ChatLeafPart, LineBranch } from '../types';
import type { SimGame } from './useSimulate';

/** SAN of a line of UCI moves from `fen` (stops at the first illegal move, marked "?"). */
function sanLine(fen: string, moves: string[], branches?: LineBranch[]): string {
  const b = new Chess(fen);
  const out: string[] = [];
  moves.forEach((m, i) => {
    const num = b.turn() === 'w' ? `${b.moveNumber()}.` : i === 0 ? `${b.moveNumber()}...` : '';
    const before = b.fen();
    try {
      out.push(`${num}${b.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }).san}`);
    } catch {
      out.push(`${num}${m}?`);
      return;
    }
    for (const br of branches ?? []) if (br.at === i) out.push(`(${sanLine(before, br.moves, br.branches)})`);
  });
  return out.join(' ');
}

/** The think's parts as plain text: words as written, lines in SAN from the position they start at. */
export function thinkText(parts: ChatLeafPart[], fen: string): string {
  let start = fen;
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') out.push(p.text.trim());
    else if (p.kind === 'fen') start = p.fen;
    else if (p.kind === 'line') out.push(`[${sanLine(start, p.moves, p.branches)}${p.end ? ` <${p.end}>` : ''}]`);
    else if (p.kind === 'tool') out.push(`{${p.name}${p.result ? `: ${p.result}` : ''}}`);
  }
  return out.filter(Boolean).join(' ');
}

function pgnOf(g: SimGame): string {
  const tags = [
    ['Event', 'NoteMate Simulate'],
    ['Date', g.date],
    ['White', g.modelColor === 'w' ? g.modelId : g.opponent],
    ['Black', g.modelColor === 'b' ? g.modelId : g.opponent],
    ['Result', g.result],
    ['Termination', g.reason],
    ...(g.startFen !== new Chess().fen() ? [['SetUp', '1'], ['FEN', g.startFen]] : []),
  ];
  const b = new Chess(g.startFen);
  const body: string[] = [];
  g.trace.forEach((t, i) => {
    const num = b.turn() === 'w' ? `${b.moveNumber()}.` : i === 0 || g.trace[i - 1].think ? `${b.moveNumber()}...` : '';
    b.move(t.san);
    body.push(`${num}${num ? ' ' : ''}${t.san}`);
    const note = [t.side === 'model' ? `p=${t.p?.toFixed(3)}` : '', t.evalText ? `eval ${t.evalText}` : '', t.think ? `think: ${t.think.text}` : '']
      .filter(Boolean)
      .join(' | ');
    if (note) body.push(`{ ${note.replace(/[{}]/g, '')} }`);
  });
  return `${tags.map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join('\n')}\n\n${body.join(' ')} ${g.result}\n`;
}

/** Everything as one JSON document: settings, the model, and each game with its trace and PGN. */
export function exportJson(games: SimGame[], settings: unknown): string {
  return JSON.stringify(
    { format: 'notemate-simulate-v1', exportedAt: new Date().toISOString(), settings, games: games.map((g) => ({ ...g, pgn: pgnOf(g) })) },
    null,
    1,
  );
}

/** Save `text` as a file (the browser's download). */
export function download(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
