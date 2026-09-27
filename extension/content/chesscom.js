/*
 * chess.com content script. It READS the page to learn whether a game has finished and never touches the
 * board, the moves or the clocks. No position data leaves the page: only a game id (from the URL) and the
 * player names are sent to the extension, and only after the game has finished.
 *
 * - Every check classifies the page with NoteMateGameOver.detectGameState ('playing' | 'finished' |
 *   'unknown') and reports it to the background, which refuses all analysis while any tab is 'playing'.
 * - The "Analyze in NoteMate" button appears only after 'finished' has held for STABLE_MS without a break
 *   on the same URL, disappears at once otherwise, and re-checks the page when clicked.
 * - On game-archive pages (finished games only) each game gets a small NoteMate button.
 */
/* global NoteMateGameOver */
(function () {
  'use strict';
  if (window.top !== window) return; // not in iframes
  var ext = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;
  var G = NoteMateGameOver;

  var CHECK_MS = 1000;
  /** How long the page must show a finished game, without interruption, before the button appears. */
  var STABLE_MS = 1500;
  var HEARTBEAT_MS = 5000;

  var settings = { showButton: true, archiveButtons: true };
  var lastState = null;
  var lastReportAt = 0;
  var lastUrl = location.href;
  var finishedSince = 0;
  var chip = null;
  var scheduled = false;
  var userReported = null;

  function send(msg) {
    try {
      return ext.runtime.sendMessage(msg).catch(function () { return null; });
    } catch {
      // The extension was reloaded: this old content script can no longer talk to it.
      stop();
      return Promise.resolve(null);
    }
  }

  function loadSettings() {
    try {
      ext.storage.local.get('settings').then(function (got) {
        var s = (got && got.settings) || {};
        settings.showButton = s.showButton !== false;
        settings.archiveButtons = s.archiveButtons !== false;
        check();
      });
    } catch {
      /* ignore */
    }
  }

  /* ---------- the floating button ---------- */

  var CSS =
    ':host{all:initial}' +
    '.chip{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:2px;' +
    'font:500 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#2b2926;background:#f7f5f1;' +
    'border:1px solid #d8d3ca;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:3px;max-width:340px}' +
    '.go{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px}' +
    '.go:hover{background:#ebe7df}.go:focus-visible{outline:2px solid #8d6621}' +
    '.go[disabled]{cursor:progress;opacity:.7}' +
    '.x{all:unset;cursor:pointer;width:24px;height:24px;display:grid;place-items:center;border-radius:6px;color:#77726a;font-size:15px}' +
    '.x:hover{background:#ebe7df;color:#2b2926}' +
    '.msg{padding:0 10px 6px;font-size:12px;color:#8a3b30;max-width:300px}' +
    '.wrap{display:flex;flex-direction:column}.row{display:flex;align-items:center}' +
    'svg{flex:none}';

  var MARK =
    '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="5" fill="#2b2926"/>' +
    '<rect x="5" y="5" width="7" height="7" fill="#f7f5f1"/><rect x="12" y="12" width="7" height="7" fill="#f7f5f1"/></svg>';

  function showChip(label, onClick) {
    if (chip && chip.dataset.label === label) return;
    hideChip();
    var host = document.createElement('div');
    host.setAttribute('data-notemate-chip', '');
    host.dataset.label = label;
    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' + CSS + '</style><div class="chip" role="region" aria-label="NoteMate"><div class="wrap"><div class="row">' +
      '<button class="go" type="button" title="Open this finished game in NoteMate for analysis">' + MARK + '<span></span></button>' +
      '<button class="x" type="button" title="Hide" aria-label="Hide">×</button></div><div class="msg" hidden></div></div></div>';
    shadow.querySelector('.go span').textContent = label;
    var go = shadow.querySelector('.go');
    var msg = shadow.querySelector('.msg');
    go.addEventListener('click', function () {
      msg.hidden = true;
      // Re-check at the moment of the click.
      if (G.detectGameState(document).state !== 'finished') {
        hideChip();
        return;
      }
      go.disabled = true;
      go.querySelector('span').textContent = 'Opening…';
      onClick().then(function (res) {
        go.disabled = false;
        go.querySelector('span').textContent = label;
        if (!res || !res.ok) {
          msg.textContent = (res && res.error) || 'The extension did not answer.';
          msg.hidden = false;
        }
      });
    });
    shadow.querySelector('.x').addEventListener('click', function () {
      dismissedUrl = location.href;
      hideChip();
    });
    document.documentElement.appendChild(host);
    chip = host;
  }

  var dismissedUrl = null;

  function hideChip() {
    if (chip) chip.remove();
    chip = null;
  }

  /** Player names shown with the board (to find the game in the right archive). */
  function playerNames() {
    var sel = '.user-username-component, [data-test-element="user-tagline-username"], .user-tagline-username';
    var names = [];
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length && names.length < 2; i++) {
      var n = (els[i].textContent || '').trim();
      if (G.USERNAME_RE.test(n) && names.indexOf(n) < 0) names.push(n);
    }
    return names;
  }

  /* ---------- archive pages ---------- */

  function decorateArchive() {
    if (!settings.archiveButtons) {
      document.querySelectorAll('[data-notemate-archive]').forEach(function (b) { b.remove(); });
      return;
    }
    G.archiveGameLinks(document).forEach(function (item) {
      var row = item.el.closest('tr, li, [class*="archive-games-row"], [class*="game-row"]') || item.el.parentElement;
      if (!row || row.querySelector('[data-notemate-archive]')) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-notemate-archive', item.ref.id);
      b.title = 'Analyze in NoteMate';
      b.textContent = 'NoteMate';
      b.style.cssText =
        'margin-left:6px;padding:2px 7px;border:1px solid rgba(128,128,128,.45);border-radius:5px;background:transparent;' +
        'color:inherit;font:500 11px/1.4 system-ui,sans-serif;cursor:pointer;opacity:.8;vertical-align:middle';
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        b.disabled = true;
        b.textContent = '…';
        send({ type: 'analyze', from: 'archive', gameId: item.ref.id }).then(function (res) {
          b.disabled = false;
          b.textContent = res && res.ok ? 'NoteMate ✓' : 'NoteMate ✕';
          b.title = res && res.ok ? 'Opened in NoteMate' : (res && res.error) || 'The extension did not answer.';
        });
      });
      var cell = row.querySelector('td:last-child') || row;
      cell.appendChild(b);
    });
  }

  /* ---------- the check loop ---------- */

  function report(state) {
    var now = Date.now();
    if (state !== lastState || now - lastReportAt > HEARTBEAT_MS) {
      lastState = state;
      lastReportAt = now;
      send({ type: 'page-state', state: state });
    }
  }

  function check() {
    scheduled = false;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      finishedSince = 0;
      hideChip();
    }
    var r = G.detectGameState(document);
    report(r.state);

    if (!userReported) {
      var u = G.detectUsername(document);
      if (u) {
        userReported = u;
        send({ type: 'detected-user', username: u });
      }
    }

    if (r.state !== 'finished') {
      finishedSince = 0;
      hideChip();
      // Archive pages list finished games; still nothing while anything on the page looks like a live game.
      if (r.state === 'unknown' && G.isArchivePage(location.href)) decorateArchive();
      return;
    }
    if (!finishedSince) finishedSince = Date.now();
    if (Date.now() - finishedSince < STABLE_MS || !settings.showButton || dismissedUrl === location.href) return;
    var ref = G.gameRefFromUrl(location.href);
    var players = playerNames();
    showChip('Analyze in NoteMate', function () {
      return send(ref ? { type: 'analyze', gameId: ref.id, players: players } : { type: 'analyze', last: true, players: players });
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(check, 300);
  }

  var observer = new MutationObserver(schedule);
  var timer = null;
  function stop() {
    observer.disconnect();
    if (timer) clearInterval(timer);
    hideChip();
  }

  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  timer = setInterval(check, CHECK_MS);
  try {
    ext.storage.onChanged.addListener(function (changes) {
      if (changes.settings) loadSettings();
    });
  } catch {
    /* ignore */
  }
  loadSettings();
  check();
})();
