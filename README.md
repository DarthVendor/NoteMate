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

- **Move pieces** by dragging or click-click. Promotion shows a piece chooser.
- **Arrows**: right-drag between squares. Right-click a square to circle it. Hold Shift (red), Alt (blue) or Ctrl (yellow) for other colours. Drawing the same shape again removes it.
- **Sticky notes**: the right panel shows notes for the current position. Click a coloured **+** to add one. Notes on other positions are listed below and are clickable. Moves with notes or arrows get a badge in the move list.
- **Variations**: playing a different move from any position creates a branch. The move list shows alternatives indented under the move they replace. Use ↑/↓ to switch between alternatives, "Make main line" to promote one, and "Delete from here" to prune.
- **Navigation**: ← → Home End, or click a move. `F` flips the board.
- **Import / export**: "Import PGN" accepts pasted PGN or a `.pgn` file (chess.com and ChessBase both export PGN). Nested variations are imported and `{comments}` become sticky notes. "Copy PGN" writes the full tree back out with notes as comments.
- **Engine**: tick "Engine". Pick a model in the dropdown (Stockfish 19 Lite or Full, single or multi-threaded, or a custom UCI worker URL). Adjust threads, number of lines, depth (0 = infinite) and hash. Click a line's score to play its first move. The blue arrow on the board is the engine's top move.

The Full builds are ~99 MB and can take a minute to download and compile on first use; the browser caches them afterwards. Multi-threaded builds need the page to be cross-origin isolated. The Vite dev and preview servers already send the required `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers; a production host must send the same.

Everything is saved to `localStorage` (game, annotations, engine settings).

## ChessMind (in-browser language model)

The **ChessMind** panel runs a [ChessMind](../ChessMind) model in the browser: onnxruntime-web 1.30.0 from cdnjs in a Web Worker (single-threaded wasm; WebGPU selectable), the model fetched in <= 14 MB chunks and cached with the Cache API.

- **Predicted move**: the model's top 5 legal moves for the current position with probabilities, drawn as purple arrows. Click one to play it; **pin arrows** saves them on the position like your own arrows.
- **Ask ChessMind**: questions in the model's dialogue format, streamed (60-token cap, Stop button); moves inside a line are sampled from legal moves only. Each move of an answer's line is clickable: it inserts the line as a variation (from the start position, or from the asked-at position with "lines from this position") and jumps there. **Play through**, **keep as main line** and **discard** work on that variation. The answer's text becomes purple ChessMind sticky notes (text before a line on its start node, text after it on its last node). The chat is saved with the game and cleared on New game.
- **Board commands** typed in the same box are handled locally: `back 2`, `forward`, `go to move 12`, `start`, `end`, `flip`, `next variation`, `make this the main line`, `delete this line`, `add note: …`, `arrow e2 e4 red`, `highlight e4`, `clear arrows`, `new game`, SAN moves (`Nf3`), and `what should I play?` / `analyse` (top moves plus a short model comment).
- **Advanced**: for board-embedding models, predictions can read only the last 8/16/32 plies (the board input carries the position).

Models come from ChessMind's `scripts/export_onnx.py` (see its README). `npm run chessmind` (also run by `dev`, `build` and `host`) copies `../ChessMind/export/onnx/*` (or `$CHESSMIND_EXPORT`) into `public/chessmind/<name>/` (git-ignored) and writes `public/chessmind/models.json`; the first entry is the default. `node scripts/test-chessmind.mjs` checks the JS board encoding against the Python fixture.

For a claude.ai artifact, `node scripts/build-artifact.mjs <dir>/index.html --no-full-engine` builds the page and copies the models to `<dir>/chessmind/`. `--no-full-engine` leaves out the 99 MB Stockfish Full chunks, because an artifact version is capped at 256 MB.

## Simulate (ChessMind vs Stockfish)

The collapsible **Simulate** panel (under ChessMind) plays the selected ChessMind model against Stockfish on the board.

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
- `src/components/StickyNotes.tsx`, `MoveList.tsx`, `Toolbar.tsx`, `PgnImport.tsx`, `EnginePanel.tsx`, `EvalBar.tsx`.
- `src/engine/` — engine registry, UCI client over a Web Worker, React hook.
- `src/chessmind/` — ChessMind: tokenizer and board-code ports, inference worker, React hook, panel, chat commands.
- `src/simulate/` — Simulate: the game loop (`useSimulate.ts`), panel, and the Skill Level Elo table.

## Planned

- Direct chess.com import via the public games API (`https://api.chess.com/pub/player/{user}/games/{yyyy}/{mm}`).
- ChessBase: PGN export works today; native `.cbh` databases would need a separate parser.
