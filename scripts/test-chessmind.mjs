// Parity tests of the browser ChessMind port against Python fixtures: board-embedding codes
// (src/chessmind/fixtures/board-codes.json, from ChessMind's scripts/board_codes_fixture.py) and tokenizer v3
// (src/chessmind/fixtures/tokenizer-v3.json, from ChessMind's scripts/tokenizer_fixture.py): text ids for
// notation / unicode / whitespace strings, chat prompts, per-side game prompts and cropped per-side board rows.
// Usage: node scripts/test-chessmind.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync } from 'node:fs';
import { ChessTokenizer } from '../src/chessmind/tokenizer.ts';
import { BoardTracker, encodeFen, encodeGameWithBoards } from '../src/chessmind/boards.ts';

const fx = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/board-codes.json', import.meta.url), 'utf8'));
const tok = new ChessTokenizer(fx.chess_vocab, null);
let fail = 0;
let total = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, ok, detail) => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};
for (const p of fx.positions) check(`position ${p.fen}`, same(encodeFen(p.fen), p.row), `${encodeFen(p.fen).slice(64)} vs ${p.row.slice(64)}`);
for (const s of fx.sequences) {
  const rows = new BoardTracker(tok).rows(s.ids);
  const bad = rows.findIndex((r, i) => !same(r, s.rows[i]));
  check(`sequence ${s.name} (${s.ids.length} tokens)`, bad < 0 && rows.length === s.rows.length, bad >= 0 ? `first mismatch at token ${bad}: ${rows[bad]} vs ${s.rows[bad]}` : '');
}
for (const c of fx.cropped) {
  const { ids, rows } = encodeGameWithBoards(tok, c.moves, c.k);
  check(`cropped ${c.name}`, same(ids, c.ids) && same(rows, c.rows));
}
const boardChecks = total;

const tv = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/tokenizer-v3.json', import.meta.url), 'utf8'));
const t3 = new ChessTokenizer(tv.chess_vocab, tv.bpe);
check('v3 format / prefix space', t3.format === 3 && t3.prefixSpace);
for (const c of tv.texts) {
  const ids = t3.encodeText(c.text);
  check(`text ${JSON.stringify(c.text.slice(0, 40))}`, same(ids, c.ids), `${ids.slice(0, 12)} vs ${c.ids.slice(0, 12)}`);
  const dec = t3.decodeText(c.ids);
  check(`decode ${JSON.stringify(c.text.slice(0, 40))}`, dec === c.decoded, `${JSON.stringify(dec)} vs ${JSON.stringify(c.decoded)}`);
}
for (const c of tv.chats) {
  const ids = t3.chatPrompt(c.turns);
  check(`chat prompt ${JSON.stringify(c.turns[0].parts[0])}`, same(ids, c.ids), `${ids.slice(0, 12)} vs ${c.ids.slice(0, 12)}`);
}
for (const g of tv.games) {
  const ids = t3.encodeGame(g.moves, g.result ?? undefined, g.perspective);
  check(`game prompt ${g.name}`, same(ids, g.ids));
  const rows = new BoardTracker(t3).rows(ids);
  check(`game prompt rows ${g.name}`, same(rows, g.rows));
  check(`side to move ${g.name}`, ChessTokenizer.sideToMove(g.moves.length) === g.perspective);
}
for (const c of tv.cropped) {
  const { ids, rows } = encodeGameWithBoards(t3, c.moves, c.k, c.perspective);
  check(`cropped per-side ${c.name}`, same(ids, c.ids) && same(rows, c.rows), `${ids.slice(0, 6)} vs ${c.ids.slice(0, 6)}`);
}
console.log(`${boardChecks - fail}/${boardChecks} board-code checks, ${total - boardChecks} tokenizer-v3 checks (${tv.texts.length} texts); ${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
