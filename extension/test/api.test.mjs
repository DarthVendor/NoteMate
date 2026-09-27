// Unit tests of the chess.com API client and hand-off (mocked fetch). Run: node --test extension/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLib, fixture } from './load.mjs';

const month = JSON.parse(fixture('month.json'));
const ARCH = 'https://api.chess.com/pub/player/notematetester/games/archives';
const M09 = 'https://api.chess.com/pub/player/notematetester/games/2026/09';
const M08 = 'https://api.chess.com/pub/player/notematetester/games/2026/08';
const NOW = Date.UTC(2026, 8, 27, 12);

/** fetch mock: routes by URL, records calls and the maximum number of requests in flight. */
function mockFetch(routes) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    let route = routes[url];
    if (typeof route === 'function') route = route(calls.filter((c) => c.url === url).length);
    if (!route) return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
    const status = route.status ?? 200;
    return { ok: status < 400, status, headers: new Map(Object.entries(route.headers ?? {})), json: async () => route.body };
  };
  return { fetch, calls, get maxInFlight() { return maxInFlight; } };
}

const lib = loadLib('lib/chesscom-api.js').NoteMateChessComApi;
const mkApi = (m, extra = {}) => lib.createApi({ fetch: m.fetch, now: () => NOW, sleep: async () => {}, ...extra });

test('findGame: archives newest first, match by id, no credentials sent', async () => {
  const m = mockFetch({ [ARCH]: { body: { archives: [M08, M09] } }, [M09]: { body: month }, [M08]: { body: { games: [] } } });
  const api = mkApi(m);
  const g = await api.findGame('NoteMateTester', '111111111');
  assert.equal(g.url, 'https://www.chess.com/game/live/111111111');
  assert.deepEqual(m.calls.map((c) => c.url), [ARCH, M09]);
  assert.equal(m.calls[0].init.credentials, 'omit');
});

test('archive list is cached; month data briefly', async () => {
  const m = mockFetch({ [ARCH]: { body: { archives: [M09] } }, [M09]: { body: month } });
  const api = mkApi(m);
  await api.findGame('NoteMateTester', '111111111');
  await api.findGame('notematetester', '222222222');
  await api.recentGames('NoteMateTester', 5);
  assert.equal(m.calls.filter((c) => c.url === ARCH).length, 1);
  assert.equal(m.calls.filter((c) => c.url === M09).length, 1);
});

test('requests are serial even when called in parallel', async () => {
  const m = mockFetch({ [ARCH]: { body: { archives: [M08, M09] } }, [M09]: { body: month }, [M08]: { body: { games: [] } } });
  const api = mkApi(m);
  await Promise.all([api.recentGames('NoteMateTester', 10), api.findGame('NoteMateTester', '999'), api.archives('OtherGuy').catch(() => null)]);
  assert.equal(m.maxInFlight, 1);
});

test('a game not found refreshes the archive list once (new month)', async () => {
  const M10 = 'https://api.chess.com/pub/player/notematetester/games/2026/10';
  const newGame = { ...month.games[0], url: 'https://www.chess.com/game/live/444444444', end_time: 1790600000 };
  const m = mockFetch({
    [ARCH]: (n) => ({ body: { archives: n === 1 ? [M09] : [M09, M10] } }),
    [M09]: { body: month },
    [M10]: { body: { games: [newGame] } },
  });
  const api = mkApi(m);
  const g = await api.findGame('NoteMateTester', '444444444');
  assert.equal(g.url, newGame.url);
  assert.equal(m.calls.filter((c) => c.url === ARCH).length, 2);
  // Unknown ids come back null (no endless retries).
  assert.equal(await api.findGame('NoteMateTester', '555'), null);
});

test('429 is retried after a pause; 404 is an error', async () => {
  const m = mockFetch({ [ARCH]: (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '1' } } : { body: { archives: [M09] } }) });
  const slept = [];
  const api = mkApi(m, { sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(await api.archives('NoteMateTester'), [M09]);
  assert.deepEqual(slept, [1000]);
  await assert.rejects(() => mkApi(mockFetch({})).archives('nobody'), /Not found/);
});

test('usernames are validated before any request', async () => {
  const m = mockFetch({});
  const api = mkApi(m);
  await assert.rejects(() => api.archives(''), (e) => e.code === 'no-user');
  await assert.rejects(() => api.archives('../../x'), (e) => e.code === 'no-user');
  assert.equal(m.calls.length, 0);
});

test('recentGames is sorted newest first across months', async () => {
  const older = { ...month.games[1], url: 'https://www.chess.com/game/live/1', end_time: 1780000000 };
  const m = mockFetch({ [ARCH]: { body: { archives: [M08, M09] } }, [M09]: { body: { games: [month.games[1], month.games[0]] } }, [M08]: { body: { games: [older] } } });
  const games = await mkApi(m).recentGames('NoteMateTester', 3);
  assert.deepEqual([...games].map((g) => lib.gameIdOf(g)), ['111111111', '222222222', '1']);
});

test('summarize and unusableReason', () => {
  const s = lib.summarize(month.games[0], 'notematetester');
  assert.equal(s.id, '111111111');
  assert.equal(s.color, 'white');
  assert.equal(s.outcome, 'win');
  assert.equal(s.opponent, 'OpponentGuy');
  assert.equal(s.result, '1-0');
  assert.equal(lib.summarize(month.games[1], 'NoteMateTester').outcome, 'draw');
  assert.equal(lib.summarize(month.games[2], 'NoteMateTester').outcome, 'loss');
  assert.equal(lib.unusableReason(month.games[0]), null);
  assert.match(lib.unusableReason(month.games[2]), /chess960/);
  assert.match(lib.unusableReason({ ...month.games[0], pgn: month.games[0].pgn.replace('[Result "1-0"]', '[Result "*"]') }), /no final result/);
  assert.match(lib.unusableReason({ url: 'x' }), /no PGN/);
});

test('hand-off URL: fragment, compressed, round-trips', async () => {
  const h = loadLib('lib/handoff.js').NoteMateHandoff;
  const pgn = month.games[0].pgn.repeat(30);
  const href = await h.buildImportUrl('http://localhost:4173', { pgn, user: 'NoteMateTester', url: month.games[0].url });
  const u = new URL(href);
  assert.equal(u.origin + u.pathname, 'http://localhost:4173/');
  assert.equal(u.search, '');
  const params = new URLSearchParams(u.hash.slice(1));
  assert.equal(params.get('import'), 'chesscom');
  const d = params.get('d');
  assert.ok(d.length < pgn.length / 5, `compressed ${d.length} vs ${pgn.length}`);
  const bytes = Uint8Array.from(atob(d.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (d.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const json = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  assert.deepEqual(JSON.parse(json), { pgn, user: 'NoteMateTester', url: month.games[0].url });
  await assert.rejects(() => h.buildImportUrl('javascript:alert(1)', { pgn }), /http/);
});
