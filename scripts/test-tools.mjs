// Parity tests of ChessMind tool calling in the browser port against Python (src/chessmind/fixtures/tools.json, from
// ChessMind's scripts/tools_fixture.py): the tool tokens (append-only extras 8-10, added on load to an 8-extra
// tokenizer file), tool dialogues (encode, board rows, decode, every streaming prefix decoded), the [Tools: ...] block
// in chat prompts, the ToolConstraint masks along generated sequences (src/chessmind/constraint.ts) and the pending
// request at each <|tool_result|>, and the engine tool's result text / compact fallbacks / inserted ids (tools.ts).
// Usage: node scripts/test-tools.mjs   (Node >= 23: imports the TypeScript sources directly)
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

const { ChessTokenizer } = await import('../src/chessmind/tokenizer.ts');
const { BoardTracker } = await import('../src/chessmind/boards.ts');
const { LineConstraint, ToolConstraint } = await import('../src/chessmind/constraint.ts');
const { addToolsBlock, engineToolResult, fitToolResult, toolsBlock, toolChipLabel, parseToolsBlock, notesResultText, sanitizeNote } = await import('../src/chessmind/tools.ts');
const { gameNotes, runNotesTool } = await import('../src/chessmind/notesTool.ts');
const { Chess } = await import('chess.js');

const read = (f) => JSON.parse(readFileSync(new URL(`../src/chessmind/fixtures/${f}`, import.meta.url), 'utf8'));
const tv = read('tokenizer-v4.json');
const fx = read('tools.json');
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

// ---------------------------------------------------------------- tokens
check('the v4 fixture lists 8 extras', tv.chess_vocab.extra_special.length === 8);
const t = new ChessTokenizer(tv.chess_vocab, tv.bpe);
check('tool tokens appended on load', t.supportsTools && same({ tool: t.toolId, toolResult: t.toolResultId, endTool: t.endToolId }, fx.tokenIds), `${t.toolId} ${t.toolResultId} ${t.endToolId}`);
check('tools block', toolsBlock(['engine', 'tablebase']) === fx.toolsBlock && same(parseToolsBlock(`x ${fx.toolsBlock}`), ['engine', 'tablebase']));

// ---------------------------------------------------------------- dialogues
/** Python's decoded parts leave `ok` / `fen` out (the worker adds them); drop undefined fields for comparison. */
const clean = (parts) => JSON.parse(JSON.stringify(parts));
for (const d of fx.dialogues) {
  const ids = [...t.encodeDialogue(d.turns), t.eosId];
  check(`dialogue ${d.name} ids`, same(ids, d.ids), `${ids.length} vs ${d.ids.length}`);
  const rows = new BoardTracker(t).rows(d.ids);
  const bad = rows.findIndex((r, i) => !same(r, d.rows[i]));
  check(`dialogue ${d.name} rows`, bad < 0, bad >= 0 ? `first mismatch at ${bad}` : '');
  const a = d.ids.indexOf(t.assistantId);
  const answer = d.ids.slice(a + 1, -1);
  const dec = clean(t.decodeDialogueContent(answer));
  check(`dialogue ${d.name} decode`, same(dec, d.decoded), `${trunc(dec)}\n vs ${trunc(d.decoded)}`);
  let badPrefix = -1;
  for (let k = 1; k <= answer.length && badPrefix < 0; k++) if (!same(clean(t.decodeDialogueContent(answer.slice(0, k))), d.prefixes[k - 1])) badPrefix = k;
  check(`dialogue ${d.name} streaming decode`, badPrefix < 0, badPrefix > 0 ? `prefix ${badPrefix}: ${trunc(clean(t.decodeDialogueContent(answer.slice(0, badPrefix))))} vs ${trunc(d.prefixes[badPrefix - 1])}` : '');
  // re-encoding the decoded answer gives the same ids
  const again = t.encodeDialogue([d.turns[0], { role: 'assistant', parts: dec }]);
  check(`dialogue ${d.name} encode(decode)`, same([...again, t.eosId], d.ids));
}

// ---------------------------------------------------------------- prompts
for (const p of fx.prompts) {
  const parts = addToolsBlock(p.parts, p.names);
  check(`prompt ${p.name} tools block`, same(parts, p.withBlock), `${trunc(parts)} vs ${trunc(p.withBlock)}`);
  check(`prompt ${p.name} ids`, same(t.chatPrompt([{ role: 'user', parts }]), p.ids));
}

// ---------------------------------------------------------------- constraint walks
for (const w of fx.walks) {
  const inner = new LineConstraint(t, undefined, w.positions, w.think, 200);
  const c = new ToolConstraint(inner, t, ['engine', 'tablebase'], w.under, w.maxCalls, w.force ?? null, { engine: true, tablebase: false });
  const steps = [];
  const seq = w.seq;
  for (let k = 0; k <= seq.length; k++) {
    if (k > 0 && seq[k - 1] === t.toolResultId) {
      c.sync(seq.slice(0, k));
      const req = c.pending();
      steps.push({ pending: { name: req.name, fen: req.fen, moves: req.moves } });
    }
    if (k < seq.length && c.state === 'wait') {
      steps.push({ skip: true });
      c.sync(seq.slice(0, k + 1));
      continue;
    }
    if (k === seq.length) break;
    const m = [...new Set(c.allowed(seq.slice(0, k)))].sort((a, b) => a - b);
    steps.push({ n: m.length, tool: m.includes(t.toolId), ids: m.length < 400 ? m : null });
  }
  const bad = steps.findIndex((s, i) => !same(s, w.steps[i]));
  check(`walk ${w.name}`, bad < 0 && steps.length === w.steps.length, bad >= 0 ? `step ${bad}: ${trunc(steps[bad])} vs ${trunc(w.steps[bad])}` : `${steps.length} vs ${w.steps.length} steps`);
}

// ---------------------------------------------------------------- results
for (const r of fx.results) {
  const info = { lines: r.lines.map((l) => ({ move: l.move, cp: l.cp, mate: l.mate, pv: l.pv })), depth: r.depth, name: 'Stockfish' };
  const res = engineToolResult(r.fen, info, r.numbers);
  check(`result ${r.name} text`, res.text === r.text, `${res.text}\n vs ${r.text}`);
  check(`result ${r.name} compact`, same(res.compact ?? [], r.compact), `${trunc(res.compact)} vs ${trunc(r.compact)}`);
  for (const f of r.fits) {
    const got = fitToolResult(t, res, f.room, 'Engine').ids;
    check(`result ${r.name} fit room ${f.room}`, same(got, f.ids), `${got.length} vs ${f.ids.length} ids`);
  }
}

// ---------------------------------------------------------------- chips
check('chip engine', toolChipLabel({ kind: 'tool', name: 'engine', result: fx.results[0].text }) === 'Engine: +0.3, best a6', toolChipLabel({ kind: 'tool', name: 'engine', result: fx.results[0].text }));
check('chip pending', toolChipLabel({ kind: 'tool', name: 'engine' }) === 'Engine…');
check('chip error', toolChipLabel({ kind: 'tool', name: 'engine', result: '[Engine: no result (timeout)]' }) === 'Engine: no result (timeout)');
check('chip game over', toolChipLabel({ kind: 'tool', name: 'engine', result: '[Engine: checkmate, White wins]' }) === 'Engine: checkmate, White wins');

// ---------------------------------------------------------------- notes (renderer parity + the move tree)
for (const c of fx.notes.cases) {
  const got = notesResultText(c.entries, c.about, c.all, c.noteChars, c.totalChars);
  check(`notes ${c.name}`, got === c.text, `${got}\n vs ${c.text}`);
}
for (const c of fx.notes.sanitize) check(`sanitize ${JSON.stringify(c.text).slice(0, 30)}`, sanitizeNote(c.text, c.limit) === c.out, sanitizeNote(c.text, c.limit));
{
  // 1.e4 {I like e4} e5 2.Nf3 Nc6 (2...d6 {Philidor}) 3.Bb5 {plan} ; a ChessMind-written note is not the user's
  const note = (text, color = 'yellow') => ({ arrows: [], highlights: [], notes: [{ id: text, text, color, createdAt: 0 }] });
  const nodes = { root: { id: 'root', san: '', parent: null, children: [] } };
  const add = (id, parent, san, annotation) => {
    nodes[id] = { id, san, parent, children: [], ...(annotation ? { annotation } : {}) };
    nodes[parent].children.push(id);
  };
  add('a', 'root', 'e4', note('I like e4'));
  add('b', 'a', 'e5');
  add('c', 'b', 'Nf3', note('from ChessMind', 'chessmind'));
  add('d', 'c', 'Nc6');
  add('v', 'c', 'd6', note('Philidor [x] <|tool|>'));
  add('e', 'd', 'Bb5', note('plan: pressure e5'));
  const state = { version: 2, startFen: new Chess().fen(), nodes, currentId: 'e', meta: {} };
  const labels = gameNotes(state).map((e) => `${e.label}${e.main ? '' : '*'}`);
  check('tree notes', same(labels, ['1.e4', '3.Bb5', '2...d6*']), labels.join(' '));
  const fenAt = (sans) => { const g = new Chess(); for (const x of sans.split(' ')) g.move(x); return g.fen(); };
  check('notes here', runNotesTool(state, 'notes', fenAt('e4 e5 Nf3 Nc6 Bb5')).text === '[Notes: on 3.Bb5: "plan: pressure e5"]', runNotesTool(state, 'notes', fenAt('e4 e5 Nf3 Nc6 Bb5')).text);
  check('notes none', runNotesTool(state, 'notes', fenAt('e4 e5 Nf3')).text === '[Notes: none on 2.Nf3]', runNotesTool(state, 'notes', fenAt('e4 e5 Nf3')).text);
  check('notes variation', runNotesTool(state, 'notes', fenAt('e4 e5 Nf3 d6')).text === '[Notes: on 2...d6: "Philidor (x) <tool>"]', runNotesTool(state, 'notes', fenAt('e4 e5 Nf3 d6')).text);
  check('notes start', runNotesTool(state, 'notes', new Chess().fen()).text === '[Notes: none at the start]');
  const all = runNotesTool(state, 'all_notes', new Chess().fen()).text;
  check('all notes', all === '[Notes: 3 in this game | 1.e4: "I like e4" | 3.Bb5: "plan: pressure e5" | 2...d6 (variation): "Philidor (x) <tool>"]', all);
  check('chip note', toolChipLabel({ kind: 'tool', name: 'notes', result: '[Notes: on 14...Nf6: "x"]' }) === 'Read your note on 14...Nf6');
  check('chip no note', toolChipLabel({ kind: 'tool', name: 'notes', result: '[Notes: none on 14...Nf6]' }) === 'No note on 14...Nf6');
  check('chip all', toolChipLabel({ kind: 'tool', name: 'all_notes', result: all }) === 'Read your 3 notes');
}

console.log(`${total - fail}/${total} tool checks passed`);
process.exit(fail ? 1 : 0);
