// Parity tests of ChessMind's prompt roles in the browser port against Python (src/chessmind/fixtures/roles.json, from
// ChessMind's scripts/roles_fixture.py): the role tokens (append-only extras 11-17, added on load to an 8-extra
// tokenizer file), role-format dialogues (encode, pod board rows, decode with the think's plan), the role prompt
// builder (roles.ts promptTurns / toRoles, chat prompt ids), the plan rules of LineConstraint (constraint.ts) and
// carryPlans.
// Usage: node scripts/test-roles.mjs   (Node >= 23: imports the TypeScript sources directly)
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

const { ChessTokenizer, ROLE_TOKENS } = await import('../src/chessmind/tokenizer.ts');
const { BoardTracker, dialogueSnapshotFens } = await import('../src/chessmind/boards.ts');
const { LineConstraint } = await import('../src/chessmind/constraint.ts');
const { carryPlans, promptTurns, toRoles } = await import('../src/chessmind/roles.ts');

const read = (f) => JSON.parse(readFileSync(new URL(`../src/chessmind/fixtures/${f}`, import.meta.url), 'utf8'));
const tv = read('tokenizer-v4.json');
const fx = read('roles.json');
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
const trunc = (x) => JSON.stringify(x).slice(0, 400);
const clean = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- tokens
check('the v4 fixture lists 8 extras', tv.chess_vocab.extra_special.length === 8);
const t = new ChessTokenizer(tv.chess_vocab, tv.bpe);
check('role tokens appended on load', t.supportsRoles && same(Object.fromEntries(ROLE_TOKENS.map((n) => [n, t.id(n)])), fx.tokenIds), trunc(fx.tokenIds));
check('prompt-only ids', same([...t.promptOnlyIds].sort(), [t.systemId, t.contextId, t.endContextId, t.goalId, t.endGoalId].sort()));

// ---------------------------------------------------------------- dialogues
for (const d of fx.dialogues) {
  const ids = [t.eosId, ...t.encodeDialogue(d.turns), t.eosId];
  check(`dialogue ${d.name} ids`, same(ids, d.ids), `${ids.length} vs ${d.ids.length}`);
  const tracker = new BoardTracker(t, undefined, { sync: 'pod', snapshotFens: dialogueSnapshotFens(d.turns.filter((x) => x.role !== 'system')) });
  const rows = tracker.rows(d.ids);
  const bad = rows.findIndex((r, i) => !same(Array.from(r), d.rows[i]));
  check(`dialogue ${d.name} rows`, bad < 0, `first mismatch at ${bad} (${t.decode([d.ids[bad]])})`);
  const a = d.ids.lastIndexOf(t.assistantId);
  const decoded = clean(t.decodeDialogueContent(d.ids.slice(a + 1, -1)));
  check(`dialogue ${d.name} decoded`, same(decoded, d.decoded), `${trunc(decoded)} vs ${trunc(d.decoded)}`);
}

// ---------------------------------------------------------------- prompts
for (const [i, p] of fx.prompts.entries()) {
  const turns = clean(promptTurns(p.turns, p.context, p.opts));
  check(`prompt ${i} turns`, same(turns, p.expected), `${trunc(turns)} vs ${trunc(p.expected)}`);
  const ids = t.chatPrompt(turns);
  check(`prompt ${i} ids`, same(ids, p.ids), `${ids.length} vs ${p.ids.length}`);
}
for (const [i, c] of fx.toRoles.entries()) {
  const out = clean(toRoles(c.turns, c.system));
  check(`toRoles ${i}`, same(out, c.expected), `${trunc(out)} vs ${trunc(c.expected)}`);
}

// ---------------------------------------------------------------- plan constraint
const SPECIAL = ['<|end_think|>', '<|plan|>', '<|end_plan|>', '<|line|>', '<|end_line|>', '<|eos|>', '<|user|>'];
for (const w of fx.walks) {
  const c = new LineConstraint(t, w.start, [], true, w.budget, undefined, true);
  w.steps.forEach((step, i) => {
    const allowed = [...c.allowed(w.seq.slice(0, i))].sort((x, y) => x - y);
    const got = allowed.length < 400 ? { ids: allowed } : { n: allowed.length, has: SPECIAL.filter((n) => allowed.includes(t.id(n))).sort() };
    check(`walk ${w.name} step ${i}`, same(got, step), `${trunc(got)} vs ${trunc(step)}`);
  });
}

// ---------------------------------------------------------------- carried plans
check('carryPlans', same(clean(carryPlans(fx.carry.history)), fx.carry.expected), trunc(clean(carryPlans(fx.carry.history))));

console.log(`${total - fail}/${total} roles checks passed`);
process.exit(fail ? 1 : 0);
