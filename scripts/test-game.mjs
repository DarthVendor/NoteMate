// Tests of the game reducer's erase / restore actions (ERASE, RESTORE_TREE).
// Usage: node scripts/test-game.mjs   (Node >= 23: imports the TypeScript sources directly)
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

const { gameReducer, initialGameState, eraseCounts, mainLineIds, isMainLine } = await import('../src/state/gameReducer.ts');

let fail = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};
const play = (s, from, to) => gameReducer(s, { type: 'MAKE_MOVE', from, to });
const sans = (s) => [...mainLineIds(s)].slice(1).map((id) => s.nodes[id].san).join(' ');

// Main line 1.e4 e5 2.Nf3 Nc6, side lines 1...c5 2.Nf3 and 2.Bc4, a note on e5 and one on c5, arrows on both lines.
let s = initialGameState();
s = play(s, 'e2', 'e4');
const e4 = s.currentId;
s = play(s, 'e7', 'e5');
const e5 = s.currentId;
s = gameReducer(s, { type: 'ADD_NOTE', color: 'yellow', text: 'main note' });
s = gameReducer(s, { type: 'TOGGLE_ARROW', arrow: { from: 'g1', to: 'f3', color: 'green' } });
s = play(s, 'g1', 'f3');
s = play(s, 'b8', 'c6');
s = gameReducer(s, { type: 'TOGGLE_HIGHLIGHT', highlight: { square: 'e5', color: 'red' } });
s = gameReducer(s, { type: 'GOTO', id: e5 });
s = play(s, 'f1', 'c4');
const bc4 = s.currentId;
s = gameReducer(s, { type: 'GOTO', id: e4 });
s = play(s, 'c7', 'c5');
s = gameReducer(s, { type: 'ADD_NOTE', color: 'chessmind', text: 'side note' });
s = gameReducer(s, { type: 'ADD_ARROWS', arrows: [{ from: 'g1', to: 'f3', color: 'chessmind', opacity: 0.5 }] });
s = play(s, 'g1', 'f3');
const sideLeaf = s.currentId;

check('setup: main line', sans(s) === 'e4 e5 Nf3 Nc6', sans(s));
const before = eraseCounts(s);
check('eraseCounts: side moves', before.sideMoves === 3, JSON.stringify(before));
check('eraseCounts: shapes', before.shapes === 3, JSON.stringify(before));

// Erase side lines from inside a side line.
const v = gameReducer(s, { type: 'ERASE', scope: 'variations' });
check('variations: node count', Object.keys(v.nodes).length === 5, String(Object.keys(v.nodes).length));
check('variations: main line kept', sans(v) === 'e4 e5 Nf3 Nc6', sans(v));
check('variations: every node is on the main line', Object.keys(v.nodes).every((id) => isMainLine(v, id)));
check('variations: no dangling children', Object.values(v.nodes).every((n) => n.children.every((c) => v.nodes[c])));
check('variations: current moves to nearest main-line ancestor', v.currentId === e4, v.currentId);
check('variations: main-line note kept', v.nodes[e5].annotation?.notes[0]?.text === 'main note');
check('variations: main-line arrows kept', v.nodes[e5].annotation?.arrows.length === 1);
check('variations: side-line node gone', !v.nodes[sideLeaf] && !v.nodes[bc4]);
check('variations: nothing more to erase', eraseCounts(v).sideMoves === 0);
check('variations: idempotent (same object)', gameReducer(v, { type: 'ERASE', scope: 'variations' }) === v);
check('variations: chat untouched', v.chat === s.chat);

// Current node already on the main line stays put.
const onMain = gameReducer(gameReducer(s, { type: 'GOTO', id: e5 }), { type: 'ERASE', scope: 'variations' });
check('variations: current on main line stays', onMain.currentId === e5);

// Erase shapes everywhere.
const sh = gameReducer(s, { type: 'ERASE', scope: 'shapes' });
check('shapes: tree unchanged', Object.keys(sh.nodes).length === Object.keys(s.nodes).length && sh.currentId === s.currentId);
check('shapes: no arrows or highlights left', eraseCounts(sh).shapes === 0);
check('shapes: notes kept', sh.nodes[e5].annotation?.notes.length === 1 && Object.values(sh.nodes).filter((n) => n.annotation?.notes.length).length === 2);
check('shapes: empty annotations dropped', Object.values(sh.nodes).every((n) => !n.annotation || n.annotation.notes.length > 0));
check('shapes: pinned model arrows removed', !Object.values(sh.nodes).some((n) => n.annotation?.arrows.some((a) => a.color === 'chessmind')));
check('shapes: idempotent', gameReducer(sh, { type: 'ERASE', scope: 'shapes' }) === sh);

// Erase everything.
const all = gameReducer(s, { type: 'ERASE', scope: 'all' });
check('all: only the main line', Object.keys(all.nodes).length === 5 && sans(all) === 'e4 e5 Nf3 Nc6');
check('all: no shapes', eraseCounts(all).shapes === 0);
check('all: main-line note kept', all.nodes[e5].annotation?.notes[0]?.text === 'main note');

// Undo restores the tree and the position, keeping later chat.
const withChat = gameReducer(all, { type: 'CHAT_APPEND', messages: [{ id: 'c1', role: 'user', kind: 'command', parts: [{ kind: 'text', text: 'hi' }] }] });
const undone = gameReducer(withChat, { type: 'RESTORE_TREE', nodes: s.nodes, currentId: s.currentId });
check('restore: tree back', undone.nodes === s.nodes && undone.currentId === sideLeaf);
check('restore: chat kept', undone.chat?.length === 1);
check('restore: bad snapshot ignored', gameReducer(s, { type: 'RESTORE_TREE', nodes: {}, currentId: 'x' }) === s);

// Empty game.
const empty = initialGameState();
check('empty: erase is a no-op', gameReducer(empty, { type: 'ERASE', scope: 'all' }) === empty);

console.log(`${total - fail}/${total} game reducer checks passed`);
if (fail) process.exit(1);
