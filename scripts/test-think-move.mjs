// Parity of think-then-move (ChessMind chessmind/data/game_thinks.py, chessmind/model/think_move.py) against
// src/chessmind/fixtures/think-move.json (ChessMind's scripts/think_move_fixture.py): the legacy BoardTracker rows of
// per-side game instances with in-game thinks (boards.ts: <|end_think|> inside a game shows the game position again),
// and the ThinkMoveConstraint masks (thinkMove.ts) at every step of a few completions, plus the move each one chose.
// Usage: node scripts/test-think-move.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { ChessTokenizer } from '../src/chessmind/tokenizer.ts';
import { BoardTracker } from '../src/chessmind/boards.ts';
import { DEFAULT_LINE_RULES } from '../src/chessmind/lineRules.ts';
import { ThinkMoveConstraint } from '../src/chessmind/thinkMove.ts';

const fx = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/think-move.json', import.meta.url), 'utf8'));
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

check('line rules match the fixture', same(fx.line_rules.end_p, [DEFAULT_LINE_RULES.endP.think, DEFAULT_LINE_RULES.endP.answer]) && same(fx.line_rules.max_plies, [DEFAULT_LINE_RULES.maxPlies.think, DEFAULT_LINE_RULES.maxPlies.answer]));

// (a) board rows (legacy sync), the cropped instance from its start_fen
for (const s of fx.sequences) {
  const rows = new BoardTracker(tok, s.start_fen ?? undefined).rows(s.ids);
  const bad = rows.findIndex((r, i) => !same(r, s.rows[i]));
  check(`rows ${s.name} (${s.ids.length} tokens)`, bad < 0 && rows.length === s.rows.length, bad >= 0 ? `token ${bad} (${tok.decode([s.ids[bad]])}): ${rows[bad]} vs ${s.rows[bad]}` : '');
}

// (b) the constraint's allowed set before every token, the phase and end threshold after it; (c) the move
const text = [];
for (let i = tok.textOffset; i < tok.extraOffset; i++) text.push(i);
const TEXT = JSON.stringify([...text, tok.lineId, tok.endThinkId].sort((a, b) => a - b));
const sorted = (ids) => [...ids].sort((a, b) => a - b);
for (const w of fx.walks) {
  const board = new Chess();
  for (const m of w.moves) board.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  const c = new ThinkMoveConstraint(tok, board.fen(), w.think, w.max_think_tokens);
  let bad = null;
  w.steps.forEach((s, i) => {
    if (bad) return;
    const got = sorted(c.allowedIds());
    const ok = s.allowed === 'TEXT' ? JSON.stringify(got) === TEXT : same(got, s.allowed);
    if (!ok) bad = `step ${i} allowed: ${got.length} ids ${got.slice(0, 8)} vs ${s.allowed === 'TEXT' ? 'TEXT' : s.allowed.slice(0, 8)}`;
    else if (s.token !== null) {
      c.feed(s.token);
      if (c.phase !== s.phase) bad = `step ${i} phase ${c.phase} vs ${s.phase}`;
      else if (c.endThreshold() !== s.end_threshold) bad = `step ${i} end threshold ${c.endThreshold()} vs ${s.end_threshold}`;
    }
  });
  check(`walk ${w.name}`, bad === null, bad ?? '');
  check(`walk ${w.name} move`, c.move === w.move, `${c.move} vs ${w.move}`);
}

// The GenConstraint interface (allowed(out) syncs) agrees with feed / allowedIds.
{
  const w = fx.walks[0];
  const board = new Chess();
  for (const m of w.moves) board.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  const c = new ThinkMoveConstraint(tok, board.fen(), w.think, w.max_think_tokens);
  const out = [];
  let ok = true;
  for (const s of w.steps) {
    const got = sorted(c.allowed(out));
    if (s.allowed !== 'TEXT' && !same(got, s.allowed)) ok = false;
    if (s.token !== null) out.push(s.token);
  }
  check('allowed(out) syncs like feed', ok && c.move === w.move);
}

// A tokenizer without <|end_think|> never thinks: the first token is a legal move.
{
  const t3v = JSON.parse(readFileSync(new URL('../src/chessmind/fixtures/tokenizer-v3.json', import.meta.url), 'utf8'));
  const t3 = new ChessTokenizer(t3v.chess_vocab, t3v.bpe);
  const c = new ThinkMoveConstraint(t3, undefined, true);
  check('no <|end_think|>: think ignored', c.think === false && c.allowedIds().length === 20 && !c.allowedIds().includes(t3.thinkId));
}

console.log(`${fx.sequences.length} row sequences, ${fx.walks.length} walks: ${total - fail}/${total} think-move checks passed`);
process.exit(fail ? 1 : 0);
