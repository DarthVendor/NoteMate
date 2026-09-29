// Puzzle mode (src/chessmind/puzzle.ts, puzzleVerify.ts, puzzleRun.ts): the prompt builders against ChessMind's
// parity fixture (src/chessmind/fixtures/puzzle-prompts.json from scripts/puzzle_prompt_fixture.py: turns deep-equal and
// tokenizer-v4 chat prompt ids), move labels / SAN lines, goal parsing, the JS mate search, verification with a stub
// engine (correct / wrong / no line / mate-in-N alternatives / strict Lichess rule), the retry dialogue, hints, and the
// trainer set (public/puzzles/lichess.json).
// Usage: node scripts/test-puzzle.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Chess } from 'chess.js';

// The app's imports omit the .ts extension (Vite resolves them); resolve them the same way here.
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

const { ChessTokenizer } = await import('../src/chessmind/tokenizer.ts');
const P = await import('../src/chessmind/puzzle.ts');
const V = await import('../src/chessmind/puzzleVerify.ts');
const { modelSolve } = await import('../src/chessmind/puzzleRun.ts');

let fail = 0;
let total = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, ok, detail = '') => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};
const load = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const after = (fen, ...moves) => {
  const c = new Chess(fen);
  for (const m of moves) c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return c.fen();
};

// ------------------------------------------------------------------------------------------------ prompt parity
const fx = load('../src/chessmind/fixtures/puzzle-prompts.json');
const tv = load('../src/chessmind/fixtures/tokenizer-v4.json');
const tok = new ChessTokenizer(tv.chess_vocab, tv.bpe);
const specOf = (c) => ({ position: c.position, ...(c.setup ? { start: c.start, setup: c.setup } : {}), goal: c.goal ? { kind: c.goal.kind, ...(c.goal.n ? { n: c.goal.n } : {}) } : { kind: 'best' } });
for (const c of fx.cases) {
  const spec = specOf(c);
  const turns = P.puzzleDialogue(spec, c.tried ? [{ tried: c.tried, reply: c.reply }] : []);
  check(`${c.name} turns`, same(turns, c.turns), `\n  got  ${JSON.stringify(turns)}\n  want ${JSON.stringify(c.turns)}`);
  const ids = tok.chatPrompt(turns);
  check(`${c.name} chat prompt ids`, same(ids, c.ids), `${ids.length} vs ${c.ids.length} ids`);
  check(`${c.name} fixture turns -> ids`, same(tok.chatPrompt(c.turns), c.ids));
  if (!c.tried) check(`${c.name} question turn`, same(P.questionTurn(spec), c.turns[0]));
}
check('fixture has 21 cases', fx.cases.length === 21, String(fx.cases.length));
const parity = total;

// ------------------------------------------------------------------------------------------------ labels, goals
const MATE2 = 'r1bq3r/pp1nbkp1/2p1p2p/8/2BP4/1PN3P1/P3QP1P/3R1RK1 w - - 0 20';
const MATE2_START = 'r1bqk2r/pp1nbNp1/2p1p2p/8/2BP4/1PN3P1/P3QP1P/3R1RK1 b kq - 0 19';
const MATE1B = '1qr2rk1/1p1p1ppp/pB2p1n1/7n/2P1P3/1Q2NP1P/PP2BKPb/3R1R2 b - - 2 20';
const QUEEN = '6k1/5p1p/4p3/4q3/3n4/2Q3P1/PP1N1P1P/6K1 b - - 3 37';
check('label white', P.moveLabel(MATE2, 'c4e6') === '20.Bxe6+', P.moveLabel(MATE2, 'c4e6'));
check('label black', P.moveLabel(QUEEN, 'd4f3') === '37...Nf3+', P.moveLabel(QUEEN, 'd4f3'));
check('san line white first', P.sanLine(MATE2, ['c4e6', 'f7f8']) === '20.Bxe6+ Kf8', P.sanLine(MATE2, ['c4e6', 'f7f8']));
check('san line black first', P.sanLine(QUEEN, ['d4f3', 'g1f1']) === '37...Nf3+ 38.Kf1', P.sanLine(QUEEN, ['d4f3', 'g1f1']));
check('retry without reply', P.retryTurns(QUEEN, 'd4f3', null)[1].parts[0].text === "37...Nf3+? That doesn't work.");
check('goal text mate 1', P.goalText({ kind: 'mate', n: 1 }, 'Black') === 'Black has a forced mate in 1. Find it.');
const goals = { '': null, 'mate 3': { kind: 'mate', n: 3 }, 'mate in 2': { kind: 'mate', n: 2 }, m1: { kind: 'mate', n: 1 }, mate: { kind: 'mate', n: 1 }, 'win queen': { kind: 'queen' }, 'win the queen': { kind: 'queen' }, piece: { kind: 'piece' }, 'win material': { kind: 'material' }, win: { kind: 'win' }, draw: { kind: 'hold' }, hold: { kind: 'hold' }, best: { kind: 'best' }, 'mate 12': { kind: 'mate', n: 8 }, banana: undefined };
for (const [t, want] of Object.entries(goals)) check(`parseGoal ${JSON.stringify(t)}`, same(P.parseGoal(t), want), JSON.stringify(P.parseGoal(t)));
check('themes mateIn2', same(P.goalFromThemes(['mateIn2', 'short'], ['a', 'b', 'c', 'd']), { kind: 'mate', n: 2 }));
check('themes mateIn3 vs a 2-move solution', same(P.goalFromThemes(['mateIn3'], ['a', 'b', 'c', 'd']), { kind: 'mate', n: 2 }));
check('themes crushing', same(P.goalFromThemes(['crushing', 'fork'], ['a', 'b']), { kind: 'win' }));
check('themes advantage', same(P.goalFromThemes(['advantage'], ['a', 'b']), { kind: 'win' }));
check('themes equality', same(P.goalFromThemes(['equality', 'endgame'], ['a', 'b']), { kind: 'hold' }));
check('themes none', same(P.goalFromThemes(['opening'], ['a', 'b']), { kind: 'best' }));

// goals typed in the chat (ChessMindPanel -> usePuzzle.askGoal)
const detect = {
  'White has checkmate in 2': { kind: 'mate', n: 2 },
  'Black mates in three.': { kind: 'mate', n: 3 },
  'mate in 1 here': { kind: 'mate', n: 1 },
  'M2 for white': { kind: 'mate', n: 2 },
  'Find #3': { kind: 'mate', n: 3 },
  'Find the mate': { kind: 'mate' },
  'White to play and mate': { kind: 'mate' },
  "There's a forced mate": { kind: 'mate' },
  'Black to play and win': { kind: 'win' },
  'Find the winning move': { kind: 'win' },
  'White wins the queen': { kind: 'queen' },
  'How does Black win a piece?': { kind: 'piece' },
  'White can win material': { kind: 'material' },
  'win the exchange': { kind: 'material' },
  'White to move and draw': { kind: 'hold' },
  'Can Black hold the draw?': { kind: 'hold' },
  "what's the plan here?": null,
  'is mate possible later?': null,
  'Show me the Najdorf': null,
  'What should I play?': null,
  'Review this game': null,
  'the knight on e5 is strong': null,
  'Why is my position bad?': null,
};
for (const [t, want] of Object.entries(detect)) check(`detectGoal ${JSON.stringify(t)}`, same(P.detectGoal(t), want), JSON.stringify(P.detectGoal(t)));
{
  const c = fx.cases.find((x) => x.name === 'mate2/last_move');
  const g = P.goalTurn('White has checkmate in 2', specOf(c));
  check('goal turn: the user text, then the fixture layout', g.parts[0].text === 'White has checkmate in 2' && same(g.parts.slice(1), c.turns[0].parts.slice(1)));
  const snap = fx.cases.find((x) => x.name === 'mate2/snapshot');
  check('goal turn: snapshot form', same(P.goalTurn(' Find it ', specOf(snap)).parts.slice(1), snap.turns[0].parts.slice(1)));
}

// ------------------------------------------------------------------------------------------------ the answer line
const lastMoveSpec = { position: MATE2, start: MATE2_START, setup: 'e8f7', goal: { kind: 'mate', n: 2 } };
const start = P.dialogueStart([P.questionTurn(lastMoveSpec)]);
check('dialogue start is the snapshot before the last move', start === MATE2_START);
const think = { kind: 'think', parts: [{ kind: 'text', text: 'Bishop?' }, { kind: 'fen', fen: MATE2 }, { kind: 'line', moves: ['c4e6'] }, { kind: 'line', moves: ['e2e6', 'f7f8'] }] };
check('answer line after a snapshot', same(P.answerLine([think, { kind: 'fen', fen: MATE2 }, { kind: 'line', moves: ['e2e6', 'f7f8', 'e6f7'] }, { kind: 'text', text: 'Mate in 2.' }], lastMoveSpec, start), { moves: ['e2e6', 'f7f8', 'e6f7'], where: 'answer' }));
check('answer line through the setup move', same(P.answerLine([{ kind: 'line', moves: ['e8f7', 'e2e6'] }], lastMoveSpec, start)?.moves, ['e2e6']));
check("think's last line as fallback", same(P.answerLine([think, { kind: 'text', text: 'No idea.' }], lastMoveSpec, start), { moves: ['e2e6', 'f7f8'], where: 'think' }));
check('no line', P.answerLine([{ kind: 'text', text: 'Hmm.' }], lastMoveSpec, start) === null);
check('illegal line ignored', P.answerLine([{ kind: 'fen', fen: MATE2 }, { kind: 'line', moves: ['e7e5'] }], lastMoveSpec, start) === null);

// ------------------------------------------------------------------------------------------------ JS mate search
let t0 = performance.now();
const m1 = V.findMates(MATE1B, 1);
check('mate in 1 (black): b8g3', same(m1, ['b8g3']), JSON.stringify(m1));
const m2 = V.findMates(MATE2, 2);
check('mate in 2: e2e6 among the mates', !!m2 && m2.includes('e2e6'), JSON.stringify(m2));
check('mate in 2: no mate in 1', V.attackerMates(new Chess(MATE2), 1, { nodes: 1e5 }) === false);
check('after Qxe6+ the defender is mated in 1', V.defenderLoses(new Chess(after(MATE2, 'e2e6')), 1, { nodes: 1e5 }) === true);
check('after Bxe6+ no forced mate in 1', V.defenderLoses(new Chess(after(MATE2, 'c4e6')), 1, { nodes: 1e5 }) === false);
check('budget runs out -> null', V.attackerMates(new Chess(MATE2), 3, { nodes: 5 }) === null);
const searchMs = performance.now() - t0;

// ------------------------------------------------------------------------------------------------ verification (stub engine)
/** A stub engine: results by position (placement + side); unknown positions = no result. */
const stub = (table) => ({
  calls: 0,
  async analyse(fen) {
    this.calls++;
    const k = fen.split(' ').slice(0, 2).join(' ');
    return table[k] ?? null;
  },
});
const K = (fen) => fen.split(' ').slice(0, 2).join(' ');
const mateEngine = stub({
  [K(after(MATE2, 'e2e6'))]: { move: 'f7f8', mate: -1, pv: ['f7f8', 'e6f7'] },
  [K(after(MATE2, 'd1d3'))]: { move: 'd7f6', mate: -1, pv: ['d7f6', 'd3h7'] }, // a stubbed alternative mate
  [K(after(MATE2, 'c4e6'))]: { move: 'f7f8', cp: -250, pv: ['f7f8', 'e6c8', 'd8c8'] },
  [K(after(MATE2, 'f1e1'))]: { move: 'd7f6', mate: -4, pv: ['d7f6'] },
});
const goal2 = { kind: 'mate', n: 2 };
let v = await V.verifyMove({ fen: MATE2, goal: goal2 }, 'e2e6', new V.EvalCache(mateEngine));
check('mate: correct first move', v.ok === true && v.reply === 'f7f8', JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: goal2 }, 'd1d3', new V.EvalCache(mateEngine));
check('mate: another first move that mates in time', v.ok === true, JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: goal2 }, 'c4e6', new V.EvalCache(mateEngine));
check('mate: wrong move refuted', v.ok === false && v.reply === 'f7f8' && /20\.Bxe6\+ Kf8 there's no mate/.test(v.reason) && same(v.line, ['c4e6', 'f7f8', 'e6c8', 'd8c8']), JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: goal2 }, 'f1e1', new V.EvalCache(mateEngine));
check('mate: a slower mate is wrong', v.ok === false && /4 more moves/.test(v.reason), v.reason);
v = await V.verifyMove({ fen: MATE1B, goal: { kind: 'mate', n: 1 } }, 'b8g3', new V.EvalCache(null));
check('mate in 1: the mating move, no engine', v.ok === true && v.mates === true, JSON.stringify(v));
v = await V.verifyMove({ fen: MATE1B, goal: { kind: 'mate', n: 1 } }, 'h2g3', new V.EvalCache(null));
check('mate in 1: a non-mating move', v.ok === false, JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: goal2 }, 'e2e6', new V.EvalCache(null));
check('mate: correct via the JS search', v.ok === true, JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: goal2 }, 'c4e6', new V.EvalCache(null));
check('mate: wrong via the JS search, with an escape', v.ok === false && !!v.reply && /no mate/.test(v.reason), JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: goal2 }, 'e7e5', new V.EvalCache(null));
check('illegal move', v.ok === false && /not a legal move/.test(v.reason));
v = await V.verifyMove({ fen: MATE2, goal: { kind: 'mate' } }, 'f1e1', new V.EvalCache(mateEngine));
check('any mate (no N): a slower forced mate counts', v.ok === true, JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: { kind: 'mate' } }, 'c4e6', new V.EvalCache(mateEngine));
check('any mate (no N): no mate is wrong', v.ok === false, JSON.stringify(v));
v = await V.verifyMove({ fen: MATE2, goal: { kind: 'mate' } }, 'e2e6', new V.EvalCache(null));
check('any mate (no N): the JS search', v.ok === true, JSON.stringify(v));
const lineV = await V.verifyMateLine(MATE2, 2, ['e2e6', 'f7f8', 'e6f7'], new V.EvalCache(mateEngine));
check('mate line: ends in mate', lineV.ok === true, JSON.stringify(lineV));
const lineBad = await V.verifyMateLine(MATE2, 2, ['e2e6', 'f7f8', 'e6e7'], new V.EvalCache(mateEngine));
check('mate line: stops short', lineBad.ok === false, JSON.stringify(lineBad));

// eval goals: the stub gives the side to move's view
const evalEngine = stub({
  [K(QUEEN)]: { move: 'd4f3', cp: 900, pv: ['d4f3', 'd2f3', 'e5c3'] },
  [K(after(QUEEN, 'd4f3'))]: { move: 'd2f3', cp: -880, pv: ['d2f3', 'e5c3'] },
  [K(after(QUEEN, 'd4e2'))]: { move: 'g1f1', cp: -40, pv: ['g1f1', 'e2c3'] },
  [K(after(QUEEN, 'h7h5'))]: { move: 'c3e5', cp: 950, pv: ['c3e5'] },
  [K(after(QUEEN, 'f7f5'))]: { move: 'c3e5', mate: 2, pv: ['c3e5'] },
});
const q = async (kind, move, extra = {}) => V.verifyMove({ fen: QUEEN, goal: { kind }, ...extra }, move, new V.EvalCache(evalEngine));
check('win queen: the winning move', (await q('queen', 'd4f3')).ok === true);
v = await q('queen', 'd4e2');
check('win queen: a quiet move is refuted', v.ok === false && v.reply === 'g1f1' && /37\.\.\.Ne2\+? 38\.Kf1/.test(v.reason), JSON.stringify(v));
check('win: +8.8 wins', (await q('win', 'd4f3')).ok === true);
check('hold: +0.4 holds', (await q('hold', 'd4e2')).ok === true);
check('hold: -9.5 loses', (await q('hold', 'h7h5')).ok === false);
check('hold: getting mated loses', (await q('hold', 'f7f5')).ok === false);
check('best: the best move', (await q('best', 'd4f3')).ok === true);
check('best: 8 pawns worse', (await q('best', 'd4e2')).ok === false);
check('known solution counts without an engine', (await V.verifyMove({ fen: QUEEN, goal: { kind: 'queen' }, known: 'd4f3' }, 'd4f3', new V.EvalCache(null))).ok === true);
check('no engine, no known: unverified', (await V.verifyMove({ fen: QUEEN, goal: { kind: 'queen' } }, 'd4e2', new V.EvalCache(null))).ok === null);
// strict (the trainer's user moves): only the solution, or a mating move
check('strict: not the solution', (await V.verifyMove({ fen: QUEEN, goal: { kind: 'win' }, known: 'd4f3', strict: true }, 'd4e2', new V.EvalCache(evalEngine))).ok === false);
check('strict: the solution', (await V.verifyMove({ fen: QUEEN, goal: { kind: 'win' }, known: 'd4f3', strict: true }, 'd4f3', new V.EvalCache(null))).ok === true);
check('strict: another mating move counts', (await V.verifyMove({ fen: MATE1B, goal: { kind: 'mate', n: 1 }, known: 'b8b7', strict: true }, 'b8g3', new V.EvalCache(null))).ok === true);
check('strict mate: an alternative first move does not', (await V.verifyMove({ fen: MATE2, goal: goal2, known: 'e2e6', strict: true }, 'd1d3', new V.EvalCache(mateEngine))).ok === false);
const cached = stub({ [K(after(MATE2, 'e2e6'))]: { move: 'f7f8', mate: -1, pv: ['f7f8'] } });
const cache = new V.EvalCache(cached);
await V.verifyMove({ fen: MATE2, goal: goal2 }, 'e2e6', cache);
await V.verifyMove({ fen: MATE2, goal: goal2 }, 'e2e6', cache);
check('engine results are cached per position', cached.calls === 1, String(cached.calls));
check('score of mates', V.scoreOf({ mate: 3, pv: [] }) === V.MATE_SCORE - 3 && V.scoreOf({ mate: -2, pv: [] }) === -V.MATE_SCORE + 2 && V.scoreOf({ mate: 0, pv: [] }) === -V.MATE_SCORE);

// ------------------------------------------------------------------------------------------------ attempts (stub model)
{
  const asks = [];
  const answers = [
    [{ kind: 'think', parts: [{ kind: 'text', text: 'Check first.' }] }, { kind: 'fen', fen: MATE2 }, { kind: 'line', moves: ['c4e6', 'f7f8'] }, { kind: 'text', text: 'Bishop check.' }],
    [{ kind: 'text', text: 'Hmm, not sure.' }],
    [{ kind: 'fen', fen: MATE2 }, { kind: 'line', moves: ['e2e6', 'f7f8', 'e6f7'] }, { kind: 'text', text: 'Mate in 2.' }],
  ];
  const res = await modelSolve(lastMoveSpec, { attempts: 3, evals: new V.EvalCache(mateEngine), ask: async (req) => (asks.push(req), { parts: answers[asks.length - 1] }) });
  check('attempts: solved on the third try', res.solved === true && res.attempts.length === 3, JSON.stringify(res.attempts.map((a) => [a.line, a.verdict?.ok, a.reason])));
  check('attempts: wrong, no line, right', res.attempts[0].verdict?.ok === false && res.attempts[1].reason === 'No move given' && res.attempts[2].verdict?.ok === true && res.attempts[2].lineOk === true);
  const retry = fx.cases.find((c) => c.name === 'mate2/retry');
  check('attempts: the retry dialogue is the fixture layout', same([...asks[1].history, { role: 'user', parts: asks[1].parts }], retry.turns), JSON.stringify(asks[1].history));
  check('attempts: the retry label is the refutation', asks[1].label === "That doesn't work: 20.Bxe6+ Kf8.", asks[1].label);
  check('attempts: first ask is the question', same(asks[0].history, []) && same(asks[0].parts, fx.cases.find((c) => c.name === 'mate2/last_move').turns[0].parts));
  const res2 = await modelSolve(lastMoveSpec, { attempts: 2, evals: new V.EvalCache(mateEngine), ask: async () => ({ parts: answers[0] }) });
  check('attempts: out of tries', res2.solved === false && res2.attempts.length === 2);
  const res3 = await modelSolve(lastMoveSpec, { attempts: 3, retries: false, evals: new V.EvalCache(mateEngine), ask: async () => ({ parts: answers[1] }) });
  check('attempts: explain mode asks once', res3.attempts.length === 1 && res3.solved === false);
}

// ------------------------------------------------------------------------------------------------ hints
check('hint 1: the piece', P.hintText(MATE2, 'e2e6', 1) === 'Look at your queen on e2.', P.hintText(MATE2, 'e2e6', 1));
check('hint 2: where it goes', P.hintText(MATE2, 'e2e6', 2) === 'The queen on e2 takes on e6 with check.', P.hintText(MATE2, 'e2e6', 2));
check('hint 1: black knight', P.hintText(QUEEN, 'd4f3', 1) === 'Look at your knight on d4.');
const hm = await V.bestMoveAt(MATE1B, { kind: 'mate', n: 1 }, new V.EvalCache(null));
check('hint move for a mate without the engine: the search', hm.move === 'b8g3', JSON.stringify(hm));
check('hint move: the known solution first', (await V.bestMoveAt(MATE2, goal2, new V.EvalCache(null), 'e2e6')).move === 'e2e6');

// ------------------------------------------------------------------------------------------------ trainer set
const url = new URL('../public/puzzles/lichess.json', import.meta.url);
const bytes = statSync(url).size;
const doc = load('../public/puzzles/lichess.json');
check('trainer: under 400 KB', bytes < 400 * 1024, `${bytes} bytes`);
check('trainer: attribution', /Lichess puzzle database, CC0/.test(doc.source), doc.source);
check('trainer: fields', same(doc.fields, ['id', 'fen', 'moves', 'rating', 'themes', 'heldout']));
const set = P.parseTrainerSet(doc);
check('trainer: ~2000 puzzles', set.puzzles.length >= 1500 && set.puzzles.length <= 2500, String(set.puzzles.length));
let bad = null;
let heldout = 0;
for (const p of set.puzzles) {
  heldout += p.heldout ? 1 : 0;
  if (typeof p.id !== 'string' || !p.id || !Number.isFinite(p.rating) || !p.themes.length || typeof p.heldout !== 'boolean' || p.moves.length < 2) {
    bad = `${p.id}: fields`;
    break;
  }
  try {
    after(p.fen, ...p.moves);
  } catch {
    bad = `${p.id}: illegal moves`;
    break;
  }
}
check('trainer: every row valid (fields, legal moves)', bad === null, bad ?? '');
check('trainer: some held-out puzzles', heldout > 0, String(heldout));
// solving a trainer puzzle myself: the solution moves pass the strict check, mates end in mate
let solveBad = null;
for (const p of set.puzzles.slice(0, 80)) {
  const spec = P.trainerSpec(p);
  let fen = spec.position;
  for (let i = 0; i < spec.solution.length; i += 2) {
    const r = await V.verifyMove({ fen, goal: spec.goal, known: spec.solution[i], strict: true }, spec.solution[i], new V.EvalCache(null));
    if (r.ok !== true) {
      solveBad = `${p.id} step ${i}`;
      break;
    }
    fen = after(fen, ...spec.solution.slice(i, i + 2));
  }
  if (spec.goal.kind === 'mate' && !new Chess(after(spec.position, ...spec.solution)).isCheckmate()) solveBad = `${p.id}: mate goal without mate`;
  if (solveBad) break;
}
check('trainer: solution moves pass the strict check', solveBad === null, solveBad ?? '');
const mateIn1 = set.puzzles.find((p) => p.themes.includes('mateIn1'));
if (mateIn1) {
  const spec = P.trainerSpec(mateIn1);
  check('trainer: mateIn1 goal', same(spec.goal, { kind: 'mate', n: 1 }) && spec.setup === mateIn1.moves[0] && spec.start === new Chess(mateIn1.fen).fen());
  check('trainer: mateIn1 question layout', same(P.questionTurn(spec).parts.map((x) => x.kind), ['text', 'fen', 'line', 'text']));
}
check('trainer: filter by theme + band', P.filterPuzzles(set.puzzles, 'fork', '1400').every((p) => p.themes.includes('fork') && p.rating >= 1400 && p.rating < 1800));

console.log(`${parity} prompt-parity checks (${fx.cases.length} fixture cases), mate search ${searchMs.toFixed(0)} ms; ${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
