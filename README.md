# NoteMate

A chess study board for taking notes on games: play or load a game, draw arrows on the board, and pin sticky notes to positions. Includes Stockfish analysis with selectable engine builds.

## Run

```sh
npm install
npm run dev        # development server on http://localhost:5173
```

## Host on your machine (two endpoints)

```sh
npm run host
```

This builds the app and starts two servers:

| Endpoint | Port | Serves |
| --- | --- | --- |
| App | http://localhost:4173 | The built app (with the COOP/COEP headers the multi-threaded engines need) |
| Engines | http://localhost:4174 | The Stockfish builds from `public/engines/`, with CORS so any origin can load them |

In the app, set **Engine server** to `http://localhost:4174`. The setting is saved in the browser. Leave it empty to load engines from the app's own origin instead. The two can also be started separately with `npm run serve` and `npm run serve:engines`, and the engine port is set with `ENGINE_PORT`.

`npm run dev` and `npm run build` first copy the Stockfish WASM builds from `node_modules/stockfish/bin` into `public/engines/` (ignored by git).

## Using it

- **Move pieces** by dragging or click-click. Promotion shows a piece chooser. Moves animate; turn it down or off in Settings (and `prefers-reduced-motion` is respected).
- **Arrows**: right-drag between squares. Right-click a square to circle it. Hold Shift (red), Alt (blue) or Ctrl (yellow) for other colours. Drawing the same shape again removes it.
- **Sticky notes**: the Notes panel shows notes for the current position (`N` adds one). Notes on other positions are listed below and are clickable. Moves with notes or arrows get a small badge in the move list.
- **Variations**: playing a different move from any position creates a branch. The move list shows alternatives indented under the move they replace, with "Make main line" and "Delete from here" above it. ↑/↓ switch between alternatives.
- **Erase**: the Erase menu above the move list (also the eraser under the board) removes every side line (`Shift+⌫`; chat lines included, the main line and its notes stay), arrows and highlights on all positions, this position's marks (`X`), or everything. It acts at once; the message that follows has **Undo** for a few seconds.
- **Navigation**: ← → Home End (or `J`/`K`), the buttons under the board, or click a move. `F` flips the board.
- **Import / export**: Import (`I`) accepts pasted or dropped PGN or a `.pgn` file (chess.com and ChessBase both export PGN). Nested variations are imported and `{comments}` become sticky notes (clock and eval commands such as `[%clk 0:02:59]` are dropped). Ratings, time control, termination and the game link are kept. "Copy PGN" writes the full tree back out with notes as comments.
- **Engine**: the strip at the top of the Analysis panel shows it on/off (or `E`), the evaluation, the best line (click it to play the first move) and the depth; the chevron shows every line (MultiPV), the sliders icon the settings (build, server, threads, lines, depth, hash; also in Settings). The blue arrow on the board is the engine's top move.
- **Command palette**: `⌘K` / `Ctrl+K` runs any action (navigation, panels, layouts, theme, board colours). `?` lists every shortcut.

### Workspace

The board sits in the middle, Notes on the left and the **Analysis** panel on the right: the engine strip and ChessMind's predicted moves on top, the move tree, and the ChessMind chat below it (drag the divider between them). Everything follows the current position. Every tool is a panel docked left, right or bottom; Moves, Engine and ChessMind also exist as separate panels for custom layouts (Layout menu).

- Drag a panel's tab onto another panel to tab them together, onto the top/bottom (or left/right) edge of a panel to split, or onto the "Dock left / right / bottom" strips that appear while dragging.
- Each panel group's `⋯` menu docks, splits, reorders or hides it and adds hidden panels as tabs. The Layout menu in the top bar shows/hides panels and applies presets: **Study** (Notes, board, Analysis), **Analysis** (a wide Analysis panel with Notes as a tab), **Focus** (board and a slim Analysis column), **Coach** (a wider chat). "Reset layout" restores Study. Saved layouts that were an unedited preset move to the new arrangement automatically.
- Drag the gaps between panels to resize (or focus them and use the arrow keys). Layout and sizes are saved in the browser.
- **Settings** (`,`): theme (system / light / dark), board colours, piece set, animation, coordinates, legal-move dots, engine defaults and ChessMind chat options.
- At phone width the board spans the screen and the visible panels become a tab row underneath; inside Analysis, Moves and ChessMind are two tabs.
- **Developer tools** (Settings, or the palette's "Developer: …" commands) add the Simulate panel. It is hidden otherwise.

Adding a panel: write a component that reads app state with `useApp()` and register it in `src/panels/index.tsx` with `registerPanel({ id, title, icon, defaultZone, minSize, component })`. It then appears in the Layout menu, the command palette and the phone tabs; add its id to a preset in `src/workspace/layout.ts` to show it by default.

The Full builds are ~99 MB and can take a minute to download and compile on first use; the browser caches them afterwards. Multi-threaded builds need the page to be cross-origin isolated. The Vite dev and preview servers already send the required `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers; a production host must send the same.

Everything is saved to `localStorage` (game, annotations, engine settings, layout, appearance).

## chess.com games (browser extension)

`extension/` is a Chrome (MV3, Firefox-compatible) extension. It opens your chess.com games in NoteMate once they have finished. See [extension/README.md](extension/README.md).

**Install:** open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and pick the `extension/` folder. Then set your chess.com username in the popup.

- After a game, an **Analyze in NoteMate** chip appears on the chess.com page. The popup offers **Analyze my last game** and your recent games, and archive pages get a NoteMate button per game.
- Games come from chess.com's official public API and reach NoteMate as a compressed PGN in the URL fragment (`#import=chesscom&d=…`).
- NoteMate then does the following:
  - keeps the current game in a history (**Undo** in the toast, or "Restore earlier game" in the palette);
  - loads the players, ratings, time control, result and link (clock comments are dropped);
  - turns the board to your colour and switches the engine on;
  - runs the **Review** panel's game review: Stockfish at depth 10, with blunders (≥ 20% win chance lost) and mistakes (≥ 10%) noted on their moves, plus an accuracy per side and a win-chance chart;
  - asks ChessMind "Review this game" if the model is loaded.

  Both the review and the ChessMind question can be switched off under **Settings → chess.com import**. The review can also be run on any game from the palette ("Review game with the engine").
- **Fair play:** chess.com forbids outside help during games. The extension does nothing while a game is in progress in any chess.com tab: no button, no lists, no requests. It opens only games that the page shows as finished *and* that chess.com's archive lists, and the archive holds finished games only. It never reads positions from the page or touches the board, and it stores no credentials. Use it for personal analysis only, not to collect training data.

Tests: `npm run test:import` (NoteMate side) and `npm run test:extension` (set `PLAYWRIGHT_DIR` for the DOM fixture tests). `extension/test/e2e.mjs` is an end-to-end run with the unpacked extension.

## ChessMind (in-browser language model)

The ChessMind chat (in the Analysis panel, or on its own as the ChessMind panel) runs a [ChessMind](../ChessMind) model in the browser: onnxruntime-web 1.30.0 from cdnjs in a Web Worker (single-threaded wasm; WebGPU selectable), the model fetched in <= 14 MB chunks and cached with the Cache API.

- **Predicted moves**: the model's top 5 legal moves for the current position as chips with probabilities (under the engine strip), drawn as purple arrows. Click one to play it; the pin saves the arrows on the position like your own arrows, the arrow toggle turns live arrows off.
- **Chat**: an empty chat offers starters ("What's the plan here?", "Show me the Najdorf", …). Hidden reasoning shows as a collapsed "Thinking" block above the answer. Model, backend, reasoning, context and chat options are in the sliders popover of the chat header; loading shows as a slim progress bar.
- **Ask ChessMind** (`/` focuses the box, Enter sends): questions in the model's dialogue format, streamed (60-token cap, Stop button); moves inside a line are sampled from legal moves only. An answer's lines render as move chips; each is clickable: it inserts the line as a variation (from the start position, or from the asked-at position with "lines start from this position") and jumps there. **Play through**, **Keep as main line** and **Discard** under the line work on that variation. The answer's text becomes purple ChessMind sticky notes (text before a line on its start node, text after it on its last node). The chat is saved with the game and cleared on New game.
- **Board commands**: type `/` for a menu of them (↑/↓, Enter or Tab). They are handled locally, with or without the slash: `back 2`, `forward`, `go to move 12`, `start`, `end`, `flip`, `next variation`, `make this the main line`, `delete this line`, `add note: …`, `arrow e2 e4 red`, `highlight e4`, `clear arrows`, `new game`, SAN moves (`Nf3`), and `what should I play?` / `analyse` (top moves plus a short model comment).
- **Move context** (settings popover): for board-embedding models, predictions can read only the last 8/16/32 plies (the board input carries the position).

Models come from ChessMind's `scripts/export_onnx.py` (see its README). `npm run chessmind` (also run by `dev`, `build` and `host`) copies `../ChessMind/export/onnx/*` (or `$CHESSMIND_EXPORT`) into `public/chessmind/<name>/` (git-ignored) and writes `public/chessmind/models.json`; the first entry is the default. `node scripts/test-chessmind.mjs` checks the JS board encoding against the Python fixture; `node scripts/test-game.mjs` tests the game reducer's erase / undo.

For a claude.ai artifact, `node scripts/build-artifact.mjs <dir>/index.html --no-full-engine` builds the page and copies the models to `<dir>/chessmind/`. `--no-full-engine` leaves out the 99 MB Stockfish Full chunks, because an artifact version is capped at 256 MB.

## Simulate (ChessMind vs Stockfish)

A developer tool for measuring the model: turn on **Developer tools** in Settings (or run "Developer: Simulate vs Stockfish" from the palette) to add the **Simulate** panel, which plays the selected ChessMind model against Stockfish on the board. The panel shows a one-line summary of the setup; **Edit** opens the settings. The analysis engine pauses while a simulation runs.

- **Settings**: ChessMind's colour (White, Black, or alternate each game); Stockfish **Skill Level** (0–20, default 3) with a per-move limit in ms (`go movetime`, default 100) or nodes (`go nodes`); the model's move (argmax, or sampled with temperature 0.3–1.0); start from the current position or the initial one; number of games (1–50); a delay after each move for watching (0–1000 ms); max plies (default 300).
- **Opponent**: a separate Stockfish worker, so the Engine panel's analysis and settings are untouched. It uses the build selected in the Engine panel (multi-threaded builds only when the page is cross-origin isolated) and falls back to Stockfish 19 Lite single-threaded; Threads 1, Hash 16 MB, `ucinewgame` before each game.
- **Model**: moves come from the ChessMind worker (softmax over legal moves only), with the Advanced "short context" setting for board-embedding models. If ChessMind is off, Start turns it on and waits for the model. The panel's automatic prediction pauses while a simulation runs.
- **Move tree**: each game is a new variation from the start position (the main line only when the start position has no moves yet), so your own lines are never overwritten. The first move gets a note like "ChessMind (restart-v3-250m-s50k) vs Stockfish Skill 3 (100 ms) — game 3 of 10", the last move the result. The board follows the game. Stopping mid-game leaves the partial line with a "stopped" note.
- **Controls**: Start, Pause / Resume, Stop, and Step (one move; starts a paused run when idle).
- **Game end** (chess.js): checkmate, stalemate, threefold repetition, insufficient material, the 50-move rule; at max plies a 300 ms full-strength Stockfish search adjudicates (|eval| >= 400 cp is a win, otherwise a draw).
- **Scoreboard**: the model's W/D/L overall and per colour, average game length, per-move latency, and a rough Elo: the approximate Skill Level Elo table from ChessMind's `chessmind/eval/engine.py` (`SKILL_ELO`, a community mapping for timed play, so only a scale) plus the Elo difference implied by the score (with one virtual draw added so short runs stay finite). Click a finished game to jump to its branch ("end" jumps to its last move). **Export PGN** copies all simulated games (one PGN each, with headers) through the same clipboard path as Copy PGN.

## Layout

- `src/state/gameReducer.ts` — game model: a tree of `MoveNode`s (first child = main line) with annotations attached to nodes.
- `src/state/pgn.ts` — PGN parser (variations, comments, NAGs) and writer.
- `src/components/Board.tsx` — board, pointer handling for moves and shape drawing.
- `src/components/ArrowLayer.tsx` — SVG arrows and highlight circles.
- `src/components/StickyNotes.tsx`, `MoveList.tsx`, `PgnImport.tsx`, `EnginePanel.tsx`, `EvalBar.tsx`.
- `src/design/` — design tokens (`tokens.css`: colour, type, space, radius, elevation, motion for light and dark), primitives (`base.css`) and area styles (`app.css`, `board.css`, `panels.css`). Fonts (Geist, Geist Mono, Newsreader) and icons (lucide) are bundled, so the app works offline.
- `src/workspace/` — panel registry (`registry.ts`), the layout model and presets (`layout.ts`, pure functions), persistence (`useLayout.ts`), the docking workspace (`Workspace.tsx`, on react-resizable-panels) and the phone layout.
- `src/analysis/` — the integrated Analysis panel and its engine strip.
- `src/panels/` — built-in panel registrations and the Settings panel.
- `src/app/` — app context for panels (`useApp`), command registry (palette, shortcuts), top bar, board stage, command palette, shortcuts sheet, onboarding.
- `src/assets/pieces/` — piece sets (cburnett, chessnut; see the LICENSE there).
- `src/engine/` — engine registry, UCI client over a Web Worker, React hook.
- `src/chessmind/` — ChessMind: tokenizer and board-code ports, inference worker, React hook, chat (`ChessMindPanel.tsx`), settings popover, prediction chips, chat commands.
- `src/simulate/` — Simulate: the game loop (`useSimulate.ts`), panel, and the Skill Level Elo table.

## Planned

- Direct chess.com import via the public games API (`https://api.chess.com/pub/player/{user}/games/{yyyy}/{mm}`).
- ChessBase: PGN export works today; native `.cbh` databases would need a separate parser.
