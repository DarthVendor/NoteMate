/*
 * Board commands typed into the ChessMind chat box, handled locally before anything is sent to the model.
 * Every command maps onto ordinary game actions (so the board's own navigation / delete / promote undo them).
 */
import type { Chess } from 'chess.js';
import type { GameAction } from '../state/gameReducer';
import { nodeLabel, pathTo } from '../state/gameReducer';
import { plyOffset } from '../state/position';
import type { GameState, ShapeColor, Square } from '../types';
import { ROOT_ID } from '../types';

export interface CommandResult {
  actions: GameAction[];
  /** What was done, echoed into the chat. */
  echo: string;
  flip?: boolean;
  /** The command resets the game (the chat is cleared with it). */
  reset?: boolean;
}

export const COMMAND_HINT =
  'Commands: back 2 · forward · go to move 12 · start / end · flip · next / previous variation · make this the main line · delete this line · add note: … · arrow e2 e4 red · highlight e4 · clear arrows · new game · analyse';

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
const COLORS: Record<string, ShapeColor> = { red: 'red', green: 'green', blue: 'blue', yellow: 'yellow', orange: 'yellow', purple: 'chessmind' };
const SQ = '([a-h][1-8])';

const count = (s: string | undefined, dflt = 1) => {
  if (!s) return dflt;
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(1, Math.min(500, Math.floor(n)));
  return NUMBER_WORDS[s.toLowerCase()] ?? dflt;
};
const repeat = (a: GameAction, n: number): GameAction[] => Array.from({ length: n }, () => a);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Parse one chat line; null means "not a command" (it goes to the model). */
export function parseCommand(input: string, state: GameState, chess: Chess): CommandResult | null {
  const raw = input.trim();
  const t = raw.toLowerCase().replace(/(?<!\.)\.$|[!?]+$/, '').replace(/^(please|pls|can you|could you|now)\s+/, '').trim();
  if (!t) return null;
  const node = state.nodes[state.currentId];
  let m: RegExpMatchArray | null;

  if (/^(reset|restart|new game|start (a )?new game|start over|clear (the )?board)$/.test(t)) {
    return { actions: [{ type: 'NEW_GAME' }], echo: 'Started a new game.', reset: true };
  }
  if ((m = t.match(/^(?:undo|take ?back|go back|back|previous move|prev|step back)(?:\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an))?(?:\s+(?:moves?|plies|ply|half-?moves?|steps?|times?))?$/))) {
    const n = count(m[1]);
    const ply = pathTo(state, state.currentId).length;
    const k = Math.min(n, ply);
    if (k === 0) return { actions: [], echo: 'Already at the start position.' };
    return { actions: repeat({ type: 'BACK' }, k), echo: `Went back ${plural(k, 'move')}.` };
  }
  if ((m = t.match(/^(?:redo|go forward|forward|next move|next|step forward)(?:\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an))?(?:\s+(?:moves?|plies|ply|half-?moves?|steps?|times?))?$/))) {
    const n = count(m[1]);
    let k = 0;
    let cur = node;
    while (k < n && cur.children.length) {
      cur = state.nodes[cur.children[0]];
      k++;
    }
    if (k === 0) return { actions: [], echo: 'Already at the end of this line.' };
    return { actions: repeat({ type: 'FORWARD' }, k), echo: `Went forward ${plural(k, 'move')}.` };
  }
  if ((m = t.match(/^(?:go ?to|jump to|show)?\s*(?:move|ply)?\s*(\d+)\s*(\.\.\.|\.|w|b|white|black|for white|for black)?$/)) && /move|go ?to|jump|ply/.test(t)) {
    const moveNo = Number(m[1]);
    const black = !!m[2] && /\.\.\.|b|black/.test(m[2]);
    const byPly = /ply/.test(t);
    // move numbers count from the start FEN's (a set-up position may start at move 23, Black to move)
    const ply = byPly ? moveNo : moveNo * 2 - (black ? 0 : 1) - plyOffset(state.startFen);
    // Along the current line: the path to here, then its main continuation.
    const line = pathTo(state, state.currentId).map((n) => n.id);
    let cur = node;
    while (cur.children.length) {
      cur = state.nodes[cur.children[0]];
      line.push(cur.id);
    }
    if (ply === 0) return { actions: [{ type: 'START' }], echo: 'Went to the start position.' };
    const target = ply > 0 ? line[ply - 1] : undefined;
    if (!target) return { actions: [], echo: `This line has only ${plural(line.length, 'ply')}; there is no move ${moveNo}${black ? '...' : ''}.` };
    return { actions: [{ type: 'GOTO', id: target }], echo: `Went to ${nodeLabel(state, target)}.` };
  }
  if (/^(go to )?(the )?(start|beginning|first move|first position|initial position|home)$/.test(t)) {
    return { actions: [{ type: 'START' }], echo: 'Went to the start position.' };
  }
  if (/^(go to )?(the )?(end|last move|final position|latest)( of (the|this) line)?$/.test(t)) {
    return { actions: [{ type: 'END' }], echo: 'Went to the end of the line.' };
  }
  if (/^(flip|rotate|turn)( the)?( board)?$/.test(t)) {
    return { actions: [], echo: 'Flipped the board.', flip: true };
  }
  if (/^(clear|remove|delete|erase)( all)?( the)?( arrows| shapes| drawings| highlights| arrows and highlights)$/.test(t)) {
    return { actions: [{ type: 'CLEAR_SHAPES' }], echo: 'Cleared the arrows and highlights on this position.' };
  }
  if ((m = t.match(/^(next|previous|prev|other) (variation|alternative|branch|line)$/))) {
    const siblings = node.parent !== null ? state.nodes[node.parent].children : [];
    if (siblings.length < 2) return { actions: [], echo: 'There is no other variation here.' };
    const delta = m[1] === 'next' || m[1] === 'other' ? 1 : -1;
    const i = (siblings.indexOf(node.id) + delta + siblings.length) % siblings.length;
    return { actions: [{ type: 'SIBLING', delta }], echo: `Switched to ${nodeLabel(state, siblings[i])}.` };
  }
  if (/^(delete|remove|discard|cut)( this| the)?( line| variation| branch| move)?( from here)?$/.test(t) && /line|variation|branch|move|here/.test(t)) {
    if (state.currentId === ROOT_ID) return { actions: [], echo: 'Nothing to delete at the start position.' };
    return { actions: [{ type: 'DELETE_FROM', id: state.currentId }], echo: `Deleted ${nodeLabel(state, state.currentId)} and everything after it.` };
  }
  if (/^(make|set|promote)( this| it)?( line| variation)?( (to|as|the|into))*( the)? ?main( line)?$|^promote( this)?( line| variation)?$|^keep as main line$/.test(t)) {
    if (state.currentId === ROOT_ID) return { actions: [], echo: 'The start position is already on the main line.' };
    return { actions: [{ type: 'PROMOTE', id: state.currentId }], echo: `Made the line through ${nodeLabel(state, state.currentId)} the main line.` };
  }
  if ((m = raw.match(/^(?:add (?:a )?note|note|write(?: a note)?|annotate)\s*[:\-–]?\s+([\s\S]+)$/i))) {
    const text = m[1].trim();
    return { actions: [{ type: 'ADD_NOTE', color: 'yellow', text }], echo: `Added a note on ${nodeLabel(state, state.currentId)}: “${text}”.` };
  }
  if ((m = t.match(new RegExp(`^(?:draw )?(?:an )?arrow(?: from)? ${SQ}(?:\\s*(?:to|-|->)\\s*|\\s*)${SQ}(?:\\s+(?:in\\s+)?(\\w+))?$`)))) {
    const color = COLORS[m[3] ?? 'green'] ?? 'green';
    const arrow = { from: m[1] as Square, to: m[2] as Square, color };
    if (arrow.from === arrow.to) return { actions: [], echo: 'An arrow needs two different squares.' };
    const exists = node.annotation?.arrows.some((a) => a.from === arrow.from && a.to === arrow.to && a.color === color);
    if (exists) return { actions: [], echo: `There is already a ${color} arrow ${arrow.from}→${arrow.to}.` };
    return { actions: [{ type: 'TOGGLE_ARROW', arrow }], echo: `Drew a ${color === 'chessmind' ? 'purple' : color} arrow ${arrow.from}→${arrow.to}.` };
  }
  if ((m = t.match(new RegExp(`^(?:highlight|circle|mark)(?: square)? ${SQ}(?:\\s+(?:in\\s+)?(\\w+))?$`)))) {
    const color = COLORS[m[2] ?? 'green'] ?? 'green';
    const exists = node.annotation?.highlights.some((h) => h.square === m![1] && h.color === color);
    if (exists) return { actions: [], echo: `${m[1]} is already highlighted.` };
    return { actions: [{ type: 'TOGGLE_HIGHLIGHT', highlight: { square: m[1] as Square, color } }], echo: `Highlighted ${m[1]}.` };
  }
  // A move in SAN or UCI, optionally prefixed with "play".
  if ((m = raw.match(/^(?:play|move|push)?\s*([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBNqrbn])?[+#]?|O-O(?:-O)?|0-0(?:-0)?|[a-h][1-8][a-h][1-8][qrbn]?)$/))) {
    const text = m[1].replace(/0/g, 'O');
    const legal = chess.moves({ verbose: true });
    const mv = legal.find((x) => x.san === text || x.san.replace(/[+#]/, '') === text.replace(/[+#]/, '') || x.lan === text.toLowerCase());
    if (mv) return { actions: [{ type: 'MAKE_MOVE', from: mv.from as Square, to: mv.to as Square, promotion: mv.promotion as 'q' | 'r' | 'b' | 'n' | undefined }], echo: `Played ${mv.san}.` };
  }
  return null;
}

/** "Analyse this position" style requests: answered with the move prediction plus a short explanation. */
export function isAnalysisRequest(input: string): boolean {
  const t = input.trim().toLowerCase().replace(/[.!?]+$/, '');
  return /^(analy[sz]e|analysis|evaluate|assess)( (this|the|current))?( position| move)?$|^what (should|do|would|can) (i|we|white|black) play( here| now| next)?$|^(what's|what is) (the )?(best|good|right) (move|continuation|plan)( here| now)?$|^best move$|^(any )?suggestions?$|^hint$/.test(t);
}
