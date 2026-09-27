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

## Layout

- `src/state/gameReducer.ts` — game model: a tree of `MoveNode`s (first child = main line) with annotations attached to nodes.
- `src/state/pgn.ts` — PGN parser (variations, comments, NAGs) and writer.
- `src/components/Board.tsx` — board, pointer handling for moves and shape drawing.
- `src/components/ArrowLayer.tsx` — SVG arrows and highlight circles.
- `src/components/StickyNotes.tsx`, `MoveList.tsx`, `Toolbar.tsx`, `PgnImport.tsx`, `EnginePanel.tsx`, `EvalBar.tsx`.
- `src/engine/` — engine registry, UCI client over a Web Worker, React hook.

## Planned

- Direct chess.com import via the public games API (`https://api.chess.com/pub/player/{user}/games/{yyyy}/{mm}`).
- ChessBase: PGN export works today; native `.cbh` databases would need a separate parser.
