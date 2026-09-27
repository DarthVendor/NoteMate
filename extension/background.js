/*
 * Background (Chrome: service worker; Firefox: event page). Talks to chess.com's public API, keeps the
 * fair-play state of chess.com tabs, and opens games in NoteMate.
 *
 * Fair play: every request to analyse a game is refused while any chess.com tab reported a game in progress
 * in the last PLAYING_TTL ms (content scripts refresh that report every few seconds while it lasts). Only
 * games found in chess.com's public archive, which holds finished games only, are ever opened.
 */
/* global importScripts, NoteMateChessComApi, NoteMateHandoff, NoteMateSettings */
if (typeof importScripts === 'function' && typeof NoteMateChessComApi === 'undefined') {
  importScripts('lib/settings.js', 'lib/chesscom-api.js', 'lib/handoff.js');
}

const ext = NoteMateSettings.ext();
const PLAYING_TTL = 30 * 1000;
const sessionStore = ext.storage.session || null;
const api = NoteMateChessComApi.createApi({
  fetch: (url, init) => fetch(url, init),
  store: sessionStore,
});

/* ---------- fair-play state of chess.com tabs ---------- */

async function readTabStates() {
  if (!sessionStore) return memTabStates;
  try {
    return (await sessionStore.get('tabStates')).tabStates || {};
  } catch {
    return memTabStates;
  }
}
let memTabStates = {};
async function writeTabStates(states) {
  memTabStates = states;
  if (sessionStore) await sessionStore.set({ tabStates: states }).catch(() => {});
}

async function setTabState(tabId, state, url) {
  const states = await readTabStates();
  states[tabId] = { state, url, at: Date.now() };
  await writeTabStates(states);
}

/** chess.com tabs that showed a game in progress recently (closed tabs are dropped). */
async function playingTabs() {
  const states = await readTabStates();
  const out = [];
  let changed = false;
  for (const [id, s] of Object.entries(states)) {
    if (s.state !== 'playing' || Date.now() - s.at > PLAYING_TTL) continue;
    try {
      await ext.tabs.get(Number(id));
      out.push(Number(id));
    } catch {
      delete states[id];
      changed = true;
    }
  }
  if (changed) await writeTabStates(states);
  return out;
}

ext.tabs.onRemoved.addListener(async (tabId) => {
  const states = await readTabStates();
  if (states[tabId]) {
    delete states[tabId];
    await writeTabStates(states);
  }
});

const FAIR_PLAY_MESSAGE = 'A chess.com game is in progress. NoteMate stays off until it has finished.';

/* ---------- analysing ---------- */

const USER_RE = NoteMateChessComApi.USERNAME_RE;

async function openInNoteMate(href, settings) {
  const base = NoteMateHandoff.normaliseBase(settings.noteMateUrl);
  if (settings.reuseTab) {
    let tabs = [];
    try {
      tabs = await ext.tabs.query({ url: new URL(base).origin + '/*' });
    } catch {
      tabs = [];
    }
    const tab = tabs.find((t) => t.url && t.url.split('#')[0] === base) || tabs[0];
    if (tab) {
      await ext.tabs.update(tab.id, { url: href, active: true });
      if (tab.windowId !== undefined) await ext.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return;
    }
  }
  await ext.tabs.create({ url: href });
}

/** Find a finished game by id in the archives of the user or of the players shown with it. */
async function gameById(gameId, names) {
  const tried = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (!USER_RE.test(name) || tried.includes(key)) continue;
    tried.push(key);
    const game = await api.findGame(name, gameId);
    if (game) return { game, archiveOf: name };
    if (tried.length >= 3) break;
  }
  return null;
}

/**
 * Open a finished game in NoteMate.
 * req: { gameId?: string, last?: boolean, players?: string[] } ; from: 'page' | 'archive' | 'popup'
 */
async function analyze(req, from, senderTab, senderUrl) {
  if ((await playingTabs()).length) return { ok: false, error: FAIR_PLAY_MESSAGE, fairPlay: true };
  if (from === 'archive' && !/^https:\/\/(www\.)?chess\.com\/games\/archive(\/|\?|#|$)/.test(senderUrl || '')) return { ok: false, error: 'Not a game-archive page.' };
  if (from === 'page') {
    // The button's own tab must have reported a finished game.
    const s = (await readTabStates())[senderTab?.id];
    if (!s || s.state !== 'finished') return { ok: false, error: 'This page does not show a finished game.', fairPlay: true };
  }
  const settings = await NoteMateSettings.getSettings();
  const user = settings.effectiveUsername;
  const players = (req.players || []).filter((p) => typeof p === 'string');
  let game = null;
  if (req.gameId && /^\d+$/.test(String(req.gameId))) {
    const found = await gameById(String(req.gameId), [user, ...players].filter(Boolean));
    if (!found) {
      if (!user && !players.length) return { ok: false, error: 'Set your chess.com username in the extension options.' };
      return { ok: false, error: "This game is not in chess.com's public archive yet. Finished games appear there within a minute or so; try again shortly." };
    }
    game = found.game;
  } else if (req.last) {
    if (!user) return { ok: false, error: 'Set your chess.com username in the extension options.' };
    const recent = await api.recentGames(user, 5);
    const wanted = players.map((p) => p.toLowerCase());
    game =
      wanted.length === 2
        ? recent.find((g) => wanted.includes((g.white?.username || '').toLowerCase()) && wanted.includes((g.black?.username || '').toLowerCase()))
        : recent[0];
    if (!game) return { ok: false, error: wanted.length === 2 ? "This game is not in chess.com's public archive yet; try again in a minute." : `No finished games found for ${user}.` };
  } else {
    return { ok: false, error: 'No game given.' };
  }
  const why = NoteMateChessComApi.unusableReason(game);
  if (why) return { ok: false, error: `Cannot analyse this game: ${why}.` };
  // Check once more right before handing over: a game may have started meanwhile.
  if ((await playingTabs()).length) return { ok: false, error: FAIR_PLAY_MESSAGE, fairPlay: true };
  const players2 = [game.white?.username, game.black?.username].map((x) => (x || '').toLowerCase());
  const importer = user && players2.includes(user.toLowerCase()) ? user : players.find((p) => players2.includes(p.toLowerCase())) || undefined;
  const href = await NoteMateHandoff.buildImportUrl(settings.noteMateUrl, { pgn: game.pgn, user: importer, url: game.url });
  await openInNoteMate(href, settings);
  return { ok: true, game: NoteMateChessComApi.summarize(game, importer || user) };
}

async function recent(username, n) {
  const settings = await NoteMateSettings.getSettings();
  const user = (username || settings.effectiveUsername || '').trim();
  if (!user) return { ok: false, error: 'Set your chess.com username.', needUser: true };
  const games = await api.recentGames(user, n || 10);
  return { ok: true, user, games: games.map((g) => NoteMateChessComApi.summarize(g, user)) };
}

/* ---------- messages ---------- */

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    switch (msg && msg.type) {
      case 'page-state':
        if (sender.tab?.id !== undefined && ['playing', 'finished', 'unknown'].includes(msg.state)) await setTabState(sender.tab.id, msg.state, sender.url);
        return { ok: true };
      case 'detected-user': {
        if (!USER_RE.test(msg.username || '')) return { ok: false };
        const got = await ext.storage.local.get('detectedUsername');
        if (got.detectedUsername !== msg.username) await ext.storage.local.set({ detectedUsername: msg.username });
        return { ok: true };
      }
      case 'status': {
        const playing = (await playingTabs()).length > 0;
        return { ok: true, playing, settings: await NoteMateSettings.getSettings() };
      }
      case 'recent':
        if ((await playingTabs()).length) return { ok: false, error: FAIR_PLAY_MESSAGE, fairPlay: true };
        return recent(msg.username, msg.n);
      case 'analyze': {
        // Extension pages (the popup, also when opened in a tab) vs content scripts on chess.com.
        const own = !sender.tab || (sender.url || '').startsWith(ext.runtime.getURL(''));
        const from = own ? 'popup' : msg.from === 'archive' ? 'archive' : 'page';
        return analyze(msg, from, sender.tab, sender.url);
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true;
});
