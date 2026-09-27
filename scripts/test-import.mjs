// Tests of the chess.com import path: PGN details, the extension hand-off, the review maths and APPLY_REVIEW.
// Usage: node scripts/test-import.mjs   (Node >= 23: imports the TypeScript sources directly)
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(spec)) {
      for (const ext of ['.ts', '.tsx']) {
        try {
          return next(spec + ext, ctx);
        } catch {
          /* try the next extension */
        }
      }
    }
    return next(spec, ctx);
  },
});

// history.ts uses localStorage.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { parsePgn, gameFromParsed, toPgn, formatTimeControl } = await import('../src/state/pgn.ts');
const { gameReducer, REVIEW_NOTE_PREFIX } = await import('../src/state/gameReducer.ts');
const { decodeImportHash, isImportHash } = await import('../src/import/handoff.ts');
const { gameFromPayload, orientationFor } = await import('../src/import/useExternalImport.ts');
const { winPercent, judgeMoves, sideSummary, movesOf, classify, reviewNote, scoreCp } = await import('../src/review/review.ts');
const { mainLine, reviewStale } = await import('../src/review/useGameReview.ts');
const { pushHistory, loadHistory, takeHistory } = await import('../src/state/history.ts');

let fail = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

const PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.09.27"]
[White "NoteMateTester"]
[Black "OpponentGuy"]
[Result "0-1"]
[WhiteElo "1500"]
[BlackElo "1480"]
[TimeControl "180+2"]
[Termination "OpponentGuy won by checkmate"]
[Link "https://www.chess.com/game/live/111111111"]

1. f3 {[%clk 0:03:00]} 1... e5 {[%clk 0:03:00]} 2. g4 {[%clk 0:02:59.1] a real comment} 2... Qh4# {[%clk 0:02:58]} 0-1
`;

/* ---------- PGN details and clock comments ---------- */
{
  const g = gameFromParsed(parsePgn(PGN));
  const line = mainLine(g);
  check('four moves', line.length === 4, String(line.length));
  const notes = Object.values(g.nodes).flatMap((n) => n.annotation?.notes ?? []);
  check('clock comments are not notes', notes.length === 1 && notes[0].text === 'a real comment', JSON.stringify(notes.map((n) => n.text)));
  const m = g.meta;
  check('meta: source chess.com', m.source === 'chess.com', m.source);
  check('meta: ratings', m.whiteElo === '1500' && m.blackElo === '1480');
  check('meta: time control, termination, link', m.timeControl === '180+2' && m.termination?.includes('checkmate') && m.link === 'https://www.chess.com/game/live/111111111');
  const out = toPgn(g);
  check('toPgn writes the details', /\[WhiteElo "1500"\]/.test(out) && /\[TimeControl "180\+2"\]/.test(out) && /\[Link "https:\/\/www\.chess\.com\/game\/live\/111111111"\]/.test(out), out);
  const again = gameFromParsed(parsePgn(out));
  check('toPgn round-trips the details', again.meta.link === m.link && again.meta.whiteElo === '1500' && mainLine(again).length === 4);
  check('formatTimeControl', formatTimeControl('600') === '10 min' && formatTimeControl('180+2') === '3+2' && formatTimeControl('1/86400') === '1 day/move' && formatTimeControl('90') === '1.5 min');
  const plain = gameFromParsed(parsePgn('[White "A"]\n[Black "B"]\n[Site "?"]\n\n1. e4 e5 *'));
  check('plain PGN stays source pgn', plain.meta.source === 'pgn' && !('link' in plain.meta), JSON.stringify(plain.meta));
}

/* ---------- extension hand-off -> NoteMate ---------- */
{
  const sandbox = { URL, TextEncoder, TextDecoder, Blob, Response, CompressionStream, btoa, Uint8Array };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../extension/lib/handoff.js', import.meta.url), 'utf8'), sandbox);
  const href = await sandbox.NoteMateHandoff.buildImportUrl('http://localhost:4173/', { pgn: PGN, user: 'OpponentGuy', url: 'https://www.chess.com/game/live/111111111' });
  const hash = new URL(href).hash;
  check('import hash recognised', isImportHash(hash));
  const p = await decodeImportHash(hash);
  check('decoded payload', p?.pgn === PGN && p.user === 'OpponentGuy' && p.source === 'chesscom' && p.url === 'https://www.chess.com/game/live/111111111', JSON.stringify(p));
  const game = gameFromPayload(p);
  check('player recorded', game.meta.player === 'OpponentGuy');
  check('orientation: Black for the Black player', orientationFor(game) === 'black');
  check('orientation: White otherwise', orientationFor({ ...game, meta: { ...game.meta, player: 'NoteMateTester' } }) === 'white' && orientationFor({ ...game, meta: { ...game.meta, player: undefined } }) === 'white');
  // Uncompressed variant and bad input.
  const j = Buffer.from(JSON.stringify({ pgn: PGN, url: 'https://evil.example/' })).toString('base64url');
  const pj = await decodeImportHash(`#import=chesscom&v=1&j=${j}`);
  check('j= payload, foreign url dropped', pj?.pgn === PGN && pj.url === undefined);
  check('non-import hash', (await decodeImportHash('#foo')) === null && !isImportHash('#x=1'));
  let threw = false;
  try {
    await decodeImportHash('#import=chesscom&d=%%%');
  } catch {
    threw = true;
  }
  check('garbage payload throws', threw);
  threw = false;
  try {
    gameFromPayload({ source: 'chesscom', pgn: '[White "x"]\n\n1. Ke5 *' });
  } catch {
    threw = true;
  }
  check('PGN without legal moves throws', threw);
}

/* ---------- review maths (as chessmind/scrape/quality.py) ---------- */
{
  check('win% at 0 is 50', Math.abs(winPercent(0) - 50) < 1e-9);
  check('win% clamps at +-1000', winPercent(5000) === winPercent(1000) && winPercent(1000) > 97);
  check('mate scores', scoreCp({ mate: 3 }) === 1000 && scoreCp({ mate: -2 }) === -1000 && scoreCp({ mate: 0 }) === -1000);
  check('thresholds', classify(20, false) === 'blunder' && classify(19.9, false) === 'mistake' && classify(10, false) === 'mistake' && classify(5, false) === 'inaccuracy' && classify(1, true) === 'best' && classify(1, false) === 'good');
  // 1. f3 e5 2. g4?? Qh4#: g4 turns a playable position into mate in one.
  const moves = [
    { nodeId: 'a', san: 'f3' },
    { nodeId: 'b', san: 'e5' },
    { nodeId: 'c', san: 'g4' },
    { nodeId: 'd', san: 'Qh4#' },
  ];
  const evals = [{ cp: 30 }, { cp: 60 }, { cp: -50 }, { mate: 1 }, { mate: 0 }];
  const best = ['e4', 'e5', 'Nc3', 'Qh4#'];
  const r = judgeMoves(moves, evals, best);
  check('f3 is an inaccuracy-or-less', r[0].loss < 10, JSON.stringify(r[0]));
  check('g4 is a blunder with best Nc3', r[2].cls === 'blunder' && r[2].best === 'Nc3' && r[2].ply === 3, JSON.stringify(r[2]));
  check('the mate is best', r[3].cls === 'best' && r[3].loss === 0 && r[3].best === undefined, JSON.stringify(r[3]));
  const w = sideSummary(movesOf(r, 'white'));
  const b = sideSummary(movesOf(r, 'black'));
  check('summary counts', w.blunders === 1 && b.blunders === 0 && b.mistakes === 0, JSON.stringify({ w, b }));
  check('accuracy ordering', b.accuracy > w.accuracy && b.accuracy <= 100 && w.accuracy >= 0, JSON.stringify({ w, b }));
  check('note text', /^Blunder \(−\d+% win chance: \d+% → \d+%\)\. Best was Nc3\.$/.test(reviewNote(r[2])), reviewNote(r[2]));
}

/* ---------- APPLY_REVIEW ---------- */
{
  let g = gameFromParsed(parsePgn(PGN));
  const line = mainLine(g);
  const review = { depth: 8, engine: 'test', moves: [], white: sideSummary([]), black: sideSummary([]), plies: line.length, createdAt: 0 };
  review.moves = line.map((m, i) => ({ nodeId: m.nodeId, ply: i + 1, san: m.san, before: 50, after: 50, loss: 0, cls: 'good' }));
  g = gameReducer(g, { type: 'ADD_NOTE', color: 'yellow', text: 'mine', nodeId: line[2].nodeId });
  g = gameReducer(g, { type: 'APPLY_REVIEW', review, notes: [{ nodeId: line[2].nodeId, text: 'Blunder', color: 'pink' }] });
  const notesAt = (st, id) => st.nodes[id].annotation?.notes ?? [];
  check('review stored', g.review?.plies === 4 && !reviewStale(g));
  check('review note added next to the user note', notesAt(g, line[2].nodeId).length === 3 && notesAt(g, line[2].nodeId).some((n) => n.id.startsWith(REVIEW_NOTE_PREFIX) && n.text === 'Blunder'));
  g = gameReducer(g, { type: 'APPLY_REVIEW', review, notes: [{ nodeId: line[1].nodeId, text: 'Mistake', color: 'blue' }] });
  check('a new review replaces the old notes', notesAt(g, line[2].nodeId).filter((n) => n.id.startsWith(REVIEW_NOTE_PREFIX)).length === 0 && notesAt(g, line[1].nodeId).length === 1);
  check('user notes survive', notesAt(g, line[2].nodeId).length === 2);
  const branched = gameReducer(gameReducer(g, { type: 'GOTO', id: line[3].nodeId }), { type: 'DELETE_FROM', id: line[3].nodeId });
  check('stale after the main line changes', reviewStale(branched));
  g = gameReducer(g, { type: 'APPLY_REVIEW', review: null, notes: [] });
  check('review removed with its notes', !g.review && !Object.values(g.nodes).some((n) => n.annotation?.notes.some((x) => x.id.startsWith(REVIEW_NOTE_PREFIX))));
}

/* ---------- history ---------- */
{
  const g = gameFromParsed(parsePgn(PGN));
  const list = pushHistory(g);
  check('history keeps the game', list.length === 1 && list[0].title.startsWith('NoteMateTester – OpponentGuy') && loadHistory().length === 1, list[0]?.title);
  const empty = gameReducer(g, { type: 'NEW_GAME' });
  check('empty games are not kept', pushHistory(empty).length === 1);
  const { game, list: rest } = takeHistory(list[0].id);
  check('take returns it', game?.state.meta.link === g.meta.link && rest.length === 0 && loadHistory().length === 0);
}

console.log(`${total - fail}/${total} checks passed`);
process.exit(fail ? 1 : 0);
