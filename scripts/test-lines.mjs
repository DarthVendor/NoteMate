// Tests of ChessMind answer lines with branches in the move tree (src/chessmind/lineTree.ts): "play through / keep"
// inserts the main line and every branch as real variations; chip paths map to their nodes; Discard removes them.
// Usage: node scripts/test-lines.mjs   (Node >= 23: imports the TypeScript sources directly)
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

const { gameReducer, initialGameState, mainLineIds } = await import('../src/state/gameReducer.ts');
const { planLineInsert, nodeAtPath, createdRoots } = await import('../src/chessmind/lineTree.ts');
const { displayLine, encodeLineTokens, lineText } = await import('../src/chessmind/lines.ts');
const { ROOT_ID } = await import('../src/types.ts');

let fail = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};
const sans = (s) => [...mainLineIds(s)].slice(1).map((id) => s.nodes[id].san).join(' ');
const kids = (s, id) => s.nodes[id].children.map((c) => s.nodes[c].san);

// 1.e4 e5 (1...c5 2.Nf3 (2.c3 d5) 2...d6) (1...e6) 2.Nf3 Nc6
const line = {
  kind: 'line',
  moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
  branches: [
    { at: 1, moves: ['c7c5', 'g1f3', 'd7d6'], branches: [{ at: 1, moves: ['c2c3', 'd7d5'] }] },
    { at: 1, moves: ['e7e6'] },
  ],
};
let n = 0;
const mkId = () => `n${++n}`;
let s = initialGameState();
const plan = planLineInsert(s, ROOT_ID, line, mkId, 2);
check('plan exists', !!plan);
for (const a of plan.actions) s = gameReducer(s, a);
check('main line is the main line', sans(s) === 'e4 e5 Nf3 Nc6', sans(s));
const e4 = plan.state.ids[0];
check('branches are variations of 1...e5', JSON.stringify(kids(s, e4)) === JSON.stringify(['e5', 'c5', 'e6']), kids(s, e4).join());
const c5 = s.nodes[e4].children[1];
check('nested branch under 1...c5', JSON.stringify(kids(s, c5)) === JSON.stringify(['Nf3', 'c3']), kids(s, c5).join());
check('board ends at the main line goto', s.currentId === plan.state.ids[1]);
check('three branch variations recorded', plan.state.branches?.length === 3);
const d5 = nodeAtPath(line, plan.state, [1, 0, 1, 0, 1]);
check('chip path -> node', d5 && s.nodes[d5].san === 'd5' && s.nodes[s.nodes[d5].parent].san === 'c3');
check('main chip path -> node', nodeAtPath(line, plan.state, [3]) === plan.state.ids[3]);
// Inserting again creates nothing.
const again = planLineInsert(s, ROOT_ID, line, mkId, 0);
check('re-insert reuses every node', again.state.created.every((c) => !c) && again.state.branches.every((b) => b.created.every((c) => !c)));
// Discard: deleting the created roots removes all of it.
for (const id of createdRoots(plan.state)) if (s.nodes[id]) s = gameReducer(s, { type: 'DELETE_FROM', id });
check('discard empties the tree', s.nodes[ROOT_ID].children.length === 0, JSON.stringify(s.nodes[ROOT_ID]));
// An existing game: the branches hang off its moves.
s = initialGameState();
for (const [from, to] of [['e2', 'e4'], ['e7', 'e5']]) s = gameReducer(s, { type: 'MAKE_MOVE', from, to });
const p2 = planLineInsert(s, ROOT_ID, line, mkId, 0);
for (const a of p2.actions) s = gameReducer(s, a);
check('existing moves reused', !p2.state.created[0] && !p2.state.created[1] && p2.state.created[2]);
check('goto 0 returns to the origin', s.currentId === ROOT_ID);
// Display + markers
const disp = displayLine(line);
check('display main chips', disp.chips.map((c) => c.num + c.san).join(' ') === '1.e4 e5 2.Nf3 Nc6');
const perpetual = { moves: ['e1e8', 'h8h7', 'e8e4', 'h7h8', 'e4e8'] };
const fen = '7k/6p1/7p/8/8/8/r4PPP/4Q1K1 w - - 0 1';
check('perpetual marker', encodeLineTokens(perpetual, fen).at(-1) === '<|repetition|>');
check('line text', lineText(line) === '1.e4 e5 (1...c5 2.Nf3 (2.c3 d5) 2...d6) (1...e6) 2.Nf3 Nc6', lineText(line));
check('line text marker', lineText({ ...perpetual, end: 'repetition' }, fen).endsWith('[draw by repetition]'));
const checkLine = { moves: ['e2e4', 'f7f5', 'd1h5'], branches: [{ at: 2, moves: ['d2d4'] }] };
check('check follows the move, before its branch', JSON.stringify(encodeLineTokens(checkLine)) === JSON.stringify(['e2e4', 'f7f5', 'd1h5', '<|check|>', '<|branch|>', 'd2d4', '<|end_branch|>']));
check('mate shows as # without a label', lineText({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], end: 'mate' }) === '1.f3 e5 2.g4 Qh4#');
console.log(`${total - fail}/${total} line-tree checks passed`);
process.exit(fail ? 1 : 0);
