/*
 * Hand a game to NoteMate: open `<NoteMate URL>#import=chesscom&v=1&d=<payload>`, where the payload is the
 * JSON { pgn, user, url } compressed with deflate-raw and base64url encoded (NoteMate: src/import/handoff.ts).
 *
 * A URL fragment is never sent to a server, needs no script on NoteMate's side beyond the app itself, and
 * works with any NoteMate address. Compressed, a long blitz game with clock comments is ~2-4 KB; browsers
 * accept URLs of megabytes, so MAX_URL leaves a wide margin.
 */
(function (root) {
  'use strict';

  var MAX_URL = 1500000;

  function bytesToBase64Url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function deflateRaw(text) {
    var stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** The NoteMate address, normalised (http/https only). Throws on anything else. */
  function normaliseBase(base) {
    var u = new URL(String(base || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The NoteMate URL must start with http:// or https://');
    u.hash = '';
    return u.href;
  }

  /** The URL that makes NoteMate load `pgn` (plus who imported it and the game's page). */
  async function buildImportUrl(base, payload) {
    var json = JSON.stringify({ pgn: payload.pgn, user: payload.user || undefined, url: payload.url || undefined });
    var param;
    if (typeof CompressionStream === 'function') param = 'd=' + bytesToBase64Url(await deflateRaw(json));
    else param = 'j=' + bytesToBase64Url(new TextEncoder().encode(json));
    var href = normaliseBase(base) + '#import=chesscom&v=1&' + param;
    if (href.length > MAX_URL) throw new Error('This game is too large to hand over');
    return href;
  }

  root.NoteMateHandoff = { buildImportUrl: buildImportUrl, normaliseBase: normaliseBase, MAX_URL: MAX_URL };
})(typeof self !== 'undefined' ? self : globalThis);
