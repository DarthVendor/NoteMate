/*
 * chess.com's official public API (https://www.chess.com/news/view/published-data-api), read-only, no login.
 *
 *   GET https://api.chess.com/pub/player/{user}/games/archives   -> { archives: [monthUrl, ...] } (oldest first)
 *   GET {monthUrl}                                               -> { games: [{ url, pgn, end_time, white, black, ... }] }
 *
 * The monthly archives hold FINISHED games only, which is the second fair-play check: a game that is still
 * being played cannot be found here. Requests are made one at a time (chess.com asks for serial access and
 * answers parallel bursts with 429), the archive list is cached (1 h, refreshed when a game is not found),
 * and month data is cached for a short while in memory.
 */
(function (root) {
  'use strict';

  var API = 'https://api.chess.com/pub';
  var ARCHIVES_TTL = 60 * 60 * 1000;
  var MONTH_TTL = 30 * 1000;
  var OLD_MONTH_TTL = 6 * 60 * 60 * 1000;
  var USERNAME_RE = /^[A-Za-z0-9_-]{2,40}$/;
  var FINAL_RESULTS = { '1-0': 1, '0-1': 1, '1/2-1/2': 1 };
  var DRAWS = { agreed: 1, repetition: 1, stalemate: 1, insufficient: 1, '50move': 1, timevsinsufficient: 1 };

  function ApiError(message, code) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /** In-memory cache with expiry; `store` (optional) persists entries, e.g. chrome.storage.session. */
  function makeCache(store) {
    var mem = new Map();
    return {
      get: async function (key, now) {
        var hit = mem.get(key);
        if (!hit && store) {
          try {
            var got = await store.get(key);
            hit = got && got[key];
            if (hit) mem.set(key, hit);
          } catch {
            hit = null;
          }
        }
        return hit && hit.expires > now ? hit.value : undefined;
      },
      set: async function (key, value, ttl, now, persist) {
        var entry = { value: value, expires: now + ttl };
        mem.set(key, entry);
        if (store && persist) {
          var o = {};
          o[key] = entry;
          try {
            await store.set(o);
          } catch {
            /* quota: the memory copy still works */
          }
        }
      },
      delete: async function (key) {
        mem.delete(key);
        if (store) {
          try {
            await store.remove(key);
          } catch {
            /* ignore */
          }
        }
      },
    };
  }

  /**
   * @param {{ fetch: typeof fetch, store?: { get, set, remove }, now?: () => number, sleep?: (ms) => Promise<void> }} opts
   */
  function createApi(opts) {
    var doFetch = opts.fetch;
    var now = opts.now || Date.now;
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var cache = makeCache(opts.store);
    var chain = Promise.resolve();
    var stats = { requests: 0 };

    /** Run `fn` after every earlier request has finished (serial access). */
    function serial(fn) {
      var p = chain.then(fn, fn);
      chain = p.then(function () {}, function () {});
      return p;
    }

    function getJson(url) {
      return serial(async function () {
        for (var attempt = 0; ; attempt++) {
          stats.requests++;
          var res;
          try {
            res = await doFetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit' });
          } catch {
            throw ApiError('Could not reach api.chess.com (' + (e && e.message ? e.message : 'network error') + ')', 'network');
          }
          if (res.status === 429 && attempt < 2) {
            var wait = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
            await sleep(Math.min(10, wait > 0 ? wait : 2 + attempt * 3) * 1000);
            continue;
          }
          if (res.status === 404) throw ApiError('Not found on chess.com: ' + url.replace(API, ''), 'not-found');
          if (res.status === 410) throw ApiError('chess.com has no data for this player', 'gone');
          if (!res.ok) throw ApiError('chess.com API error ' + res.status, 'http');
          return res.json();
        }
      });
    }

    function checkUser(user) {
      var u = String(user || '').trim();
      if (!USERNAME_RE.test(u)) throw ApiError('Set your chess.com username first', 'no-user');
      return u.toLowerCase();
    }

    /** Month archive URLs, newest first. */
    async function archives(user, fresh) {
      var u = checkUser(user);
      var key = 'archives:' + u;
      if (!fresh) {
        var hit = await cache.get(key, now());
        if (hit) return hit;
      }
      var data = await getJson(API + '/player/' + encodeURIComponent(u) + '/games/archives');
      var list = (data && Array.isArray(data.archives) ? data.archives : []).filter(function (x) {
        return typeof x === 'string' && x.indexOf(API + '/player/') === 0;
      });
      list.reverse();
      await cache.set(key, list, ARCHIVES_TTL, now(), true);
      return list;
    }

    function isCurrentMonth(monthUrl) {
      var m = /\/(\d{4})\/(\d{2})$/.exec(monthUrl);
      if (!m) return true;
      var d = new Date(now());
      return Number(m[1]) === d.getUTCFullYear() && Number(m[2]) === d.getUTCMonth() + 1;
    }

    /** Games of one month, newest first. */
    async function monthGames(monthUrl) {
      var key = 'month:' + monthUrl;
      var hit = await cache.get(key, now());
      if (hit) return hit;
      var data = await getJson(monthUrl);
      var games = (data && Array.isArray(data.games) ? data.games : []).slice();
      games.sort(function (a, b) { return (b.end_time || 0) - (a.end_time || 0); });
      // Month data can be megabytes: kept in memory only.
      await cache.set(key, games, isCurrentMonth(monthUrl) ? MONTH_TTL : OLD_MONTH_TTL, now(), false);
      return games;
    }

    /** The newest `n` games of a player (looks at up to `maxMonths` months). */
    async function recentGames(user, n, maxMonths) {
      n = n || 10;
      var months = await archives(user);
      var out = [];
      for (var i = 0; i < months.length && i < (maxMonths || 2) && out.length < n; i++) {
        out = out.concat(await monthGames(months[i]));
      }
      return out.slice(0, n);
    }

    /**
     * A game by id in `user`'s archive (latest two months). The archive list is refreshed once when the
     * game is not found, because a game finished in a new month adds a new archive.
     */
    async function findGame(user, gameId) {
      var id = String(gameId);
      for (var pass = 0; pass < 2; pass++) {
        var months = await archives(user, pass === 1);
        for (var i = 0; i < months.length && i < 2; i++) {
          var games = await monthGames(months[i]);
          for (var j = 0; j < games.length; j++) if (gameIdOf(games[j]) === id) return games[j];
        }
        if (pass === 0) await cache.delete('month:' + (months[0] || ''));
      }
      return null;
    }

    return { archives: archives, monthGames: monthGames, recentGames: recentGames, findGame: findGame, stats: stats };
  }

  function gameIdOf(game) {
    var m = /\/(\d+)(?:[/?#]|$)/.exec((game && game.url) || '');
    return m ? m[1] : null;
  }

  /** Header value of a PGN, or undefined. */
  function pgnHeader(pgn, name) {
    var m = new RegExp('^\\[' + name + ' "((?:[^"\\\\]|\\\\.)*)"\\]', 'm').exec(pgn || '');
    return m ? m[1] : undefined;
  }

  /**
   * Is this a finished standard game we can analyse? Returns null when fine, else the reason.
   * (The archive has finished games only; the PGN must also carry a final result.)
   */
  function unusableReason(game) {
    if (!game || typeof game.pgn !== 'string' || !game.pgn) return 'chess.com returned no PGN for this game';
    if (game.rules && game.rules !== 'chess') return 'variant games (' + game.rules + ') are not supported';
    if (!FINAL_RESULTS[pgnHeader(game.pgn, 'Result')]) return 'the game has no final result yet';
    return null;
  }

  /** A short description of a game from `user`'s point of view. */
  function summarize(game, user) {
    var u = String(user || '').toLowerCase();
    var w = game.white || {};
    var b = game.black || {};
    var color = (w.username || '').toLowerCase() === u ? 'white' : (b.username || '').toLowerCase() === u ? 'black' : null;
    var me = color === 'white' ? w : color === 'black' ? b : null;
    var opp = color === 'white' ? b : color === 'black' ? w : null;
    var outcome = null;
    if (me) outcome = me.result === 'win' ? 'win' : DRAWS[me.result] ? 'draw' : 'loss';
    return {
      id: gameIdOf(game),
      url: game.url,
      white: w.username,
      black: b.username,
      whiteRating: w.rating,
      blackRating: b.rating,
      color: color,
      opponent: opp ? opp.username : null,
      opponentRating: opp ? opp.rating : null,
      outcome: outcome,
      result: pgnHeader(game.pgn, 'Result') || null,
      timeClass: game.time_class,
      timeControl: game.time_control,
      endTime: game.end_time,
      rated: !!game.rated,
      rules: game.rules || 'chess',
    };
  }

  root.NoteMateChessComApi = {
    createApi: createApi,
    gameIdOf: gameIdOf,
    pgnHeader: pgnHeader,
    unusableReason: unusableReason,
    summarize: summarize,
    USERNAME_RE: USERNAME_RE,
  };
})(typeof self !== 'undefined' ? self : globalThis);
