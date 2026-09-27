// End-to-end test: the unpacked extension in Chromium (Playwright), chess.com pages from test/fixtures
// (served at www.chess.com URLs), the REAL public API for a player's latest game, and NoteMate at NOTEMATE_URL.
//
//   npm run host   # NoteMate on :4173 (in another terminal)
//   PLAYWRIGHT_DIR=<dir with node_modules/playwright> [CHROMIUM_PATH=...] [CHESSCOM_USER=hikaru] \
//     [SHOTS=/tmp/nm-shots] node extension/test/e2e.mjs
//
// No login or credentials: the public API needs none. Stockfish runs once per position at depth 10 (single thread).
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR.replace(/\/$/, '')}/` : import.meta.url);
const { chromium } = req('playwright');
const EXT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const FIX = `${EXT}/test/fixtures`;
const SHOTS = `${(process.env.SHOTS ?? path.join(tmpdir(), 'notemate-e2e-shots')).replace(/\/$/, '')}/`;
mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROMIUM_PATH || undefined;
const USER = process.env.CHESSCOM_USER || 'hikaru';
const NOTEMATE = process.env.NOTEMATE_URL || 'http://localhost:4173/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// The player's latest month from the public API (one archive list + one month, serially).
const api = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};
const archives = (await api(`https://api.chess.com/pub/player/${USER.toLowerCase()}/games/archives`)).archives;
const month = await api(archives[archives.length - 1]);
month.games.sort((a, b) => a.end_time - b.end_time);
const latest = month.games[month.games.length - 1];
const GAME = latest.url.match(/\d+$/)[0];
const recentIds = month.games.slice(-3).map((g) => g.url.match(/\d+$/)[0]);
const [W, B] = [latest.white.username, latest.black.username];

const swap = (html) => html.replaceAll('NoteMateTester', USER === W.toLowerCase() ? W : B).replaceAll('OpponentGuy', USER === W.toLowerCase() ? B : W);
const pages = {
  [`/game/live/${GAME}`]: null, // set per step
  [`/games/archive/${USER}`]: swap(readFileSync(`${FIX}/archive.html`, 'utf8'))
    .replace('111111111', recentIds[2]).replace('222222222', recentIds[1]).replace('/game/daily/', '/game/live/').replace('111111111', recentIds[2]),
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'nm-ext-')), {
  executablePath: CHROME,
  headless: true,
  // Headless Chrome announces itself as HeadlessChrome, which Cloudflare in front of api.chess.com rejects (403).
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--user-agent=${UA}`],
  viewport: { width: 1440, height: 900 },
});
const errors = [];
ctx.on('weberror', (e) => errors.push(String(e.error())));
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const id = sw.url().split('/')[2];
log('extension', id);

// chess.com pages come from the fixtures; api.chess.com is the real public API.
let gamePage = 'live-in-progress.html';
await ctx.route('https://www.chess.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === `/game/live/${GAME}`) return route.fulfill({ contentType: 'text/html', body: swap(readFileSync(`${FIX}/${gamePage}`, 'utf8')) });
  if (pages[u.pathname]) return route.fulfill({ contentType: 'text/html', body: pages[u.pathname] });
  return route.fulfill({ status: 404, body: '' });
});

// Options: username + NoteMate URL.
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${id}/options/options.html`);
await opt.fill('#username', USER);
await opt.fill('#noteMateUrl', NOTEMATE);
await opt.click('button[type=submit]');
await opt.waitForSelector('#status:text("Saved.")');
await opt.setViewportSize({ width: 720, height: 640 });
await opt.screenshot({ path: `${SHOTS}options.png` });
await opt.close();

// 1) A game in progress: no button, popup refuses.
const cc = await ctx.newPage();
await cc.goto(`https://www.chess.com/game/live/${GAME}`);
await cc.waitForTimeout(3500);
const chipDuringGame = await cc.locator('[data-notemate-chip]').count();
log('chip during game:', chipDuringGame);
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 340, height: 560 });
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
await popup.waitForTimeout(800);
const bannerDuringGame = await popup.locator('#fairplay').isVisible();
const lastDisabled = await popup.locator('#last').isDisabled();
log('popup banner during game:', bannerDuringGame, 'last disabled:', lastDisabled);
await popup.screenshot({ path: `${SHOTS}popup-during-game.png` });
const refused = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'analyze', last: true }));
log('analyze during game:', JSON.stringify(refused));
await popup.close();

// 2) The game ends: the game-over modal appears (same URL, SPA-style: swap the DOM).
gamePage = 'live-finished-modal.html';
await cc.goto(`https://www.chess.com/game/live/${GAME}`);
const t0 = Date.now();
await cc.waitForSelector('[data-notemate-chip]', { timeout: 10000, state: 'attached' });
log('chip appeared after', Date.now() - t0, 'ms');
await cc.screenshot({ path: `${SHOTS}chesscom-button.png` });
// A new game starting hides it at once.
await cc.evaluate(() => {
  const c = document.querySelector('.clock-bottom');
  c.classList.add('clock-player-turn');
});
await cc.waitForTimeout(1200);
const chipAfterRematch = await cc.locator('[data-notemate-chip]').count();
log('chip after a new clock starts:', chipAfterRematch);
await cc.evaluate(() => document.querySelector('.clock-bottom').classList.remove('clock-player-turn'));
await cc.waitForSelector('[data-notemate-chip]', { timeout: 10000, state: 'attached' });

// 3) Click: NoteMate opens with the game.
const pageEvent = ctx.waitForEvent('page', { timeout: 30000 });
await cc.locator('[data-notemate-chip] button.go').click();
await cc.waitForTimeout(4000);
log('chip message:', await cc.locator('[data-notemate-chip] .msg').evaluate((e) => (e.hidden ? '(none)' : e.textContent)));
const nm = await pageEvent;
nm.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
await nm.waitForLoadState();
await nm.waitForSelector('[data-testid=toast]', { timeout: 20000 });
const toast = await nm.locator('[data-testid=toast]').innerText();
log('toast:', toast, '| url:', nm.url().slice(0, 60));
const title = await nm.locator('.game-title').innerText();
const sub = await nm.locator('.game-sub').innerText();
const bottom = await nm.locator('.player-bottom').innerText();
log('title:', title.replace(/\n/g, ' '), '| sub:', sub, '| bottom player:', bottom);
// Review runs (depth 10); wait for the summary.
await nm.waitForSelector('[data-testid=review-summary]', { timeout: 180000 });
const summary = await nm.locator('[data-testid=review-summary]').innerText();
log('review summary:', summary.replace(/\s+/g, ' '));
const flagged = await nm.locator('[data-testid=review-moves] li').count();
log('flagged moves:', flagged);
// Go to the first flagged move so the note shows.
if (flagged) await nm.locator('[data-testid=review-moves] li button').first().click();
await nm.waitForTimeout(2500);
const engineOn = await nm.locator('.eval-bar:not(.placeholder)').count();
log('engine on (eval bar):', engineOn > 0);
await nm.screenshot({ path: `${SHOTS}notemate-imported.png` });

// 4) Popup: recent games, analyse another one (reuses the NoteMate tab).
const pages0 = ctx.pages().length;
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 340, height: 600 });
await pop.goto(`chrome-extension://${id}/popup/popup.html`);
await pop.waitForSelector('.games li', { timeout: 20000 });
log('popup games:', await pop.locator('.games li').count());
await pop.screenshot({ path: `${SHOTS}popup.png` });
const second = pop.locator('.games li').nth(1);
const secondId = await second.getAttribute('data-game-id');
await second.locator('button').click();
await nm.waitForFunction((gid) => document.querySelector('.game-sub a')?.getAttribute('href')?.endsWith(gid), secondId, { timeout: 20000 });
log('second game imported into the same tab:', secondId, '| pages', pages0, '->', ctx.pages().length);

// 5) Archive page buttons.
const ar = await ctx.newPage();
await ar.goto(`https://www.chess.com/games/archive/${USER}`);
await ar.waitForSelector('[data-notemate-archive]', { timeout: 10000 });
log('archive buttons:', await ar.locator('[data-notemate-archive]').count());
await ar.setViewportSize({ width: 900, height: 300 });
await ar.screenshot({ path: `${SHOTS}archive-buttons.png` });

// Restore command exists in NoteMate (history).
await nm.bringToFront();
await nm.keyboard.press('Meta+k');
await nm.keyboard.type('Restore earlier');
await nm.waitForTimeout(400);
log('restore commands:', await nm.locator('[role=option]').count());
await nm.keyboard.press('Escape');

log('errors:', errors.length ? errors : 'none');
log('screenshots in', SHOTS);
await ctx.close();
const ok = chipDuringGame === 0 && bannerDuringGame && refused?.fairPlay && chipAfterRematch === 0 && /Imported from chess\.com/.test(toast) && engineOn > 0 && errors.length === 0;
console.log(ok ? 'E2E OK' : 'E2E FAILED');
process.exit(ok ? 0 : 1);
