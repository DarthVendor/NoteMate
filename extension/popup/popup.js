/* Toolbar popup: username, "Analyze my last game", recent games, NoteMate URL. */
/* global NoteMateSettings */
(function () {
  'use strict';
  var ext = NoteMateSettings.ext();
  var $ = function (id) { return document.getElementById(id); };
  var playing = false;

  function send(msg) {
    return ext.runtime.sendMessage(msg).catch(function (e) { return { ok: false, error: e.message }; });
  }

  function setStatus(text, error) {
    $('status').textContent = text || '';
    $('status').className = 'status' + (error ? ' error' : '');
  }

  function setPlaying(p) {
    playing = p;
    $('fairplay').hidden = !p;
    $('last').disabled = p;
    document.querySelectorAll('.games .btn').forEach(function (b) { b.disabled = p; });
  }

  function ago(sec) {
    var d = Date.now() / 1000 - sec;
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    return new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function tcLabel(g) {
    var tc = g.timeControl || '';
    var daily = /^1\/(\d+)$/.exec(tc);
    if (daily) return Math.round(Number(daily[1]) / 86400) + 'd';
    var m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
    if (!m) return g.timeClass || '';
    var mins = Number(m[1]) / 60;
    return (mins % 1 ? mins.toFixed(1) : mins) + (m[2] ? '+' + m[2] : ' min');
  }

  function analyze(msg, button) {
    if (playing) return;
    if (button) button.disabled = true;
    setStatus('Fetching the game from chess.com…');
    send(Object.assign({ type: 'analyze' }, msg)).then(function (res) {
      if (button) button.disabled = playing;
      if (res && res.ok) {
        setStatus('Opened in NoteMate.');
        setTimeout(function () { window.close(); }, 600);
      } else {
        if (res && res.fairPlay) setPlaying(true);
        setStatus((res && res.error) || 'Something went wrong.', true);
      }
    });
  }

  function renderGames(res) {
    var list = $('games');
    list.textContent = '';
    $('games-empty').hidden = true;
    if (!res || !res.ok) {
      $('games-empty').hidden = false;
      $('games-empty').textContent = res && res.needUser ? 'Enter your chess.com username to see your games.' : (res && res.error) || 'Could not load games.';
      if (res && res.fairPlay) setPlaying(true);
      return;
    }
    if (!res.games.length) {
      $('games-empty').hidden = false;
      $('games-empty').textContent = 'No finished games found for ' + res.user + '.';
      return;
    }
    res.games.forEach(function (g) {
      var li = document.createElement('li');
      li.dataset.gameId = g.id;
      var r = document.createElement('span');
      r.className = 'res ' + (g.outcome || 'draw');
      r.textContent = g.outcome === 'win' ? 'W' : g.outcome === 'loss' ? 'L' : g.outcome === 'draw' ? '½' : '·';
      r.title = g.result || '';
      var who = document.createElement('span');
      who.className = 'who';
      var b = document.createElement('b');
      b.textContent = g.opponent ? 'vs ' + g.opponent + (g.opponentRating ? ' (' + g.opponentRating + ')' : '') : g.white + ' – ' + g.black;
      var meta = document.createElement('span');
      meta.textContent = [g.color ? (g.color === 'white' ? 'White' : 'Black') : null, tcLabel(g), g.endTime ? ago(g.endTime) : null].filter(Boolean).join(' · ');
      who.append(b, meta);
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.textContent = 'Analyze';
      btn.disabled = playing;
      btn.addEventListener('click', function () { analyze({ gameId: g.id }, btn); });
      li.append(r, who, btn);
      list.appendChild(li);
    });
  }

  function loadGames() {
    $('games').textContent = '';
    $('games-empty').hidden = false;
    $('games-empty').textContent = 'Loading…';
    send({ type: 'recent', n: 10 }).then(renderGames);
  }

  send({ type: 'status' }).then(function (res) {
    if (!res || !res.ok) return;
    var s = res.settings;
    $('username').value = s.username || '';
    $('username').placeholder = s.detectedUsername || 'username';
    $('user-hint').textContent = s.username
      ? ''
      : s.detectedUsername
        ? 'Detected on chess.com: ' + s.detectedUsername + '. Save a name to override it.'
        : 'Open chess.com while signed in to detect it, or type it here.';
    $('notemate-url').value = s.noteMateUrl;
    setPlaying(res.playing);
    if (!res.playing) loadGames();
    else renderGames({ ok: false, error: 'Recent games are hidden while a game is in progress.' });
  });

  $('user-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('username').value.trim();
    if (v && !/^[A-Za-z0-9_-]{2,40}$/.test(v)) return setStatus('That is not a valid chess.com username.', true);
    NoteMateSettings.saveSettings({ username: v }).then(function () {
      setStatus(v ? 'Saved.' : 'Using the detected username.');
      loadGames();
    });
  });

  $('url-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('notemate-url').value.trim();
    try {
      var u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      return setStatus('Enter a URL such as http://localhost:4173/', true);
    }
    NoteMateSettings.saveSettings({ noteMateUrl: v }).then(function () { setStatus('Saved.'); });
  });

  $('last').addEventListener('click', function () { analyze({ last: true }, $('last')); });
  $('refresh').addEventListener('click', loadGames);
  $('options').addEventListener('click', function (e) {
    e.preventDefault();
    ext.runtime.openOptionsPage();
  });
})();
