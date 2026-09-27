/* global NoteMateSettings */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var BOOLS = ['showButton', 'archiveButtons', 'reuseTab'];

  NoteMateSettings.getSettings().then(function (s) {
    $('username').value = s.username;
    $('username').placeholder = s.detectedUsername || '';
    $('detected').textContent = s.detectedUsername ? 'Detected on chess.com: ' + s.detectedUsername + ' (used when this is empty).' : 'Leave empty to use the name detected on chess.com.';
    $('noteMateUrl').value = s.noteMateUrl;
    BOOLS.forEach(function (k) { $(k).checked = !!s[k]; });
  });

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var status = $('status');
    var username = $('username').value.trim();
    var url = $('noteMateUrl').value.trim();
    if (username && !/^[A-Za-z0-9_-]{2,40}$/.test(username)) {
      status.textContent = 'That is not a valid chess.com username.';
      status.className = 'status error';
      return;
    }
    try {
      var u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      status.textContent = 'Enter a URL such as http://localhost:4173/';
      status.className = 'status error';
      return;
    }
    var patch = { username: username, noteMateUrl: url };
    BOOLS.forEach(function (k) { patch[k] = $(k).checked; });
    NoteMateSettings.saveSettings(patch).then(function () {
      status.textContent = 'Saved.';
      status.className = 'status';
    });
  });
})();
