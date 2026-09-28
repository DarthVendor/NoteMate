// Parity of the v6 board rows (ChessMind docs/board-embedding.md): the "pod" tracker (text sees the position under
// discussion) and the feature planes (state, material, pawns, attacks, flags) of src/chessmind/boards.ts against
// src/chessmind/fixtures/board-v6.json (ChessMind's scripts/board_v6_fixture.py), plus the legacy rows staying put.
// Usage: node scripts/test-board-v6.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync } from 'node:fs';
import { ChessTokenizer } from '../src/chessmind/tokenizer.ts';
import { ABSENT_ROW, BoardTracker, encodeGameWithBoards, nSlots } from '../src/chessmind/boards.ts';

const fx = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/board-v6.json', import.meta.url), 'utf8'));
const tv = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/tokenizer-v4.json', import.meta.url), 'utf8'));
const tok = new ChessTokenizer(tv.chess_vocab, tv.bpe);
const DIGITS = '0123456789abcdefg';
const enc = (rows) => rows.map((r) => r.map((c) => DIGITS[c]).join(''));
let total = 0;
let fail = 0;
const check = (name, ok, detail) => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};
const diff = (got, want) => {
  const i = got.findIndex((r, k) => r !== want[k]);
  if (i < 0) return got.length === want.length ? '' : `length ${got.length} vs ${want.length}`;
  const j = [...got[i]].findIndex((c, k) => c !== want[i][k]);
  return `token ${i} slot ${j}: ${got[i].slice(Math.max(0, j - 4), j + 8)} vs ${want[i].slice(Math.max(0, j - 4), j + 8)}`;
};

check('width with every feature', nSlots(fx.features) === 68 + 5 + 10 + 16 + 64 + 64);
for (const s of fx.sequences) {
  for (const [key, cfg] of Object.entries(fx.configs)) {
    const rows = enc(new BoardTracker(tok, s.start_fen ?? undefined, cfg).rows(s.ids));
    check(`${s.name} [${key}]`, diff(rows, s.rows[key]) === '', diff(rows, s.rows[key]));
  }
  // flags off: the legacy tracker is untouched
  const legacy = new BoardTracker(tok).rows(s.ids);
  check(`${s.name} [legacy default width]`, legacy.every((r) => r.length === ABSENT_ROW.length));
}
for (const c of fx.cropped) {
  for (const [key, cfg] of Object.entries(fx.configs)) {
    const { ids, rows } = encodeGameWithBoards(tok, c.moves, c.k, c.perspective, cfg);
    const got = enc(rows);
    check(`cropped ${c.name} [${key}]`, JSON.stringify(ids) === JSON.stringify(c.ids) && diff(got, c.rows[key]) === '', diff(got, c.rows[key]));
  }
}
console.log(`${total - fail}/${total} v6 board checks passed`);
if (fail) process.exit(1);
