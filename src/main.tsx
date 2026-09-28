import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import './design/base.css';
import './index.css';
import './design/app.css';
import './design/board.css';
import './design/panels.css';
import './design/analysis.css';
import App from './App.tsx';

// Dev-only scripting hook (window.__chessmind; scripts/cm-chat.mjs): ?dev=1 or localStorage notemate.dev = '1'.
const devHook = (() => {
  try {
    return new URLSearchParams(location.search).get('dev') === '1' || localStorage.getItem('notemate.dev') === '1';
  } catch {
    return false;
  }
})();
if (devHook) void import('./chessmind/devHook').then((m) => m.installDevHook());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
