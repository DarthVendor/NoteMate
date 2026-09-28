// Parity tests of the browser ChessMind port against Python fixtures: board-embedding codes
// (src/chessmind/fixtures/board-codes.json, from ChessMind's scripts/board_codes_fixture.py) and tokenizer v3
// (src/chessmind/fixtures/tokenizer-v3.json, from ChessMind's scripts/tokenizer_fixture.py): text ids for
// notation / unicode / whitespace strings, chat prompts, per-side game prompts and cropped per-side board rows; and
// tokenizer v4 (tokenizer-v4.json, format 4): the same checks plus hidden-reasoning dialogues (encode, board rows, decode);
// line branches and end markers (the named format-4 extras: <|branch|>, <|repetition|> ...; encode, rows, decode and
// the generation mask along each line, src/chessmind/lines.ts LineWalker), the board snapshots an answer may show
// (snapshots.ts: rewind candidates and the trie masks while one is written), and the KV-cache slide (kv.ts moveKeys).
// Usage: node scripts/test-chessmind.mjs   (Node >= 23: imports the TypeScript sources directly)
import { existsSync, readFileSync } from 'node:fs';
import { ChessTokenizer } from '../src/chessmind/tokenizer.ts';
import { BoardTracker, encodeFen, encodeGameWithBoards } from '../src/chessmind/boards.ts';
import { moveKeys, rowsHash, sharedPrefix } from '../src/chessmind/kv.ts';
import { LineWatch, lineEnding, probAmong } from '../src/chessmind/lineRules.ts';
import { LineWalker, lineVariations, movesToPath, displayLine } from '../src/chessmind/lines.ts';
import { SnapshotPicker, dialoguePosition, rewindCandidates } from '../src/chessmind/snapshots.ts';

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
  // Line branches and end markers: the fixture's chess_vocab still lists <|reserved_k|>; they load with the new names.
  check('v4 named extras', t4.supportsBranches && t4.branchId === t4.extraOffset + 1 && t4.endBranchId === t4.extraOffset + 2 && t4.markerIds.repetition === t4.extraOffset + 3 && t4.markerIds.draw === t4.extraOffset + 4 && t4.markerIds.mate === t4.extraOffset + 5 && t4.checkId === t4.extraOffset + 6 && t4.extraSpecial[7] === '<|reserved_7|>');
  for (const c of f4.branches ?? []) {
    const rows = new BoardTracker(t4).rows(c.ids);
    const bad = rows.findIndex((r, i) => !same(r, c.rows[i]));
    check(`v4 branch rows ${c.name}`, bad < 0 && rows.length === c.rows.length, bad >= 0 ? `first mismatch at token ${bad} (${t4.decode([c.ids[bad]])}): ${rows[bad]} vs ${c.rows[bad]}` : '');
    if (!c.turns) continue;
    const ids = [...t4.encodeDialogue(c.turns), t4.eosId];
    check(`v4 branch encode ${c.name}`, same(ids, c.ids), `${t4.decode(ids)}\n   vs ${t4.decode(c.ids)}`);
    check(`v4 branch prompt ${c.name}`, same(t4.chatPrompt(c.turns.slice(0, 1)), c.prompt));
    const a = c.ids.lastIndexOf(t4.assistantId);
    const dec = t4.decodeDialogueContent(c.ids.slice(a + 1, -1));
    check(`v4 branch decode ${c.name}`, same(dec, c.decoded), `${JSON.stringify(dec)}\n   vs ${JSON.stringify(c.decoded)}`);
  }
  for (const w of f4.walks ?? []) {
    const walker = new LineWalker(t4, w.fen ?? undefined);
    let bad = -1;
    w.ids.forEach((id, i) => {
      const got = walker.allowed().sort((x, y) => x - y);
      if (bad < 0 && !same(got, w.allowed[i])) bad = i;
      walker.feed(id);
    });
    check(`v4 line walk ${w.name}`, bad < 0, bad >= 0 ? `step ${bad} (${t4.decode([w.ids[bad]])}): ${walker.allowed().length} ids vs ${w.allowed[bad].length}` : '');
  }
  // Display helpers: the nested case's variations as full move lists and the chips' paths.
  const nested = (f4.branches ?? []).find((c) => c.name === 'nested');
  if (nested) {
    const line = nested.decoded.find((p) => p.kind === 'line');
    const vars = lineVariations(line);
    check('lines variations', same(vars.map((v) => v.moves.length), [4, 4, 4, 2]) && same(vars[2].moves, ['e2e4', 'c7c5', 'c2c3', 'd7d5']) && same(vars[2].path, [1, 0, 1, 0]));
    check('lines movesToPath', same(movesToPath(line, [1, 0, 1, 0, 1]), ['e2e4', 'c7c5', 'c2c3', 'd7d5']) && same(movesToPath(line, [3]), line.moves));
    const disp = displayLine(line);
    const sub = disp.branches.get(1);
    check('lines display', disp.chips.map((c) => c.num + c.san).join(' ') === '1.e4 e5 2.Nf3 Nc6' && sub?.length === 2 && sub[0].chips.map((c) => c.num + c.san).join(' ') === '1…c5 2.Nf3 2…d6' && sub[0].branches.get(1)?.[0].chips[0].num === '2.');
  }
  // Snapshots (generate.rewind_candidates / SnapshotPicker): the candidate boards (as snapshot ids) and the masks
  // while each chosen candidate is written; `legacy` = dialogue_position's two candidates (side token, then forced).
  for (const c of f4.snapshots ?? []) {
    const cands = rewindCandidates(c.turns, c.game_moves ?? undefined);
    const got = cands.map((fen) => t4.encodeBoard(fen).slice(1));
    check(`v4 snapshot candidates ${c.name}`, same(got, c.candidates), `${got.length} vs ${c.candidates.length}`);
    const legacy = dialoguePosition(c.turns).positions;
    check(`v4 snapshot legacy ${c.name}`, same(legacy.map((fen) => t4.encodeBoard(fen).slice(1)), c.legacy));
    for (const w of c.walks) {
      const p = new SnapshotPicker(t4, w.cands === 'rewind' ? cands : legacy);
      p.begin();
      let bad = -1;
      let chosen = null;
      w.ids.forEach((id, i) => {
        if (bad < 0 && !same(p.allowed(), w.allowed[i])) bad = i;
        chosen = p.feed(id);
      });
      const castling = chosen === null ? null : chosen.split(' ')[2];
      check(`v4 snapshot walk ${c.name} ${w.cands}`, bad < 0 && castling === w.castling && !p.active, bad >= 0 ? `step ${bad}: ${p.allowed()} vs ${w.allowed[bad]}` : `castling ${castling} vs ${w.castling}`);
    }
  }
  v4Summary = `${total - before} tokenizer-v4 checks (${f4.thinking.length} thinking cases, ${(f4.branches ?? []).length} branch cases, ${(f4.walks ?? []).length} line walks, ${(f4.snapshots ?? []).length} snapshot cases)`;
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
// KV-cache reuse is keyed on the ids AND the board rows (kv.ts sharedPrefix): the same ids with other rows are no hit.
let cacheChecks = 0;
{
  const before = total;
  const a = encodeGameWithBoards(tok, ['e2e4', 'e7e5', 'g1f3', 'b8c6'], 2);
  const b = encodeGameWithBoards(tok, ['d2d4', 'd7d5', 'g1f3', 'b8c6'], 2);
  check('kv key: cropped games with equal ids', same(a.ids, b.ids) && !same(a.rows, b.rows));
  check('kv key: other board rows share nothing', sharedPrefix(a.ids, a.rows, b.ids, b.rows) === 0);
  check('kv key: same ids and rows share all', sharedPrefix(a.ids, a.rows, a.ids, a.rows.map((r) => [...r])) === a.ids.length);
  const slid = encodeGameWithBoards(tok, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], 2);
  check('kv key: the next ply of a cropped game shares nothing (a new board on <|game|>)', sharedPrefix(a.ids, a.rows, slid.ids, slid.rows) === 0);
  const full = encodeGameWithBoards(tok, ['e2e4', 'e7e5', 'g1f3'], null);
  const next = encodeGameWithBoards(tok, ['e2e4', 'e7e5', 'g1f3', 'b8c6'], null);
  check('kv key: the next ply extends the full game', sharedPrefix(full.ids, full.rows, next.ids, next.rows) === full.ids.length);
  check('kv key: no rows (text-only models) compare ids', sharedPrefix([1, 2, 3], [], [1, 2, 4]) === 2);
  // the debug log's row hash equals ChessMind's (FNV-1a over the int8 codes of boards_for_ids)
  const want = { 'game:opera-game': '0f5892ad', 'game:ep-and-promotion': '8d294e33', 'game:black-ep': 'a7c91f22' };
  for (const sq of fx.sequences.slice(0, 3)) check(`rows hash ${sq.name}`, rowsHash(new BoardTracker(tok).rows(sq.ids)) === want[sq.name], rowsHash(sq.rows));
  cacheChecks = total - before;
}
// Line rules (lineRules.ts; twin of ChessMind generate.line_end_reason / LineRules): where generated lines stop.
let lineChecks = 0;
{
  const before = total;
  check('line end: checkmate', lineEnding(undefined, ['f2f3', 'e7e5', 'g2g4', 'd8h4']) === 'checkmate');
  check('line end: stalemate', lineEnding('k7/8/2Q5/8/8/8/8/K7 w - - 0 1', ['c6b6']) === 'stalemate');
  check('line end: repetition at the first repeat', lineEnding(undefined, ['g1f3', 'g8f6', 'f3g1', 'f6g8']) === 'repetition' && lineEnding(undefined, ['g1f3', 'g8f6', 'f3g1']) === null);
  check('line end: insufficient material', lineEnding('k7/8/8/8/8/8/8/Kq6 w - - 0 1', ['a1b1']) === 'insufficient');
  check('line end: fifty-move rule', lineEnding('k7/8/8/8/8/8/8/KQ6 w - - 99 80', ['b1b2']) === 'fifty-move');
  check('line end: open line', lineEnding(undefined, ['e2e4', 'e7e5', 'g1f3']) === null);
  check('line end: illegal move is no ending', lineEnding(undefined, ['e2e5']) === null);
  const w = new LineWatch();
  check('line watch counts plies', w.push('e2e4') && w.push('e7e5') && !w.push('e1e3') && w.plies === 2);
  const p = probAmong([0, Math.log(3), 5, 0], [0, 1, 3], 1);
  check('probAmong renormalises over the allowed ids', Math.abs(p - 3 / 5) < 1e-9 && probAmong([0, 1], [0], 1) === 0);
  lineChecks = total - before;
}
console.log(`${boardChecks} board-code checks, ${v3Checks} tokenizer-v3 checks (${tv.texts.length} texts), ${v4Summary}, ${kvChecks} kv checks, ${cacheChecks} cache-key checks, ${lineChecks} line-rule checks; ${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
