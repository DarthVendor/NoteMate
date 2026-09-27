import { useCallback, useEffect, useRef, useState } from 'react';
import { EngineClient, type EngineLine } from './EngineClient';
import { DEFAULT_ENGINE_SETTINGS, engineBaseUrl, probeEngineAvailability, resolveEngineSource, type EngineAvailability, type EngineSettings } from './engines';

const STORAGE_KEY = 'notemate.engine.v1';

export type EngineStatus = 'off' | 'loading' | 'ready' | 'error';

function loadSettings(): EngineSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_ENGINE_SETTINGS, ...(JSON.parse(raw) as Partial<EngineSettings>) };
  } catch {
    /* ignore */
  }
  return DEFAULT_ENGINE_SETTINGS;
}

/**
 * The analysis engine for the current position. ``paused`` (e.g. while Simulate plays a game) stops the search
 * and does not restart it on position changes, so the analysis does not compete with the simulation for CPU.
 */
export function useEngine(fen: string, paused = false) {
  const [settings, setSettings] = useState<EngineSettings>(loadSettings);
  const [status, setStatus] = useState<EngineStatus>('off');
  const [engineName, setEngineName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<EngineLine[]>([]);
  const clientRef = useRef<EngineClient | null>(null);
  const activeSearch = useRef(0);
  const [available, setAvailable] = useState<Record<string, EngineAvailability> | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const base = engineBaseUrl(settings);
  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    const timer = setTimeout(() => {
      probeEngineAvailability(base).then((a) => {
        if (!cancelled) setAvailable(a);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const update = useCallback((patch: Partial<EngineSettings>) => setSettings((s) => ({ ...s, ...patch })), []);

  // Wait for the probe so a chunked build is not first attempted directly.
  const source = settings.enabled && available !== null ? resolveEngineSource(settings, available) : null;
  const url = source?.script ?? null;
  const remote = source?.remote ?? false;

  // (Re)create the worker when the engine build changes.
  useEffect(() => {
    if (!url) {
      setStatus('off');
      setLines([]);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setLines([]);
    setProgress(null);
    const client = new EngineClient(url, remote);
    client.onProgress = (p) => {
      if (!cancelled) setProgress(p);
    };
    clientRef.current = client;
    client.onError = (m) => {
      if (cancelled) return;
      setStatus('error');
      setError(`Could not load the engine from ${url}. ${m}`);
    };
    const off = client.onLine((line, searchId) => {
      if (searchId !== activeSearch.current) return;
      setLines((prev) => {
        const next = prev.filter((l) => l.multipv !== line.multipv);
        next.push(line);
        return next.sort((a, b) => a.multipv - b.multipv);
      });
    });
    client
      .init()
      .then(() => {
        if (cancelled) return;
        setEngineName(client.info.name);
        setStatus('ready');
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setStatus('error');
        setError(e.message);
      });
    return () => {
      cancelled = true;
      off();
      client.terminate();
      clientRef.current = null;
    };
  }, [url, remote]);

  // Push options only when they change: re-sending Threads / Hash respawns the search threads and reallocates the
  // hash table, which on every position change (Simulate, stepping through a game) pegged every CPU core.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || status !== 'ready') return;
    client.setOption('Threads', settings.threads);
    client.setOption('Hash', settings.hashMb);
    client.setOption('MultiPV', settings.multiPv);
  }, [status, settings.threads, settings.hashMb, settings.multiPv]);

  // (Re)start analysis whenever the position or search depth changes; stop it while paused.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || status !== 'ready') return;
    if (paused) {
      client.stop();
      setLines([]);
      return;
    }
    const timer = setTimeout(() => {
      setLines([]);
      activeSearch.current = client.analyse(fen, settings.depth);
    }, 120);
    return () => clearTimeout(timer);
  }, [fen, status, paused, settings.threads, settings.hashMb, settings.multiPv, settings.depth]);

  return { settings, update, status, engineName, error, lines, available, progress, paused };
}
