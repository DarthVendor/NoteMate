// Copies onnxruntime-web's CPU (single-thread-capable SIMD) runtime into public/ort/, so the ChessMind worker loads it
// from the app's own origin. The artifact host only allows *scripts* from CDNs, not fetches of .wasm files, and the
// WebGPU runtime (26.8 MB) exceeds its 15 MB per-file limit, so the CPU build is used everywhere.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';

const src = 'node_modules/onnxruntime-web/dist';
const files = ['ort.wasm.min.js', 'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
mkdirSync('public/ort', { recursive: true });
for (const f of files) copyFileSync(`${src}/${f}`, `public/ort/${f}`);
console.log(`ort: copied ${files.length} files to public/ort (${(statSync('public/ort/ort-wasm-simd-threaded.wasm').size / 1e6).toFixed(1)} MB wasm)`);
