// Builds a single-file page (CSS + JS inlined, no document skeleton) for publishing as an artifact.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, openSync, readSync, closeSync, copyFileSync } from 'node:fs';

const out = process.argv[2] ?? 'artifact/index.html';
execSync('npx vite build --base ./ --outDir dist-artifact', { stdio: 'inherit' });
let html = readFileSync('dist-artifact/index.html', 'utf8');
const assets = readdirSync('dist-artifact/assets');
const css = readFileSync(`dist-artifact/assets/${assets.find((f) => f.endsWith('.css'))}`, 'utf8');
const js = readFileSync(`dist-artifact/assets/${assets.find((f) => f.endsWith('.js'))}`, 'utf8');
if (js.includes('</script')) throw new Error('bundle contains </script>');
html = html.replace(/<script type="module"[^>]*><\/script>/, '');
html = html.replace(/<link rel="stylesheet"[^>]*>/, '');
const title = /<title>(.*?)<\/title>/.exec(html)?.[1] ?? 'NoteMate';
const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '<div id="root"></div>';
const page = `<title>${title}</title>\n<style>\n${css}\n</style>\n${body.trim()}\n<script type="module">\n${js}\n</script>\n`;
mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);

// Small engine files ship as-is.
for (const f of ['chunked-loader.js', 'stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'stockfish-19-lite.js', 'stockfish-19-lite.wasm', 'stockfish-19-asm.js', 'stockfish-19-single.js']) {
  mkdirSync(`${out.replace(/\/[^/]+$/, '')}/engines`, { recursive: true });
  copyFileSync(`public/engines/${f}`, `${out.replace(/\/[^/]+$/, '')}/engines/${f}`);
}

// Split large engine binaries into chunks small enough for artifact hosting.
const PART_SIZE = 12 * 1024 * 1024;
const outDir = out.replace(/\/[^/]+$/, '');
mkdirSync(`${outDir}/engines`, { recursive: true });
for (const name of ['stockfish-19-single']) {
  const src = `public/engines/${name}.wasm`;
  const size = statSync(src).size;
  const fd = openSync(src, 'r');
  const parts = [];
  for (let offset = 0, i = 0; offset < size; offset += PART_SIZE, i++) {
    const len = Math.min(PART_SIZE, size - offset);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const partName = `${name}.part${String(i).padStart(2, '0')}.wasm`;
    writeFileSync(`${outDir}/engines/${partName}`, buf);
    parts.push(partName);
  }
  closeSync(fd);
  writeFileSync(`${outDir}/engines/${name}.wasm.parts.json`, JSON.stringify({ size, parts }));
  console.log(`split ${name}.wasm into ${parts.length} parts`);
}
