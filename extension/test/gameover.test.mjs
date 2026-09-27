// Game-over detection on chess.com-like DOM snippets (fixtures/*.html), in a real browser via Playwright.
// Run: PLAYWRIGHT_DIR=<dir with node_modules/playwright> node --test extension/test/
// (skipped when Playwright cannot be found; CHROMIUM_PATH picks a browser binary).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fixture } from './load.mjs';

let chromium = null;
try {
  const req = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR.replace(/\/$/, '')}/` : import.meta.url);
  ({ chromium } = req('playwright'));
} catch {
  chromium = null;
}

const lib = readFileSync(new URL('../lib/gameover.js', import.meta.url), 'utf8');

const CASES = [
  ['live-in-progress.html', 'playing'],
  ['live-finished-modal.html', 'finished'],
  ['live-finished-result-only.html', 'finished'],
  ['rematch-started.html', 'playing'],
  ['hidden-modal.html', 'unknown'],
  ['daily-in-progress.html', 'unknown'],
  ['spectating-live.html', 'playing'],
  ['modal-and-resign.html', 'playing'],
  ['home.html', 'unknown'],
  ['archive.html', 'unknown'],
];

test('game-over detection on chess.com fixtures', { skip: !chromium && 'Playwright not found (set PLAYWRIGHT_DIR)' }, async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    for (const [file, want] of CASES) {
      await t.test(`${file} -> ${want}`, async () => {
        await page.setContent(fixture(file));
        await page.addScriptTag({ content: lib });
        const r = await page.evaluate(() => self.NoteMateGameOver.detectGameState(document));
        assert.equal(r.state, want, `${file}: ${r.reason}`);
      });
    }

    await t.test('result text is normalised; the finished state flips to playing when a new game starts', async () => {
      await page.setContent(fixture('live-finished-result-only.html'));
      await page.addScriptTag({ content: lib });
      assert.equal(await page.evaluate(() => self.NoteMateGameOver.detectGameState(document).result), '1/2-1/2');
      const after = await page.evaluate(() => {
        const b = document.createElement('button');
        b.className = 'resign-button-component';
        b.textContent = 'Resign';
        document.body.appendChild(b);
        return self.NoteMateGameOver.detectGameState(document).state;
      });
      assert.equal(after, 'playing');
    });

    await t.test('archive links and username', async () => {
      await page.setContent(fixture('archive.html'));
      await page.addScriptTag({ content: lib });
      const r = await page.evaluate(() => ({
        links: self.NoteMateGameOver.archiveGameLinks(document).map((x) => x.ref),
        user: self.NoteMateGameOver.detectUsername(document),
      }));
      assert.deepEqual(r.links, [{ type: 'live', id: '111111111' }, { type: 'daily', id: '222222222' }]);
      assert.equal(r.user, 'NoteMateTester');
    });
  } finally {
    await browser.close();
  }
});

test('game ids from chess.com URLs', async () => {
  const { loadLib } = await import('./load.mjs');
  const G = loadLib('lib/gameover.js').NoteMateGameOver;
  const ref = (u) => {
    const r = G.gameRefFromUrl(u);
    return r ? { type: r.type, id: r.id } : null;
  };
  assert.deepEqual(ref('https://www.chess.com/game/live/184472936366'), { type: 'live', id: '184472936366' });
  assert.deepEqual(ref('https://www.chess.com/game/daily/123?move=4'), { type: 'daily', id: '123' });
  assert.deepEqual(ref('https://www.chess.com/analysis/game/live/55/review'), { type: 'live', id: '55' });
  assert.deepEqual(ref('https://www.chess.com/live/game/77'), { type: 'live', id: '77' });
  assert.deepEqual(ref('https://www.chess.com/live#g=88'), { type: 'live', id: '88' });
  assert.deepEqual(ref('https://www.chess.com/game/99'), { type: null, id: '99' });
  assert.equal(ref('https://www.chess.com/play/online'), null);
  assert.equal(ref('https://evil.example/game/live/1'), null);
  assert.equal(G.isArchivePage('https://www.chess.com/games/archive/hikaru'), true);
  assert.equal(G.isArchivePage('https://www.chess.com/games'), false);
});
