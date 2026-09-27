// Loads the extension's browser scripts (plain scripts that set globals) into a sandbox for Node tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));

export function loadLib(file, extra = {}) {
  const sandbox = {
    URL, TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, btoa, atob, setTimeout, clearTimeout, Promise, Map, console,
    ...extra,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(root + file, 'utf8'), sandbox, { filename: file });
  return sandbox;
}

export const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
