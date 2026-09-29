// Parity tests of ChessMind's task markers in the browser port against Python (src/chessmind/fixtures/tasks.json, from
// ChessMind's scripts/tasks_fixture.py): the marker token ids (append-only extras 18-19, added on load to an 8-extra
// tokenizer file), the regex sources tasks.ts copies, questionIntent / taskOfQuestion on sampled real questions, chat
// prompts with a marker (plain and role format: ids and pod board rows), and that no generation mask ever allows a
// marker (constraint.ts).
// Usage: node scripts/test-tasks.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync } from 'node:fs';
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

const { ChessTokenizer, TASK_TOKENS } = await import('../src/chessmind/tokenizer.ts');
const { BoardTracker, dialogueSnapshotFens } = await import('../src/chessmind/boards.ts');
const { LineConstraint } = await import('../src/chessmind/constraint.ts');
const { promptTurns } = await import('../src/chessmind/roles.ts');
const T = await import('../src/chessmind/tasks.ts');

const read = (f) => JSON.parse(readFileSync(new URL(`../src/chessmind/fixtures/${f}`, import.meta.url), 'utf8'));
const tv = read('tokenizer-v4.json');
const fx = read('tasks.json');
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
const trunc = (x) => JSON.stringify(x).slice(0, 300);
const clean = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- tokens
const t = new ChessTokenizer(tv.chess_vocab, tv.bpe);
check('task tokens appended on load', t.supportsTasks && same(Object.fromEntries(TASK_TOKENS.map((n) => [n, t.id(n)])), fx.tokenIds), trunc(fx.tokenIds));
check('markers are prompt-only', Object.values(t.taskIds).every((i) => t.promptOnlyIds.includes(i)));

// ---------------------------------------------------------------- the copied regex sources
const p = fx.patterns;
check('intent sources', same(T.INTENT_SOURCES, p.intents));
check('chess words / SAN', T.CHESS_WORDS_SOURCE === p.chessWords && T.SAN_SOURCE === p.san);
check('explain / judge / find', T.EXPLAIN_SOURCE === p.explain && T.JUDGE_SOURCE === p.judge && T.FIND_SOURCE === p.find);
check('not-explain intents', same(T.NOT_EXPLAIN, p.notExplain));

// ---------------------------------------------------------------- classification
for (const { q, intent, task } of fx.questions) {
  check(`intent ${JSON.stringify(q).slice(0, 60)}`, T.questionIntent(q) === intent, `${T.questionIntent(q)} vs ${intent}`);
  check(`task ${JSON.stringify(q).slice(0, 60)}`, T.taskOfQuestion(q) === task, `${T.taskOfQuestion(q)} vs ${task}`);
}

// ---------------------------------------------------------------- prompts
const CTX = '[Position: move 3, Black to play] [Engine: Stockfish, depth 18 | eval +0.3 | best 3...a6]';
for (const c of fx.prompts) {
  const built = clean(T.withTask(c.roles ? promptTurns(c.turns, CTX, { mode: 'coach' }) : c.turns, c.task));
  check(`prompt ${c.name} turns`, same(built, c.built), `${trunc(built)} vs ${trunc(c.built)}`);
  const ids = t.chatPrompt(built);
  check(`prompt ${c.name} ids`, same(ids, c.ids), `${ids.length} vs ${c.ids.length}`);
  const rows = new BoardTracker(t, undefined, { sync: 'pod', snapshotFens: dialogueSnapshotFens(built.filter((x) => x.role !== 'system')) }).rows(ids);
  const bad = rows.findIndex((r, i) => !same(Array.from(r), c.rows[i]));
  check(`prompt ${c.name} rows`, bad < 0, `first mismatch at ${bad}`);
}

// ---------------------------------------------------------------- generation never writes a marker
const markers = Object.values(t.taskIds);
for (const plan of [false, true]) {
  const c = new LineConstraint(t, undefined, [], null, 40, undefined, plan);
  const seq = [t.thinkId, ...t.encodeText('so'), t.endThinkId, ...t.encodeText('ok'), t.lineId, t.moveToId('e2e4'), t.endLineId];
  let leaked = false;
  for (let i = 0; i <= seq.length; i++) if (c.allowed(seq.slice(0, i)).some((id) => markers.includes(id))) leaked = true;
  check(`constraint (plan ${plan}) never allows a marker`, !leaked);
}

console.log(`${total - fail}/${total} task checks passed`);
process.exit(fail ? 1 : 0);
