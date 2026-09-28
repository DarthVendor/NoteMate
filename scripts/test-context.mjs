// Parity tests of the ChessMind prompt context (src/chessmind/promptContext.ts: position note, engine and candidates
// blocks) and the board-claim checker (src/chessmind/claims.ts) against ChessMind's Python fixtures
// (src/chessmind/fixtures/prompt_context.json and claims.json, from ChessMind's scripts/context_fixtures.py), plus the
// chat glue (src/chessmind/chatContext.ts: which context goes with a question, which answer sentences get marked).
// Usage: node scripts/test-context.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

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

const { contextText, parseContext, formatEval } = await import('../src/chessmind/promptContext.ts');

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
const load = (f) => JSON.parse(readFileSync(new URL(`../src/chessmind/fixtures/${f}`, import.meta.url), 'utf8'));

// ------------------------------------------------------------------------------------------------ prompt context
const pc = load('prompt_context.json');
pc.cases.forEach((c, i) => {
  const engine = c.engine ? { depth: c.engine.depth, lines: c.engine.lines.map((l) => ({ move: l.move, cp: l.cp, mate: l.mate, pv: l.pv })) } : null;
  const text = contextText(c.fen, { engine, candidates: c.candidates, numbers: c.numbers, showBest: c.show_best });
  check(`context ${i} text`, text === c.text, `\n  got  ${text}\n  want ${c.text}`);
  const parsed = parseContext(c.text);
  check(`context ${i} parse`, same(parsed, c.parsed), `\n  got  ${JSON.stringify(parsed)}\n  want ${JSON.stringify(c.parsed)}`);
});
for (const [cp, mate, want] of [[25, null, '+0.2'], [-25, null, '-0.2'], [75, null, '+0.8'], [4, null, '0.0'], [-5, null, '-0.1'], [37, null, '+0.4'], [null, 3, '#3'], [null, -2, '#-2'], [1234, null, '+12.3']])
  check(`formatEval ${cp} ${mate}`, formatEval(cp, mate) === want, formatEval(cp, mate));

// ------------------------------------------------------------------------------------------------ claims
const { Board, extractClaims, verify, evalCitations } = await import('../src/chessmind/claims.ts');
const sideName = (s) => (s === null ? null : s ? 'white' : 'black');
const cl = load('claims.json');
cl.cases.forEach((c, i) => {
  const root = new Board(c.fen);
  const others = c.others.map((f) => new Board(f));
  const got = extractClaims(c.text).map((k) => ({ kind: k.kind, text: k.text, side: sideName(k.side), verdict: verify(k, root, others).verdict }));
  check(`claims ${i}`, same(got, c.claims), `${c.text}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(c.claims)}`);
  const ev = evalCitations(c.text);
  check(`evals ${i}`, same(ev, c.evals), `${c.text}\n  got  ${JSON.stringify(ev)}\n  want ${JSON.stringify(c.evals)}`);
});

// ------------------------------------------------------------------------------------------------ unit cases
const B = (fen) => new Board(fen);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const verdicts = (text, fen, others = []) => extractClaims(text).map((k) => `${k.kind}:${verify(k, B(fen), others.map(B)).verdict}`);
// The user's report: Black has no doubled pawns here
check('doubled f-file false', same(verdicts('Black has doubled pawns on the f-file.', START), ['doubled:false']));
check('doubled true', same(verdicts('Black has doubled pawns on the f-file.', 'rnbqkb1r/pppppppp/5p2/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), ['doubled:true']));
check('nothing hanging true', same(verdicts("Nothing of White's is hanging.", START), ['hanging:true']));
check('modal skipped', same(verdicts('If Black plays f6, Black would have doubled pawns on the f-file.', START), []));
// pinned knight: attacked by a pawn... the e5 pawn is attacked by the Nf3? Nc6 pinned by Bb5 does not defend e5
const pin = 'r1bqk1nr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
check('pinned defender', same(verdicts('The pawn on e5 is hanging.', 'r1bqk1nr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'), ['piece_on:true', 'hanging:false']), JSON.stringify(verdicts('The pawn on e5 is hanging.', pin)));
check('shifted along a line', same(verdicts('White is up a pawn.', START, ['rnbqkbnr/ppp1pppp/8/3P4/8/8/PPP1PPPP/RNBQKBNR b KQkq - 0 2']), ['material:shifted']));
check('eval citations', same(evalCitations('Evaluation: +0.4. It is 1.3 for White, or #-2 after Qh5.'), ['Evaluation: +0.4', '1.3 for White', '#-2']), JSON.stringify(evalCitations('Evaluation: +0.4. It is 1.3 for White, or #-2 after Qh5.')));
check('no eval in move numbers', same(evalCitations('After 12.Nf3 Nc6 13.d4 White is better.'), []));

// ------------------------------------------------------------------------------------------------ chat glue
const { engineInfoFor, chatContext, contextLabel, markText, messageMarks, questionFen, NO_ENGINE_NOTE } = await import('../src/chessmind/chatContext.ts');
const fen12 = 'r1bq1rk1/5ppp/p1np1b2/1p1Np3/4P3/N1P5/PP3PPP/R2QKB1R w KQ - 1 12';
const lines = [
  { multipv: 2, depth: 19, cp: -12, pv: ['d5c7'] },
  { multipv: 1, depth: 20, cp: 37, pv: ['d5e7', 'g8h8'] },
];
const info = engineInfoFor(fen12, { fen: fen12, lines, name: 'Stockfish 19 Lite' });
check('engine info', info && info.depth === 20 && info.lines[0].move === 'd5e7' && info.lines[0].cp === 37 && info.name === 'Stockfish', JSON.stringify(info));
check('engine other position', engineInfoFor(fen12, { fen: START, lines, name: 'Stockfish' }) === null);
check('engine move counters ignored', engineInfoFor(fen12, { fen: fen12.replace(/1 12$/, '0 30'), lines }) !== null);
check('engine too shallow', engineInfoFor(fen12, { fen: fen12, lines: [{ multipv: 1, depth: 6, cp: 30, pv: ['d5e7'] }] }) === null);
const blackFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const bInfo = engineInfoFor(blackFen, { fen: blackFen, lines: [{ multipv: 1, depth: 20, cp: -30, pv: ['c7c5', 'g1f3'] }, { multipv: 2, depth: 20, mate: 3, pv: ['e7e5'] }] });
check('black to move: White view', bInfo.lines[0].cp === 30 && bInfo.lines[1].mate === -3, JSON.stringify(bInfo));
const ctxE = chatContext({ fen: blackFen, engine: bInfo, candidates: [{ uci: 'e7e5', p: 0.6 }], sendEngine: true, sendCandidates: true });
check('context with engine', ctxE === '[Position: move 1, Black to play] [Engine: Stockfish, depth 20 | eval +0.3 | best 1...c5 | line 1...c5 2.Nf3 | also 1...e5 #-3]', ctxE);
const ctxC = chatContext({ fen: blackFen, engine: null, candidates: [{ uci: 'e7e5', p: 0.6 }, { uci: 'c7c5', p: 0.3 }], sendEngine: true, sendCandidates: true });
check('context with candidates', ctxC === '[Position: move 1, Black to play] [Candidates: 1...e5 60%, 1...c5 30%]', ctxC);
check('context engine off -> candidates', chatContext({ fen: blackFen, engine: bInfo, candidates: [{ uci: 'e7e5', p: 1 }], sendEngine: false, sendCandidates: true }).includes('[Candidates: 1...e5 100%]'));
check('context note only', chatContext({ fen: blackFen, engine: null, candidates: null, sendEngine: true, sendCandidates: false }) === '[Position: move 1, Black to play]');
check('label engine', contextLabel(ctxE) === 'engine +0.3 · d20', contextLabel(ctxE));
check('label candidates', contextLabel(ctxC) === 'candidates e5 60%', contextLabel(ctxC));
check('question fen from moves', questionFen({ context: ['e2e4'] }) === blackFen);

// markers: offsets map back through odd whitespace; the sentence is marked, not changed
const text = 'Good move.  Black has doubled pawns\non the f-file. Evaluation: +0.4';
const segs = markText(text, B(START), [], true);
check('markText keeps text', segs.map((s) => s.text).join('') === text);
const bad = segs.find((s) => s.claim);
check('markText marks the sentence', bad && bad.text === 'Black has doubled pawns\non the f-file.' && /Black has no doubled pawns/.test(bad.claim), JSON.stringify(segs));
check('markText marks the eval', segs.some((s) => s.evalNote === NO_ENGINE_NOTE && s.text === 'Evaluation: +0.4'), JSON.stringify(segs));
check('markText no eval flag with engine', !markText(text, B(START), [], false).some((s) => s.evalNote));
// messages: eval flagged without an engine block in the question, not with one; lines in the answer shift claims
const user = (contextText) => ({ id: 'u', role: 'user', kind: 'model', parts: [{ kind: 'text', text: 'Plan?' }], context: [], contextText });
const answer = { id: 'a', role: 'assistant', kind: 'model', done: true, parts: [{ kind: 'text', text: 'Evaluation: +0.4. White is up a pawn.' }, { kind: 'line', moves: ['e2e4', 'd7d5', 'e4d5'] }] };
const noEngine = messageMarks(answer, user('[Position: move 1, White to play] [Candidates: 1.e4 50%]'));
check('eval flagged without engine', noEngine.count === 1 && noEngine.answer.get(0).some((s) => s.evalNote), JSON.stringify([...noEngine.answer]));
const withEngine = messageMarks(answer, user('[Position: move 1, White to play] [Engine: Stockfish, depth 20 | eval +0.4 | best 1.e4]'));
check('eval not flagged with engine', withEngine.count === 0, JSON.stringify([...withEngine.answer]));
const falseAnswer = { ...answer, parts: [{ kind: 'text', text: 'Black is up a pawn.' }, { kind: 'line', moves: ['e2e4', 'd7d5', 'e4d5'] }] };
check('false claim marked', messageMarks(falseAnswer, user()).count === 1);
const thinkAnswer = { ...answer, parts: [{ kind: 'think', parts: [{ kind: 'text', text: 'Black has the bishop pair? No. White is in check.' }] }, { kind: 'text', text: 'Play e4.' }] };
const tm = messageMarks(thinkAnswer, user('[Position: move 1, White to play]'));
check('think marked', tm.think.has(0) && !tm.answer.size, JSON.stringify([...tm.think]));

console.log(`${total - fail}/${total} passed`);
if (fail) process.exit(1);
