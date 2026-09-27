// Hosts the built app and the engine server as two endpoints.
import { spawn } from 'node:child_process';

const APP_PORT = process.env.APP_PORT ?? '4173';
const ENGINE_PORT = process.env.ENGINE_PORT ?? '4174';

const run = (cmd, args, name) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', (code) => {
    console.log(`${name} exited (${code})`);
    process.exit(code ?? 0);
  });
  return p;
};

run('node', ['scripts/engine-server.mjs', ENGINE_PORT], 'engine server');
run('npx', ['vite', 'preview', '--port', APP_PORT, '--strictPort'], 'app');
console.log(`\napp:     http://localhost:${APP_PORT}/\nengines: http://localhost:${ENGINE_PORT}/  (set this as "Engine server" in the app)\n`);
