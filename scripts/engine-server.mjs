// Serves the Stockfish builds on their own port with CORS, so the app (on any origin) can load them.
// Usage: node scripts/engine-server.mjs [port]   (default 4174)
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const PORT = Number(process.argv[2] ?? process.env.ENGINE_PORT ?? 4174);
const ROOT = join(process.cwd(), 'public', 'engines');
const TYPES = { '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

createServer((req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    // Lets a cross-origin-isolated page (COEP: require-corp) embed these files.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'public, max-age=86400',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel.replace(/^\/engines/, ''));
  let stat;
  try {
    stat = statSync(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    res.writeHead(404, headers);
    return res.end('not found');
  }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`engine server: http://localhost:${PORT}/  (serving ${ROOT})`);
});
