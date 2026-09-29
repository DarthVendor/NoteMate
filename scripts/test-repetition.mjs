// Parity of the chat repetition guard (src/chessmind/repetition.ts) against src/chessmind/fixtures/repetition.json
// (ChessMind's scripts/repetition_fixture.py, chessmind/model/repetition.py): token classes, and per step of each case
// the forced id, penalised and banned ids; then loops, cuts, kept ids, answer tokens and the stop. Also the CTRL
// penalty on logits, the never-empty mask and the defaults.
// Usage: node scripts/test-repetition.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync } from 'node:fs';
import { ChessTokenizer } from '../src/chessmind/tokenizer.ts';
import { DEFAULT_REPETITION, RepetitionGuard, tokenClasses } from '../src/chessmind/repetition.ts';

const fx = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/repetition.json', import.meta.url), 'utf8'));
const tv = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/tokenizer-v4.json', import.meta.url), 'utf8'));
const tok = new ChessTokenizer(tv.chess_vocab, tv.bpe);
let total = 0;
let fail = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, ok, detail) => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};
const rulesOf = (r) => ({ penalty: r.penalty, window: r.window, ngram: r.ngram, stopLoops: r.stop_loops, sentenceRepeats: r.sentence_repeats, lineRepeats: r.line_repeats, minSentenceWords: r.min_sentence_words });

check('defaults match Python', same(rulesOf(fx.defaults), DEFAULT_REPETITION), JSON.stringify(DEFAULT_REPETITION));

const cls = tokenClasses(tok);
for (const [k, tk] of [['word', 'word'], ['space', 'space'], ['punct_end', 'puncEnd'], ['newline', 'newline']]) {
  const mine = [];
  for (let i = tok.textOffset; i < tok.extraOffset; i++) if (cls[tk][i]) mine.push(i);
  check(`classes ${k}`, same(mine, fx.classes[k]), `${mine.length} vs ${fx.classes[k].length}`);
}

const all = Array.from({ length: tok.size }, (_, i) => i);
for (const c of fx.cases) {
  const g = new RepetitionGuard(tok, rulesOf(c.rules));
  const out = [];
  let bad = -1;
  for (const [s, x] of c.proposals.entries()) {
    const r = g.shape(out, new Float32Array(tok.size), all);
    const step = { forced: r.forced, penalized: g.penalized(), banned: g.banned() };
    if (bad < 0 && !same(step, c.steps[s])) bad = s;
    out.push(r.forced ?? x);
    if (out[out.length - 1] === tok.eosId) break;
  }
  g.sync(out);
  check(`${c.name}: steps`, bad < 0, bad >= 0 ? `step ${bad}: forced ${c.steps[bad].forced}, ${c.steps[bad].penalized.length} penalized, banned ${c.steps[bad].banned}` : '');
  check(`${c.name}: out`, same(out, c.out));
  check(`${c.name}: loops`, same(g.loops, c.loops), JSON.stringify(g.loops));
  check(`${c.name}: cuts`, same(g.cuts, c.cuts), JSON.stringify(g.cuts));
  check(`${c.name}: keep`, same(g.keep(out), c.keep));
  check(`${c.name}: answer tokens`, g.answerTokens === c.answer_tokens, `${g.answerTokens} vs ${c.answer_tokens}`);
  check(`${c.name}: stop`, g.stop === c.stop, `${g.stop} vs ${c.stop}`);
}

// CTRL penalty on logits; the n-gram block never empties the mask
{
  const w = tok.encodeText('Bishop');
  const g = new RepetitionGuard(tok, { ...DEFAULT_REPETITION, penalty: 2, ngram: 0 });
  const lg = new Float32Array(tok.size);
  lg[w[0]] = 4;
  lg[tok.eosId] = 4;
  g.shape([...w], lg, all);
  check('penalty divides a positive logit', lg[w[0]] === 2 && lg[tok.eosId] === 4, `${lg[w[0]]}`);
  const g2 = new RepetitionGuard(tok, { ...DEFAULT_REPETITION, penalty: 2, ngram: 0 });
  const lg2 = new Float32Array(tok.size);
  lg2[w[0]] = -1;
  g2.shape([...w], lg2, all);
  check('penalty multiplies a negative logit', lg2[w[0]] === -2);
  const ids = tok.encodeText('one two three four');
  const g3 = new RepetitionGuard(tok, { ...DEFAULT_REPETITION, ngram: 3 });
  const r = g3.shape([...ids, ...ids.slice(0, 2)], new Float32Array(tok.size), [ids[2]]);
  check('the block never empties the mask', same(r.allowed, [ids[2]]));
}

console.log(`${total - fail}/${total} repetition checks passed`);
process.exit(fail ? 1 : 0);
