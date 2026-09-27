import { Chess, DEFAULT_POSITION } from 'chess.js';
import type { GameState, MoveNode } from '../types';
import { ROOT_ID } from '../types';

/* ---------- Parsing ---------- */

export interface ParsedMove {
  san: string;
  comment?: string;
  variations: ParsedMove[][];
}

export interface ParsedGame {
  headers: Record<string, string>;
  moves: ParsedMove[];
}

/** Parse a single PGN game including nested variations and comments. */
export function parsePgn(pgn: string): ParsedGame {
  const headers: Record<string, string> = {};
  let i = 0;
  const src = pgn.replace(/\r\n?/g, '\n');

  // Headers
  const headerRe = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*/;
  let rest = src;
  for (;;) {
    const m = headerRe.exec(rest);
    if (!m) break;
    headers[m[1]] = m[2].replace(/\\"/g, '"');
    rest = rest.slice(m[0].length);
  }
  const text = rest;
  i = 0;

  const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t';

  function parseSequence(): ParsedMove[] {
    const moves: ParsedMove[] = [];
    let pendingComment: string | undefined;
    while (i < text.length) {
      const c = text[i];
      if (isSpace(c)) { i++; continue; }
      if (c === '{') {
        const end = text.indexOf('}', i);
        const body = text.slice(i + 1, end < 0 ? text.length : end).replace(/\s+/g, ' ').trim();
        i = end < 0 ? text.length : end + 1;
        if (moves.length) {
          const last = moves[moves.length - 1];
          last.comment = last.comment ? `${last.comment} ${body}` : body;
        } else {
          pendingComment = pendingComment ? `${pendingComment} ${body}` : body;
        }
        continue;
      }
      if (c === ';') {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      if (c === '(') {
        i++;
        const variation = parseSequence();
        if (moves.length) moves[moves.length - 1].variations.push(variation);
        continue;
      }
      if (c === ')') { i++; return moves; }
      // Token
      let j = i;
      while (j < text.length && !isSpace(text[j]) && !'{}()'.includes(text[j])) j++;
      const tok = text.slice(i, j);
      i = j;
      if (/^\d+\.*$/.test(tok) || /^\.+$/.test(tok)) continue; // move number
      if (tok.startsWith('$')) continue; // NAG
      if (['1-0', '0-1', '1/2-1/2', '*'].includes(tok)) continue;
      const san = tok.replace(/[!?]+$/, '');
      if (!san) continue;
      const mv: ParsedMove = { san, variations: [] };
      if (pendingComment) {
        mv.comment = pendingComment;
        pendingComment = undefined;
      }
      moves.push(mv);
    }
    return moves;
  }

  return { headers, moves: parseSequence() };
}

let counter = 0;
export const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Build a GameState from parsed PGN, validating every move. Illegal moves end their line. */
export function gameFromParsed(parsed: ParsedGame): GameState {
  const startFen = parsed.headers.FEN ?? DEFAULT_POSITION;
  const nodes: Record<string, MoveNode> = {
    [ROOT_ID]: { id: ROOT_ID, san: '', parent: null, children: [] },
  };

  const addLine = (parentId: string, fen: string, moves: ParsedMove[]) => {
    let pid = parentId;
    let currentFen = fen;
    for (const mv of moves) {
      const chess = new Chess(currentFen);
      let san: string;
      try {
        san = chess.move(mv.san).san;
      } catch {
        return;
      }
      const id = newId();
      const node: MoveNode = { id, san, parent: pid, children: [] };
      if (mv.comment) {
        node.annotation = {
          arrows: [],
          highlights: [],
          notes: [{ id: newId(), text: mv.comment, color: 'yellow', createdAt: Date.now() }],
        };
      }
      nodes[id] = node;
      nodes[pid].children.push(id);
      // Variations are alternatives to this move, so they branch from the parent.
      for (const v of mv.variations) addLine(pid, currentFen, v);
      pid = id;
      currentFen = chess.fen();
    }
  };
  addLine(ROOT_ID, startFen, parsed.moves);

  const h = parsed.headers;
  return {
    version: 2,
    startFen,
    nodes,
    currentId: ROOT_ID,
    meta: { white: h.White, black: h.Black, event: h.Event, date: h.Date, result: h.Result, source: 'pgn' },
  };
}

/* ---------- Writing ---------- */

function escapeComment(text: string) {
  return text.replace(/\}/g, ')').replace(/\s+/g, ' ').trim();
}

/** Serialise a line starting at `id` (inclusive), at the given ply, with variations in parentheses. */
function writeLine(state: GameState, id: string | undefined, ply: number, forceNumber: boolean, skipSiblings: boolean): string {
  const out: string[] = [];
  let needNumber = forceNumber;
  let first = true;
  while (id) {
    const node = state.nodes[id];
    const white = ply % 2 === 1;
    const moveNo = Math.ceil(ply / 2);
    if (white) out.push(`${moveNo}. ${node.san}`);
    else if (needNumber) out.push(`${moveNo}... ${node.san}`);
    else out.push(node.san);
    needNumber = false;
    const notes = node.annotation?.notes.map((n) => escapeComment(n.text)).filter(Boolean) ?? [];
    if (notes.length) {
      out.push(`{ ${notes.join(' | ')} }`);
      needNumber = true;
    }
    if (!(first && skipSiblings)) {
      const siblings = state.nodes[node.parent!].children.filter((c) => c !== id);
      for (const s of siblings) {
        out.push(`( ${writeLine(state, s, ply, true, true)} )`);
        needNumber = true;
      }
    }
    first = false;
    id = node.children[0];
    ply++;
  }
  return out.join(' ');
}

export function toPgn(state: GameState): string {
  const { white, black, event, date, result } = state.meta;
  const headers: string[] = [];
  const add = (k: string, v?: string) => v && headers.push(`[${k} "${v.replace(/"/g, '\\"')}"]`);
  add('Event', event);
  add('Date', date);
  add('White', white);
  add('Black', black);
  add('Result', result ?? '*');
  if (state.startFen !== DEFAULT_POSITION) {
    add('SetUp', '1');
    add('FEN', state.startFen);
  }
  const rootNotes = state.nodes[ROOT_ID].annotation?.notes.map((n) => escapeComment(n.text)).filter(Boolean) ?? [];
  const body = [
    rootNotes.length ? `{ ${rootNotes.join(' | ')} }` : '',
    writeLine(state, state.nodes[ROOT_ID].children[0], 1, true, false),
    result ?? '*',
  ]
    .filter(Boolean)
    .join(' ');
  return `${headers.join('\n')}\n\n${wrap(body, 80)}\n`;
}

function wrap(text: string, width: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width && line) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
