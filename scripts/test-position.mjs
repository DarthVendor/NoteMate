// Tests of setting up a position (src/state/position.ts and the NEW_GAME-from-FEN reducer path): FEN validation with
// clear errors (kings, side not to move in check, castling rights vs pieces, pawn counts, en passant), the board
// editor model (FEN <-> editor round trip, castling / en-passant normalisation), and a new game from a FEN (empty move
// tree, chat cleared, meta source 'setup', moves playable, PGN with [SetUp "1"] and [FEN], saved-game title).
// Usage: node scripts/test-position.mjs   (Node >= 23: imports the TypeScript sources directly)
import { registerHooks } from 'node:module';

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

const { checkFen, plyOffset, parseEditorFen, editorFen, normalizeEditor, epCandidates, castleAllowed, isStandardStart, gameFromFen, EMPTY_FEN } = await import('../src/state/position.ts');
const { gameReducer, initialGameState, positionAt, nodeLabel } = await import('../src/state/gameReducer.ts');
const { toPgn, parsePgn, gameFromParsed } = await import('../src/state/pgn.ts');
const { gameTitle } = await import('../src/state/history.ts');
const { DEFAULT_POSITION } = await import('chess.js');

let fail = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};
const bad = (name, fen, re) => {
  const r = checkFen(fen);
  check(name, !r.ok && re.test(r.error), JSON.stringify(r));
};
const good = (name, fen, expectFen) => {
  const r = checkFen(fen);
  check(name, r.ok && (!expectFen || r.fen === expectFen), JSON.stringify(r));
  return r;
};

// ---------------------------------------------------------------- validation
good('standard start', DEFAULT_POSITION, DEFAULT_POSITION);
good('puzzle-like middlegame', 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
good('placement only gets defaults', 'k7/8/8/8/8/8/8/K7', 'k7/8/8/8/8/8/8/K7 w - - 0 1');
good('placement and side', 'k7/8/8/8/8/8/8/K7 b', 'k7/8/8/8/8/8/8/K7 b - - 0 1');
good('extra whitespace', '  k7/8/8/8/8/8/8/K7   w  -  - 0 1 ');
bad('empty', '   ', /Enter a FEN/);
bad('garbage', 'hello world', /8 ranks/);
bad('7 ranks', 'k7/8/8/8/8/8/K7 w - - 0 1', /8 ranks/);
bad('rank too long', 'k8/8/8/8/8/8/8/K7 w - - 0 1', /8 ranks|squares/);
bad('no kings', EMPTY_FEN, /king/i);
bad('no black king', '8/8/8/8/8/8/8/K7 w - - 0 1', /black king/i);
bad('two black kings', 'kk6/8/8/8/8/8/8/K7 w - - 0 1', /black kings/i);
bad('pawn on rank 1', 'k7/8/8/8/8/8/8/KP6 w - - 0 1', /pawns/i);
bad('pawn on rank 8', 'kP6/8/8/8/8/8/8/K7 w - - 0 1', /pawns/i);
bad('bad side', 'k7/8/8/8/8/8/8/K7 x - - 0 1', /side|turn|move/i);
bad('side not to move in check', 'k7/8/8/8/8/8/8/K6Q w - - 0 1', /Black is in check but it is White's move/);
bad('kings touching', 'kK6/8/8/8/8/8/8/8 w - - 0 1', /in check/);
good('side to move in check is fine', 'k7/8/8/8/8/8/8/K6Q b - - 0 1');
bad('nine pawns', 'k7/pppppppp/p7/8/8/8/8/K7 w - - 0 1', /Black has 9 pawns/);
bad('too many promoted pieces', 'k7/8/8/8/8/8/PPPPPPPP/KQQ5 w - - 0 1', /promoted/);
good('promoted queen with a pawn missing', 'k7/8/8/8/8/8/PPPPPPP1/KQQ5 w - - 0 1');
bad('castling right without the king home', 'r3k2r/8/8/8/8/8/8/R4K1R w KQkq - 0 1', /"K".*king on e1/);
bad('castling right without the rook', 'r3k3/8/8/8/8/8/8/R3K2R w KQkq - 0 1', /"k".*rook on h8/);
good('castling rights with pieces home', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
bad('en passant with no pawn behind it', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 1', /En-passant|en-passant/);
bad('en passant on the wrong rank', 'rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 2', /en-passant/i);
good('en passant after a double step', 'rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3', 'rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3');
const mate = good('checkmate is allowed with a warning', 'k7/1Q6/1K6/8/8/8/8/8 b - - 0 1');
check('checkmate warning', mate.ok && /checkmated/.test(mate.warning ?? ''), JSON.stringify(mate));
const stale = good('stalemate is allowed with a warning', 'k7/2Q5/1K6/8/8/8/8/8 b - - 0 1');
check('stalemate warning', stale.ok && /stalemated/.test(stale.warning ?? ''), JSON.stringify(stale));
check('isStandardStart ignores counters', isStandardStart(DEFAULT_POSITION.replace(/ 0 1$/, ' 3 7')) && !isStandardStart('k7/8/8/8/8/8/8/K7 w - - 0 1'));

// ---------------------------------------------------------------- editor model
for (const fen of [DEFAULT_POSITION, EMPTY_FEN, 'r3k2r/8/8/8/8/8/8/R3K2R b Kq - 12 40', 'rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3']) {
  const p = parseEditorFen(fen);
  check(`editor round trip ${fen}`, p && editorFen(p) === fen, p && editorFen(p));
}
check('editor rejects a malformed placement', parseEditorFen('k7/8/8/8/8/8/8') === null && parseEditorFen('k7/8/8/8/8/8/8/K7X w') === null);
{
  const p = parseEditorFen(DEFAULT_POSITION);
  check('castling allowed at the start', ['K', 'Q', 'k', 'q'].every((c) => castleAllowed(p, c)));
  const moved = { ...p, pieces: { ...p.pieces } };
  delete moved.pieces.h1; // the h1 rook is gone: White O-O goes
  delete moved.pieces.e8;
  moved.pieces.d8 = { color: 'b', type: 'k' }; // the black king moved off e8: both black rights go (d8 had the queen)
  const n = normalizeEditor(moved);
  check('castling normalised', n.castling.K === false && n.castling.Q === true && n.castling.k === false && n.castling.q === false, JSON.stringify(n.castling));
  check('normalised FEN', editorFen(n) === 'rnbk1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w Q - 0 1', editorFen(n));
}
{
  // after 1.e4 (Black to move) with a black pawn on d4: e3 is the en-passant square
  const p = parseEditorFen('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3');
  check('ep candidates', JSON.stringify(epCandidates(p)) === '["e3"]', JSON.stringify(epCandidates(p)));
  const withEp = normalizeEditor({ ...p, ep: 'e3' });
  check('ep kept when possible', withEp.ep === 'e3');
  check('ep FEN valid', checkFen(editorFen(withEp)).ok, JSON.stringify(checkFen(editorFen(withEp))));
  const flipped = normalizeEditor({ ...withEp, turn: 'w' });
  check('ep dropped when the side to move changes', flipped.ep === null);
  check('no ep candidates at the start', epCandidates(parseEditorFen(DEFAULT_POSITION)).length === 0);
}

// ---------------------------------------------------------------- new game from a FEN (reducer)
const FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
let s = initialGameState();
s = gameReducer(s, { type: 'MAKE_MOVE', from: 'e2', to: 'e4' });
s = gameReducer(s, { type: 'CHAT_APPEND', messages: [{ id: 'x', role: 'user', kind: 'command', parts: [{ kind: 'text', text: 'hi' }] }] });
const fresh = gameReducer(s, { type: 'NEW_GAME', startFen: FEN });
check('NEW_GAME startFen', fresh.startFen === FEN, fresh.startFen);
check('NEW_GAME empty tree', Object.keys(fresh.nodes).length === 1 && fresh.nodes.root.children.length === 0 && fresh.currentId === 'root');
check('NEW_GAME chat cleared', Array.isArray(fresh.chat) && fresh.chat.length === 0);
check('NEW_GAME source setup', fresh.meta.source === 'setup', JSON.stringify(fresh.meta));
check('NEW_GAME invalid FEN leaves the game', gameReducer(s, { type: 'NEW_GAME', startFen: 'nonsense' }) === s);
check('NEW_GAME without FEN is the standard start', gameReducer(s, { type: 'NEW_GAME' }).startFen === DEFAULT_POSITION);
check('standard FEN keeps source manual', gameFromFen(DEFAULT_POSITION).meta.source === 'manual');
let g = gameReducer(fresh, { type: 'MAKE_MOVE', from: 'h5', to: 'f7' });
check('move from the set-up position', g.nodes[g.currentId]?.san === 'Qxf7#', g.nodes[g.currentId]?.san);
check('position after the move', positionAt(g, g.currentId).isCheckmate());
const pgn = toPgn(g);
check('PGN has SetUp and FEN', pgn.includes('[SetUp "1"]') && pgn.includes(`[FEN "${FEN}"]`), pgn);
check('PGN move numbers from the FEN', /\b4\. Qxf7#/.test(pgn), pgn);
check('node label from the FEN', nodeLabel(g, g.currentId) === '4. Qxf7#', nodeLabel(g, g.currentId));
check('plyOffset', plyOffset(DEFAULT_POSITION) === 0 && plyOffset(FEN) === 6 && plyOffset('k7/8/8/8/8/8/8/K7 b - - 0 23') === 45);
const back = gameFromParsed(parsePgn(pgn));
check('PGN round trip', back.startFen === FEN && back.nodes[back.nodes.root.children[0]].san === 'Qxf7#');
check('standard game PGN has no FEN', !toPgn(s).includes('[FEN'));
// a set-up game from Black's side: the first move is numbered "1..."
const blackFen = 'k7/8/8/8/8/8/1q6/K7 b - - 0 1';
let b = gameReducer(initialGameState(), { type: 'NEW_GAME', startFen: blackFen });
b = gameReducer(b, { type: 'MAKE_MOVE', from: 'b2', to: 'b1' });
check('black to move PGN', /\b1\.\.\. Qb1\+/.test(toPgn(b)), toPgn(b));
check('black to move label', nodeLabel(b, b.currentId) === '1... Qb1+', nodeLabel(b, b.currentId));
{
  // "go to move 23" in a game set up at move 23 with Black to move (chessmind/commands.ts)
  const { parseCommand } = await import('../src/chessmind/commands.ts');
  let c = gameReducer(initialGameState(), { type: 'NEW_GAME', startFen: 'k7/8/8/8/8/8/1q6/K7 b - - 0 23' });
  c = gameReducer(c, { type: 'MAKE_MOVE', from: 'b2', to: 'b1' });
  c = gameReducer(c, { type: 'MAKE_MOVE', from: 'a1', to: 'b1' });
  c = gameReducer(c, { type: 'START' });
  const cmd = parseCommand('go to move 24', c, positionAt(c, c.currentId));
  const id = cmd?.actions[0]?.id;
  check('go to move from the FEN number', id && c.nodes[id].san === 'Kxb1', JSON.stringify(cmd));
  const early = parseCommand('go to move 3', c, positionAt(c, c.currentId));
  check('go to a move before the set-up start', early && early.actions.length === 0, JSON.stringify(early));
}
check('saved-game title of a set-up position', gameTitle(fresh).startsWith('Custom position'), gameTitle(fresh));
check('saved-game title of a standard game', gameTitle(s).startsWith('Analysis board'), gameTitle(s));

console.log(`${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
