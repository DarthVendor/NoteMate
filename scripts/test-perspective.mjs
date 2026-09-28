// Parity of the perspective pieces (ChessMind chessmind/data/perspective.py, prompt_context.py, model/think_move.py)
// against src/chessmind/fixtures/perspective.json (ChessMind's scripts/perspective_fixture.py):
//   - context: contextText with the user's side ([You: White]) and the side-only position note (numbers=false), and
//     what parseContext reads back (move, white_to_play, you_white);
//   - anchors: the in-game think's anchor per side ("I'm playing White, and it's my move."), text and tokenizer-v4 ids;
//   - walks: ThinkMoveConstraint with anchorIds, the allowed ids and phase before every token of a forced think;
// plus the chat rule for the user's side (chatContext.ts: userSide).
// Usage: node scripts/test-perspective.mjs   (Node >= 23: imports the TypeScript sources directly)
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Chess } from 'chess.js';

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

const { contextText, parseContext } = await import('../src/chessmind/promptContext.ts');
const { ChessTokenizer } = await import('../src/chessmind/tokenizer.ts');
const { ThinkMoveConstraint, GAME_ANCHOR, anchorText, anchorIds } = await import('../src/chessmind/thinkMove.ts');
const { chatContext, userSide } = await import('../src/chessmind/chatContext.ts');

const load = (f) => JSON.parse(readFileSync(new URL(`../src/chessmind/fixtures/${f}`, import.meta.url), 'utf8'));
const fx = load('perspective.json');
const tv = load('tokenizer-v4.json');
const tok = new ChessTokenizer(tv.chess_vocab, tv.bpe);
let total = 0;
let fail = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, ok, detail = '') => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

// ------------------------------------------------------------------------------------------------ context
fx.context.forEach((c, i) => {
  const engine = c.engine ? { depth: c.engine.depth, lines: c.engine.lines.map((l) => ({ move: l.move, cp: l.cp, mate: l.mate, pv: l.pv })) } : null;
  const text = contextText(c.fen, { note: c.note, numbers: c.numbers, you: c.you, engine });
  check(`context ${i} text`, text === c.text, `\n  got  ${text}\n  want ${c.text}`);
  const p = parseContext(c.text);
  const got = { move: p.move, white_to_play: p.white_to_play, you_white: p.you_white };
  check(`context ${i} parse`, same(got, c.parsed), `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(c.parsed)}`);
});

// ------------------------------------------------------------------------------------------------ anchors
check('anchor template', GAME_ANCHOR === fx.anchor_template, GAME_ANCHOR);
for (const side of ['white', 'black']) {
  const a = fx.anchors[side];
  check(`anchor ${side} text`, anchorText(side === 'white') === a.text, anchorText(side === 'white'));
  const ids = anchorIds(tok, side === 'white');
  check(`anchor ${side} ids`, same(ids, a.ids), `${ids} vs ${a.ids}`);
}

// ------------------------------------------------------------------------------------------------ walks
const text = [];
for (let i = tok.textOffset; i < tok.extraOffset; i++) text.push(i);
const TEXT = JSON.stringify([...text, tok.lineId, tok.endThinkId].sort((a, b) => a - b));
const sorted = (ids) => [...ids].sort((a, b) => a - b);
for (const w of fx.walks) {
  const board = new Chess();
  for (const m of w.moves) board.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  const anchor = anchorIds(tok, board.turn() === 'w');
  check(`walk ${w.moves.length} anchor ids`, same(anchor, w.anchor));
  const c = new ThinkMoveConstraint(tok, board.fen(), true, 64, undefined, anchor);
  let bad = null;
  w.steps.forEach((s, i) => {
    if (bad) return;
    const got = sorted(c.allowedIds());
    const ok = s.allowed === 'TEXT' ? JSON.stringify(got) === TEXT : same(got, s.allowed);
    if (!ok) bad = `step ${i} allowed: ${got.length} ids ${got.slice(0, 8)} vs ${s.allowed === 'TEXT' ? 'TEXT' : s.allowed.slice(0, 8)}`;
    else if (c.phase !== s.phase) bad = `step ${i} phase ${c.phase} vs ${s.phase}`;
    else c.feed(s.feed);
  });
  check(`walk ${w.moves.length} plies`, bad === null, bad ?? '');
  check(`walk ${w.moves.length} final phase`, c.phase === w.final_phase, c.phase);
}
// without anchor ids the think text is free right after the side token (the pre-perspective behaviour)
{
  const c = new ThinkMoveConstraint(tok, undefined, true, 64);
  c.feed(tok.thinkId);
  c.feed(tok.whiteId);
  check('no anchor: free text', JSON.stringify(sorted(c.allowedIds())) === TEXT);
}

// ------------------------------------------------------------------------------------------------ chat: the user's side
check('side: explicit white', userSide('white', { orientation: 'black', simModelColor: 'w' }) === 'white');
check('side: explicit black', userSide('black', { orientation: 'white', simModelColor: null }) === 'black');
check('side: off', userSide('off', { orientation: 'black', simModelColor: 'w' }) === null);
check('side: auto -> orientation', userSide('auto', { orientation: 'black', simModelColor: null }) === 'black');
check('side: auto -> simulate non-model colour', userSide('auto', { orientation: 'white', simModelColor: 'w' }) === 'black');
const blackFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const ctx = chatContext({ fen: blackFen, engine: null, candidates: [{ uci: 'e7e5', p: 0.6 }], sendEngine: true, sendCandidates: true, you: 'white' });
check('chat context with you', ctx === '[Position: move 1, Black to play] [You: White] [Candidates: 1...e5 60%]', ctx);

console.log(`${fx.context.length} context cases, ${fx.walks.length} walks: ${total - fail}/${total} perspective checks passed`);
process.exit(fail ? 1 : 0);
