# NoteMate for chess.com (browser extension)

Open your chess.com games in NoteMate right after they finish: one click on the game page, or pick a game from
the toolbar popup. NoteMate loads the game, turns the board to your colour, switches the engine on, runs a
Stockfish game review, and can ask ChessMind "Review this game".

## Fair play

chess.com does not allow outside help during a game, so the extension stays off while any game is in progress:

- **It acts only on finished games.** The content script reads the page and classifies it: *playing* (resign,
  draw or abort buttons, or a running clock are visible), *finished* (the game-over dialog or a final result in
  the move list, and nothing from a game in progress), or *unknown*. Only *finished*, held for 1.5 s without a
  break, shows the button. *Playing* always wins, and anything else (*unknown*) shows nothing. The page is
  checked again when you click.
- **Any game in progress blocks everything.** While any chess.com tab reports a game in progress, the background
  refuses every request: the button, the popup's "Analyze my last game", the recent-games list and the archive
  buttons. Tabs refresh that report every 5 s. A report counts for 30 s, so a closed or crashed tab errs on the
  side of blocking.
- **Only games in chess.com's archive.** Games are fetched from chess.com's public API, whose monthly archives
  list finished games only, and the PGN must carry a final result. A game still being played cannot be found
  there.
- **Nothing from the live board.** The extension never reads positions, moves or clocks from the page, sends
  nothing while a game is on, and never clicks or moves anything on chess.com. It sends only a game id (from the
  URL) and the players' names.
- **No credentials.** It stores only your public username, never a password or cookie. API requests are sent
  without cookies (`credentials: 'omit'`).

Use it for personal analysis of your own games. Don't use chess.com data for training models.

## Install (Chrome, Edge, Brave)

1. Start NoteMate: `npm run host` in the repo (app at http://localhost:4173).
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` folder.
4. Pin the extension. In the popup, or in **Options**, enter your chess.com username. It is also detected
   from chess.com's navigation when you are signed in. Change the NoteMate URL if NoteMate is not at
   http://localhost:4173/.

**Firefox (121+):** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick
`extension/manifest.json`. The manifest carries `background.scripts` for Firefox next to Chrome's
`service_worker`, and a gecko id. It is untested in Firefox. Chrome may list the unused `background.scripts` key
as a warning; it is harmless.

## Using it

- **After a game:** when the game-over dialog appears, an **Analyze in NoteMate** chip shows at the bottom right
  (× hides it for that page).
- **Popup:** your username, **Analyze my last game**, your 10 most recent games with an **Analyze** button each,
  and the NoteMate URL.
- **Archive pages** (`chess.com/games/archive/...`): a small **NoteMate** button next to each game.
- **Options:** username, NoteMate URL, reuse an open NoteMate tab (default on), and switches for the chip and the
  archive buttons.

## How it works

1. **Finding the game.** The background asks the public API for
   `https://api.chess.com/pub/player/{user}/games/archives` (cached for 1 h in `storage.session`). It then reads
   the newest one or two months and matches the game by the id in its URL. If the game is missing, it refreshes
   the archive list once, because a new month adds a new archive. Requests run one at a time, a 429 is retried
   after a pause, and month data is cached in memory for 30 s. If the game is still missing, you get "not in the
   archive yet, try again in a minute". The extension does not fall back to scraping the page: the API covers
   every finished game, and reading the page's PGN would mean clicking chess.com's UI.
2. **Handing it to NoteMate.** The extension opens `<NoteMate URL>#import=chesscom&v=1&d=<payload>`. The payload
   is `{ pgn, user, url }` as JSON, deflate-raw compressed and base64url encoded (`lib/handoff.js`), which is
   about 2–4 KB for a blitz game with clock comments. A URL fragment never reaches a server. It needs no script
   on NoteMate's side and works with any NoteMate address. The size cap is 1.5 MB, hundreds of times larger than
   any real game. An open NoteMate tab is reused: the fragment changes, and NoteMate listens for `hashchange`.
3. **In NoteMate** (`src/import/`):
   - the current game is saved to a history of 10 games. The toast's **Undo** brings it back, and so does the
     palette command "Restore earlier game: …";
   - the new game loads with its players, ratings, time control, result, termination and chess.com link.
     `[%clk]` clock comments are dropped instead of becoming notes;
   - the board turns to your colour and the engine comes on;
   - the **Review** panel walks the game. Stockfish Lite runs single-threaded at depth 10 by default (8–14 can
     be chosen). Moves are graded by win-probability loss, as in ChessMind's `scrape/quality.py`: a loss of
     20 or more is a blunder, 10 or more a mistake, 5 or more an inaccuracy. Blunders and mistakes get notes
     ("Blunder (−27% win chance: 61% → 34%). Best was Nf3."). The panel also shows an accuracy per side
     (Lichess's formula), a win-chance chart and a clickable list of the flagged moves;
   - if ChessMind is loaded, it is asked "Review this game" with the whole game as context.

   The review and the chat each have a switch in NoteMate's **Settings → chess.com import**.

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (Chrome service worker, Firefox background scripts) |
| `background.js` | API access, fair-play gate, opening NoteMate |
| `content/chesscom.js` | chess.com content script: page state, the chip, archive buttons |
| `lib/gameover.js` | Game-over detection, game ids from URLs, username detection |
| `lib/chesscom-api.js` | Public API client (serial requests, caching, matching, summaries) |
| `lib/handoff.js` | Builds the NoteMate import URL |
| `popup/`, `options/` | Toolbar popup and options page |
| `test/` | Unit tests, DOM fixtures and the end-to-end test |

## Tests

```sh
# unit tests (API client with a mocked fetch, hand-off, URL parsing); the DOM fixture tests need Playwright
PLAYWRIGHT_DIR=/path/with/node_modules CHROMIUM_PATH=/path/to/chrome node --test "extension/test/*.test.mjs"
node scripts/test-import.mjs      # NoteMate side: PGN details, decoding, review maths, APPLY_REVIEW, history

# end to end: unpacked extension + fixture chess.com pages + the real public API + NoteMate on :4173
npm run host &
PLAYWRIGHT_DIR=... CHROMIUM_PATH=... CHESSCOM_USER=hikaru SHOTS=/tmp/nm-shots node extension/test/e2e.mjs
```

The end-to-end test serves the chess.com pages from `test/fixtures` at `www.chess.com` URLs, with the real
latest game of `CHESSCOM_USER` taken from the public API. It checks the following:

- during a game there is no chip, and the popup and background refuse;
- after the game the chip appears, and a new clock starting hides it again;
- clicking the chip imports the game, orients the board, starts the engine and runs the review;
- the popup lists games, and analysing another one reuses the NoteMate tab;
- the archive pages get their buttons.

Headless Chrome identifies itself as `HeadlessChrome`, which api.chess.com's Cloudflare front rejects with a 403.
The test therefore passes a regular Chrome user agent.

## Limitations

- chess.com changes its markup from time to time. The selectors in `lib/gameover.js` cover the current and
  recent layouts. If none of them match, the page counts as *unknown* and nothing is shown, which is the safe
  side. The popup keeps working.
- A game appears in the public archive shortly after it ends, usually within seconds and sometimes a minute or
  more. Until then the extension says so instead of guessing.
- Variants (Chess960 and others) are refused. NoteMate's move rules are standard chess.
- The accuracy is Lichess-style and approximate. It will not match chess.com's CAPS numbers.
- Anyone who can open a link to your NoteMate could load a PGN into it the same way. The game you had open goes
  to the history, so nothing is lost.
- Firefox support is untested.
- **Future work:** opponent prep. The idea is to fetch an opponent's recent games from the same API into NoteMate
  (for ChessMind's planned player embeddings). It is left out for now.
