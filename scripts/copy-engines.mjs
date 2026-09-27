// Copies the Stockfish.js builds from node_modules into public/engines so Vite serves them as static files.
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const src = 'node_modules/stockfish/bin';
const dest = 'public/engines';
mkdirSync(dest, { recursive: true });
let copied = 0;
for (const file of readdirSync(src)) {
  if (!/^stockfish-\d+.*\.(js|wasm)$/.test(file)) continue;
  const from = join(src, file);
  const to = join(dest, file);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}
console.log(`engines: ${copied} file(s) copied to ${dest}`);
