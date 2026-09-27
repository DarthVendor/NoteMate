/*
 * Game-over detection for chess.com pages (fair play).
 *
 * chess.com forbids outside help during a game, so the extension acts only when the page shows that the
 * game has ENDED, and does nothing if there is any doubt:
 *
 *   'playing'  - anything that belongs to a game in progress is visible: resign / draw / abort buttons or a
 *                running clock. This always wins, whatever else the page shows.
 *   'finished' - no in-progress signal, and a game-over signal is visible: the game-over dialog, or a
 *                result (1-0, 0-1, 1/2-1/2) at the end of the move list.
 *   'unknown'  - neither (home page, lobby, puzzles, a daily game waiting for a move, ...). Treated like
 *                'playing' for the button: nothing is shown.
 *
 * The content script also requires 'finished' to hold on consecutive checks before it shows its button, and
 * the background only opens games that chess.com's public archive lists (the archive holds finished games
 * only). This file only reads the page; it never touches the board.
 */
(function (root) {
  'use strict';

  /** Elements that exist only while the game is being played. */
  var IN_PROGRESS = [
    '[data-cy="resign-button-with-confirmation"]',
    '[data-cy="resign-button"]',
    '.resign-button-component',
    '[data-cy="draw-button"]',
    '.draw-button-component',
    '[data-cy="abort-button"]',
    '.abort-button-component',
    'button[aria-label="Resign"]',
    'button[aria-label="Offer Draw"]',
    'button[aria-label="Abort"]',
    '.clock-player-turn',
    '.clock-component.clock-running',
    '.clock-running',
  ];

  /** The game-over dialog (live games) and its header. */
  var GAME_OVER_DIALOG = [
    '.game-over-modal-content',
    '.game-over-modal-container',
    '.game-over-header-component',
    '[data-cy="game-over-modal"]',
    '[data-cy="game-over-modal-content"]',
  ];

  /** Where the move list shows the final result. */
  var RESULT = ['.game-result', '[data-cy="game-result"]', '.move-list-result', '.result-row'];

  var RESULT_TEXT = /^\s*(1-0|0-1|1\/2-1\/2|½-½)\s*$/;

  function isVisible(el) {
    if (!el || el.hidden) return false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (view && view.getComputedStyle) {
      var cs = view.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    }
    return true;
  }

  function anyVisible(doc, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var list = doc.querySelectorAll(selectors[i]);
      for (var j = 0; j < list.length; j++) if (isVisible(list[j])) return list[j];
    }
    return null;
  }

  function visibleResult(doc) {
    for (var i = 0; i < RESULT.length; i++) {
      var list = doc.querySelectorAll(RESULT[i]);
      for (var j = 0; j < list.length; j++) {
        if (isVisible(list[j]) && RESULT_TEXT.test(list[j].textContent || '')) return list[j].textContent.trim().replace('½-½', '1/2-1/2');
      }
    }
    return null;
  }

  /**
   * Classify a chess.com page. Returns { state: 'playing' | 'finished' | 'unknown', reason, result? }.
   */
  function detectGameState(doc) {
    var busy = anyVisible(doc, IN_PROGRESS);
    if (busy) return { state: 'playing', reason: 'in-progress control: ' + describe(busy) };
    var dialog = anyVisible(doc, GAME_OVER_DIALOG);
    var result = visibleResult(doc);
    if (dialog) return { state: 'finished', reason: 'game-over dialog', result: result || undefined };
    if (result) return { state: 'finished', reason: 'result in move list', result: result };
    return { state: 'unknown', reason: 'no game-over signal' };
  }

  function describe(el) {
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  }

  /**
   * The game a chess.com URL shows: { type: 'live' | 'daily' | null, id } or null.
   * /game/live/123, /game/daily/123, /live/game/123, /daily/game/123, /analysis/game/live/123, /game/123, #g=123
   */
  function gameRefFromUrl(href) {
    var u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    if (!/(^|\.)chess\.com$/.test(u.hostname)) return null;
    var p = u.pathname;
    var m =
      /\/(?:analysis\/)?game\/(live|daily)\/(\d+)/.exec(p) ||
      /\/(live|daily)\/game\/(\d+)/.exec(p);
    if (m) return { type: m[1], id: m[2] };
    m = /^\/game\/(\d+)(?:\/|$)/.exec(p);
    if (m) return { type: null, id: m[1] };
    m = /(?:^|[#&])g=(\d+)/.exec(u.hash);
    if (m && /^\/live/.test(p)) return { type: 'live', id: m[1] };
    return null;
  }

  /** Game-archive pages list finished games only: /games/archive, /games/archive/<user>. */
  function isArchivePage(href) {
    try {
      var u = new URL(href);
      return /(^|\.)chess\.com$/.test(u.hostname) && /^\/games\/archive(\/|$)/.test(u.pathname);
    } catch {
      return false;
    }
  }

  /** Links to games on an archive page: [{ el, ref }] with one entry per game id. */
  function archiveGameLinks(doc) {
    var out = [];
    var seen = {};
    var links = doc.querySelectorAll('a[href*="/game/"]');
    for (var i = 0; i < links.length; i++) {
      var ref = gameRefFromUrl(links[i].href);
      if (!ref || seen[ref.id]) continue;
      seen[ref.id] = true;
      out.push({ el: links[i], ref: ref });
    }
    return out;
  }

  var USERNAME_RE = /^[A-Za-z0-9_-]{2,40}$/;

  /** The signed-in user's name from the site navigation (their profile link), or null. */
  function detectUsername(doc) {
    var selectors = [
      'a.home-username-link',
      '.home-user-info a[href*="/member/"]',
      'nav a[href*="/member/"][class*="user"]',
      '#sb a[href*="/member/"]',
      '.sidebar a[href*="/member/"]',
      '.nav-menu-area a[href*="/member/"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = doc.querySelector(selectors[i]);
      if (!el) continue;
      var m = /\/member\/([^/?#]+)/.exec(el.getAttribute('href') || '');
      var name = m ? decodeURIComponent(m[1]) : (el.textContent || '').trim();
      if (USERNAME_RE.test(name)) return name;
    }
    return null;
  }

  var api = {
    detectGameState: detectGameState,
    gameRefFromUrl: gameRefFromUrl,
    isArchivePage: isArchivePage,
    archiveGameLinks: archiveGameLinks,
    detectUsername: detectUsername,
    USERNAME_RE: USERNAME_RE,
    selectors: { IN_PROGRESS: IN_PROGRESS, GAME_OVER_DIALOG: GAME_OVER_DIALOG, RESULT: RESULT },
  };
  root.NoteMateGameOver = api;
})(typeof self !== 'undefined' ? self : globalThis);
