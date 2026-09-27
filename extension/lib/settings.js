/* Extension settings (chrome.storage.local). No chess.com credentials are ever stored: only a public username. */
(function (root) {
  'use strict';
  var DEFAULTS = {
    /** chess.com username; empty = use the one detected on chess.com pages. */
    username: '',
    noteMateUrl: 'http://localhost:4173/',
    /** Reuse an open NoteMate tab instead of opening a new one. */
    reuseTab: true,
    /** Show "Analyze in NoteMate" on chess.com after a game has finished. */
    showButton: true,
    /** Add a small NoteMate button to each game on chess.com's game-archive pages. */
    archiveButtons: true,
  };

  function ext() {
    return typeof browser !== 'undefined' && browser.storage ? browser : chrome;
  }

  async function getSettings() {
    var got = await ext().storage.local.get(['settings', 'detectedUsername']);
    var s = Object.assign({}, DEFAULTS, got.settings || {});
    s.detectedUsername = got.detectedUsername || '';
    s.effectiveUsername = (s.username || s.detectedUsername || '').trim();
    return s;
  }

  async function saveSettings(patch) {
    var got = await ext().storage.local.get('settings');
    var next = Object.assign({}, DEFAULTS, got.settings || {}, patch);
    await ext().storage.local.set({ settings: next });
    return next;
  }

  root.NoteMateSettings = { DEFAULTS: DEFAULTS, getSettings: getSettings, saveSettings: saveSettings, ext: ext };
})(typeof self !== 'undefined' ? self : globalThis);
