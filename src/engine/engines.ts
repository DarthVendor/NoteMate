export interface EngineBuild {
  id: string;
  name: string;
  description: string;
  /** URL of a worker script that speaks UCI over postMessage (stockfish.js style). */
  url: string;
  threaded: boolean;
  sizeMb: number;
}

export const ENGINE_BUILDS: EngineBuild[] = [
  {
    id: 'sf19-lite-single',
    name: 'Stockfish 19 Lite',
    description: 'Small NNUE net, single thread. Loads fast and is plenty strong for analysis.',
    url: 'engines/stockfish-19-lite-single.js',
    threaded: false,
    sizeMb: 1.8,
  },
  {
    id: 'sf19-lite',
    name: 'Stockfish 19 Lite (multi-thread)',
    description: 'Same small net, can use several CPU threads.',
    url: 'engines/stockfish-19-lite.js',
    threaded: true,
    sizeMb: 1.7,
  },
  {
    id: 'sf19-single',
    name: 'Stockfish 19 Full',
    description: 'Full-size NNUE net, single thread. Strongest evaluation, ~99 MB download.',
    url: 'engines/stockfish-19-single.js',
    threaded: false,
    sizeMb: 99,
  },
  {
    id: 'sf19',
    name: 'Stockfish 19 Full (multi-thread)',
    description: 'Full net with multi-threading. Strongest overall, ~99 MB download.',
    url: 'engines/stockfish-19.js',
    threaded: true,
    sizeMb: 99,
  },
  {
    id: 'sf19-asm',
    name: 'Stockfish 19 (asm.js fallback)',
    description: 'Pure JavaScript build for browsers without WebAssembly. Slow.',
    url: 'engines/stockfish-19-asm.js',
    threaded: false,
    sizeMb: 3.1,
  },
];

export const CUSTOM_ENGINE_ID = 'custom';

export interface EngineSettings {
  enabled: boolean;
  engineId: string;
  customUrl: string;
  threads: number;
  hashMb: number;
  multiPv: number;
  /** 0 = unlimited (analyse until the position changes). */
  depth: number;
  /** Base URL of a separate engine server (see scripts/engine-server.mjs). Empty = files next to the app. */
  engineBase: string;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  enabled: false,
  engineId: 'sf19-lite-single',
  customUrl: '',
  threads: 1,
  hashMb: 32,
  multiPv: 3,
  depth: 0,
  engineBase: '',
};

export interface EngineSource {
  /** Worker script URL (same-origin) or remote script URL to import (cross-origin). */
  script: string;
  /** True when the script lives on another origin and must be bootstrapped through a blob worker. */
  remote: boolean;
}

function isCrossOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

export function resolveEngineSource(
  settings: EngineSettings,
  availability: Record<string, EngineAvailability> | null,
): EngineSource | null {
  if (settings.engineId === CUSTOM_ENGINE_ID) {
    const url = settings.customUrl.trim();
    return url ? { script: url, remote: isCrossOrigin(url) } : null;
  }
  const build = ENGINE_BUILDS.find((b) => b.id === settings.engineId);
  if (!build) return null;
  const base = engineBaseUrl(settings);
  if (!base && availability?.[build.id] === 'chunked') {
    const name = build.url.replace(/^.*\//, '').replace(/\.js$/, '');
    return { script: `engines/chunked-loader.js#${name}.wasm`, remote: false };
  }
  const script = buildScriptUrl(build, base);
  return { script, remote: isCrossOrigin(script) };
}

/** 'direct' = script and wasm served as-is; 'chunked' = wasm published in parts and loaded through chunked-loader.js. */
export type EngineAvailability = 'direct' | 'chunked' | 'missing';

const head = async (url: string) => {
  try {
    return (await fetch(url, { method: 'HEAD' })).ok;
  } catch {
    return false;
  }
};

/** Normalised engine base: '' for same-origin, otherwise an absolute URL ending in '/'. */
export function engineBaseUrl(settings: Pick<EngineSettings, 'engineBase'>): string {
  const base = settings.engineBase.trim();
  if (!base) return '';
  return base.endsWith('/') ? base : `${base}/`;
}

/** Full URL of a build's script for the given base. */
export function buildScriptUrl(build: EngineBuild, base: string): string {
  if (!base) return build.url;
  return base + build.url.replace(/^engines\//, '');
}

/** Check how each bundled build is served (hosted copies split the large ones; a remote server may lack some). */
export async function probeEngineAvailability(base: string): Promise<Record<string, EngineAvailability>> {
  const result: Record<string, EngineAvailability> = {};
  await Promise.all(
    ENGINE_BUILDS.map(async (b) => {
      const script = buildScriptUrl(b, base);
      const wasm = script.replace(/\.js$/, '.wasm');
      if (b.id === 'sf19-asm') {
        result[b.id] = (await head(script)) ? 'direct' : 'missing';
        return;
      }
      if (await head(wasm)) result[b.id] = 'direct';
      else if (!base && (await head(script)) && (await head(`${wasm}.parts.json`))) result[b.id] = 'chunked';
      else result[b.id] = 'missing';
    }),
  );
  return result;
}
