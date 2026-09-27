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
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
