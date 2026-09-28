// Parity tests of the browser ChessMind port against Python fixtures: board-embedding codes
// (src/chessmind/fixtures/board-codes.json, from ChessMind's scripts/board_codes_fixture.py) and tokenizer v3
// (src/chessmind/fixtures/tokenizer-v3.json, from ChessMind's scripts/tokenizer_fixture.py): text ids for
// notation / unicode / whitespace strings, chat prompts, per-side game prompts and cropped per-side board rows; and
// tokenizer v4 (tokenizer-v4.json, format 4): the same checks plus hidden-reasoning dialogues (encode, board rows, decode);
// and the KV-cache slide (src/chessmind/kv.ts moveKeys).
// Usage: node scripts/test-chessmind.mjs   (Node >= 23: imports the TypeScript sources directly)
import { existsSync, readFileSync } from 'node:fs';
import { ChessTokenizer } from '../src/chessmind/tokenizer.ts';
import { BoardTracker, encodeFen, encodeGameWithBoards } from '../src/chessmind/boards.ts';
import { moveKeys } from '../src/chessmind/kv.ts';

let kvChecks = 0;

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

/** The tokenizer checks shared by every text fixture (v3 and the format-4 v4). */
function tokenizerChecks(tv, t, label) {
  for (const c of tv.texts) {
    const ids = t.encodeText(c.text);
    check(`${label} text ${JSON.stringify(c.text.slice(0, 40))}`, same(ids, c.ids), `${ids.slice(0, 12)} vs ${c.ids.slice(0, 12)}`);
    const dec = t.decodeText(c.ids);
    check(`${label} decode ${JSON.stringify(c.text.slice(0, 40))}`, dec === c.decoded, `${JSON.stringify(dec)} vs ${JSON.stringify(c.decoded)}`);
  }
  for (const c of tv.chats) {
    const ids = t.chatPrompt(c.turns);
    check(`${label} chat prompt ${JSON.stringify(c.turns[0].parts[0])}`, same(ids, c.ids), `${ids.slice(0, 12)} vs ${c.ids.slice(0, 12)}`);
  }
  for (const g of tv.games) {
    const ids = t.encodeGame(g.moves, g.result ?? undefined, g.perspective);
    check(`${label} game prompt ${g.name}`, same(ids, g.ids));
    const rows = new BoardTracker(t).rows(ids);
    check(`${label} game prompt rows ${g.name}`, same(rows, g.rows));
    check(`${label} side to move ${g.name}`, ChessTokenizer.sideToMove(g.moves.length) === g.perspective);
  }
  for (const c of tv.cropped) {
    const { ids, rows } = encodeGameWithBoards(t, c.moves, c.k, c.perspective);
    check(`${label} cropped per-side ${c.name}`, same(ids, c.ids) && same(rows, c.rows), `${ids.slice(0, 6)} vs ${c.ids.slice(0, 6)}`);
  }
}

const tv = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/tokenizer-v3.json', import.meta.url), 'utf8'));
const t3 = new ChessTokenizer(tv.chess_vocab, tv.bpe);
check('v3 format / prefix space / no thinking', t3.format === 3 && t3.prefixSpace && !t3.supportsThinking && t3.endThinkId === null && t3.size === t3.extraOffset);
tokenizerChecks(tv, t3, 'v3');
const v3Checks = total - boardChecks;

// Format 4 (hidden reasoning): tokenizer-v4.json from ChessMind's scripts/tokenizer_fixture.py, when present.
const v4Url = new URL('../src/chessmind/fixtures/tokenizer-v4.json', import.meta.url);
let v4Summary = 'no tokenizer-v4 fixture';
if (existsSync(v4Url)) {
  const f4 = JSON.parse(readFileSync(v4Url, 'utf8'));
  const t4 = new ChessTokenizer(f4.chess_vocab, f4.bpe);
  const extras = f4.chess_vocab.extra_special ?? [];
  check(
    'v4 extra specials',
    t4.supportsThinking && t4.endThinkId === t4.extraOffset && t4.extraOffset === (f4.chess_vocab.extra_offset ?? -1) && t4.size === t4.extraOffset + extras.length,
    `endThink ${t4.endThinkId} extraOffset ${t4.extraOffset} size ${t4.size}`,
  );
  check('v4 extras are not text ids', !t4.isTextId(t4.extraOffset) && t4.isTextId(t4.extraOffset - 1) && t4.decode([t4.endThinkId]) === '<|end_think|>');
  const before = total;
  tokenizerChecks(f4, t4, 'v4');
  for (const c of f4.thinking) {
    const rows = new BoardTracker(t4).rows(c.ids);
    const bad = rows.findIndex((r, i) => !same(r, c.rows[i]));
    check(`v4 think rows ${c.name}`, bad < 0 && rows.length === c.rows.length, bad >= 0 ? `first mismatch at token ${bad} (${t4.decode([c.ids[bad]])}): ${rows[bad]} vs ${c.rows[bad]}` : '');
    if (!c.turns) continue;
    const ids = [...t4.encodeDialogue(c.turns), t4.eosId];
    check(`v4 think encode ${c.name}`, same(ids, c.ids), `${t4.decode(ids)}\n   vs ${t4.decode(c.ids)}`);
    const a = c.ids.lastIndexOf(t4.assistantId);
    const content = c.ids.slice(a + 1, c.ids[c.ids.length - 1] === t4.eosId ? -1 : undefined);
    const dec = t4.decodeDialogueContent(content);
    check(`v4 think decode ${c.name}`, same(dec, c.decoded), `${JSON.stringify(dec)}\n   vs ${JSON.stringify(c.decoded)}`);
  }
  v4Summary = `${total - before} tokenizer-v4 checks (${f4.thinking.length} thinking cases)`;
}
// KV cache slide (src/chessmind/kv.ts): keys rotated at position p, moved down by d, equal the keys rotated at p - d.
{
  const before = total;
  const heads = 3, headDim = 8, theta = 10000, n = 12, sinks = 2, drop = 5;
  const raw = Array.from({ length: n * heads * headDim }, (_, i) => Math.sin(i * 1.7) * 2);
  const rope = (pos) => {
    const out = new Float32Array(heads * headDim);
    for (let h = 0; h < heads; h++)
      for (let i = 0; i < headDim / 2; i++) {
        const a = pos * Math.pow(theta, (-2 * i) / headDim);
        const x1 = raw[(pos * heads + h) * headDim + i], x2 = raw[(pos * heads + h) * headDim + headDim / 2 + i];
        out[h * headDim + i] = x1 * Math.cos(a) - x2 * Math.sin(a);
        out[h * headDim + headDim / 2 + i] = x1 * Math.sin(a) + x2 * Math.cos(a);
      }
    return out;
  };
  const buf = new Float32Array(n * heads * headDim);
  for (let p = 0; p < n; p++) buf.set(rope(p), p * heads * headDim);
  moveKeys(buf, sinks + drop, sinks, n - sinks - drop, heads, headDim, theta);
  let worst = 0;
  for (let p = sinks + drop; p < n; p++) {
    // the token from position p now sits at p - drop: its key must be its raw vector rotated by p - drop
    const want = new Float32Array(heads * headDim);
    for (let h = 0; h < heads; h++)
      for (let i = 0; i < headDim / 2; i++) {
        const a = (p - drop) * Math.pow(theta, (-2 * i) / headDim);
        const x1 = raw[(p * heads + h) * headDim + i], x2 = raw[(p * heads + h) * headDim + headDim / 2 + i];
        want[h * headDim + i] = x1 * Math.cos(a) - x2 * Math.sin(a);
        want[h * headDim + headDim / 2 + i] = x1 * Math.sin(a) + x2 * Math.cos(a);
      }
    const got = buf.subarray((p - drop) * heads * headDim, (p - drop + 1) * heads * headDim);
    worst = Math.max(worst, ...got.map((g, j) => Math.abs(g - want[j])));
  }
  check('kv moveKeys re-rotates moved keys', worst < 1e-5, `max diff ${worst}`);
  const sinkRow = buf.subarray(0, sinks * heads * headDim);
  check('kv moveKeys keeps the sinks', same([...sinkRow], [...rope(0), ...rope(1)]));
  kvChecks = total - before;
}
console.log(`${boardChecks} board-code checks, ${v3Checks} tokenizer-v3 checks (${tv.texts.length} texts), ${v4Summary}, ${kvChecks} kv checks; ${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
