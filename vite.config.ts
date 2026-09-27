import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COOP/COEP make the page cross-origin isolated, which the multi-threaded
// Stockfish builds need for SharedArrayBuffer.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  // Piece sets ship as separate files so only the chosen set is fetched (and the main bundle stays small).
  build: { assetsInlineLimit: (file: string) => (file.includes('/pieces/') ? false : undefined) },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
