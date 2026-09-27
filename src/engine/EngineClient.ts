/** Minimal UCI client around a stockfish.js-style Web Worker. */

export interface EngineLine {
  multipv: number;
  depth: number;
  seldepth?: number;
  /** Centipawns from the side to move's point of view. */
  cp?: number;
  /** Mate in N (negative = getting mated), side to move's point of view. */
  mate?: number;
  nodes?: number;
  nps?: number;
  /** Principal variation in UCI long algebraic notation. */
  pv: string[];
}

export interface UciOption {
  name: string;
  type: string;
  default?: string;
  min?: number;
  max?: number;
}

export interface EngineInfo {
  name: string;
  options: UciOption[];
}

type Listener = (line: EngineLine, searchId: number) => void;

export class EngineClient {
  private worker: Worker;
  private lineListeners = new Set<Listener>();
  private waiters: { match: (line: string) => boolean; resolve: (line: string) => void }[] = [];
  private searchId = 0;
  private searching = false;
  private acceptingInfo = false;
  private queued: { fen: string; depth: number } | null = null;
  readonly info: EngineInfo = { name: 'engine', options: [] };
  onError?: (message: string) => void;
  /** Download progress (0-100) reported by chunked-loader.js while fetching a large build. */
  onProgress?: (percent: number) => void;

  private blobUrl: string | null = null;

  /**
   * @param url Worker script. When `remote` is true the script is on another origin, which
   * `new Worker` forbids, so a same-origin blob worker imports it instead. stockfish.js reads its
   * wasm location from the worker URL's hash, so the remote .wasm URL is passed there.
   */
  constructor(url: string, remote = false) {
    if (remote) {
      const abs = new URL(url, location.href).href;
      const wasm = abs.replace(/\.js(\?.*)?$/, '.wasm');
      // Multi-threaded builds spawn helper workers at location.origin + location.pathname + '#…',
      // which is malformed for a blob: URL, so map that prefix back onto this blob URL.
      const bootstrap = [
        '(function(){',
        'var RealWorker = self.Worker;',
        'var bad = self.location.origin + self.location.pathname;',
        'var good = self.location.href.split("#")[0];',
        'self.Worker = function(url, opts){ url = String(url); if (url.indexOf(bad) === 0) url = good + url.slice(bad.length); return new RealWorker(url, opts); };',
        `importScripts(${JSON.stringify(abs)});`,
        '})();',
      ].join('\n');
      this.blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'application/javascript' }));
      this.worker = new Worker(`${this.blobUrl}#${encodeURIComponent(wasm)}`);
    } else {
      this.worker = new Worker(url);
    }
    this.worker.onmessage = (e: MessageEvent) => this.handle(String(e.data));
    this.worker.onerror = (e) => this.onError?.(e.message || 'engine worker error');
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private wait(match: (line: string) => boolean, timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error('engine timed out'));
        }
      }, timeoutMs);
    });
  }

  /** Raw output tap used by bestMove(). */
  private tap: ((line: string) => void) | null = null;

  private handle(line: string) {
    this.tap?.(line);
    for (const w of [...this.waiters]) {
      if (w.match(line)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
    const progress = /^info string download (\d+)%$/.exec(line);
    if (progress) {
      this.onProgress?.(Number(progress[1]));
      return;
    }
    if (line.startsWith('id name ')) this.info.name = line.slice(8);
    else if (line.startsWith('option name ')) this.info.options.push(parseOption(line));
    else if (line.startsWith('info ') && this.acceptingInfo) {
      const parsed = parseInfo(line);
      if (parsed) for (const l of this.lineListeners) l(parsed, this.searchId);
    } else if (line.startsWith('bestmove')) {
      this.searching = false;
      this.acceptingInfo = false;
      if (this.queued) {
        const q = this.queued;
        this.queued = null;
        this.startSearch(q.fen, q.depth);
      }
    }
  }

  /** Handshake. Large builds can take minutes to download and compile, so the timeout is generous. */
  async init(): Promise<EngineInfo> {
    const ready = this.wait((l) => l === 'uciok', 10 * 60 * 1000);
    this.send('uci');
    await ready;
    return this.info;
  }

  async setOption(name: string, value: string | number) {
    this.send(`setoption name ${name} value ${value}`);
  }

  async isReady() {
    const p = this.wait((l) => l === 'readyok');
    this.send('isready');
    await p;
  }

  onLine(listener: Listener) {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  /** Analyse a position. Any running search is stopped first. Returns the id of the new search. */
  analyse(fen: string, depth = 0): number {
    if (this.searching) {
      this.queued = { fen, depth };
      this.acceptingInfo = false;
      this.send('stop');
      return this.searchId + 1;
    }
    return this.startSearch(fen, depth);
  }

  private startSearch(fen: string, depth: number): number {
    this.searchId++;
    this.searching = true;
    this.acceptingInfo = true;
    this.send(`position fen ${fen}`);
    this.send(depth > 0 ? `go depth ${depth}` : 'go infinite');
    return this.searchId;
  }

  /** Start a new game (clears the hash) and wait until the engine is ready. */
  async newGame() {
    this.send('ucinewgame');
    await this.isReady();
  }

  /**
   * One search with a time or node limit, for playing rather than analysing. Resolves with the best move
   * (null when there is none) and the last principal line's score (side to move's point of view).
   * Meant for a dedicated client: a running analysis is stopped first.
   */
  async bestMove(fen: string, limit: { movetime?: number; nodes?: number }, timeoutMs = 120000): Promise<{ move: string | null; cp?: number; mate?: number; depth?: number }> {
    if (this.searching) {
      const stopped = this.wait((l) => l.startsWith('bestmove'), 10000).catch(() => '');
      this.stop();
      await stopped;
    }
    const cap: { line?: EngineLine } = {};
    this.tap = (l) => {
      if (!l.startsWith('info ')) return;
      const parsed = parseInfo(l);
      if (parsed && parsed.multipv === 1) cap.line = parsed;
    };
    const done = this.wait((l) => l.startsWith('bestmove'), timeoutMs);
    this.searching = true;
    this.acceptingInfo = false;
    this.send(`position fen ${fen}`);
    this.send(limit.nodes ? `go nodes ${Math.max(1, Math.round(limit.nodes))}` : `go movetime ${Math.max(1, Math.round(limit.movetime ?? 100))}`);
    try {
      const line = await done;
      const mv = line.split(/\s+/)[1];
      return { move: mv && mv !== '(none)' && mv !== '0000' ? mv : null, cp: cap.line?.cp, mate: cap.line?.mate, depth: cap.line?.depth };
    } finally {
      this.tap = null;
    }
  }

  stop() {
    this.queued = null;
    this.acceptingInfo = false;
    if (this.searching) this.send('stop');
  }

  terminate() {
    this.stop();
    this.worker.terminate();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
  }
}

function parseOption(line: string): UciOption {
  const m = /^option name (.+?) type (\S+)(?: default (\S*))?(?: min (-?\d+))?(?: max (-?\d+))?/.exec(line);
  if (!m) return { name: line, type: 'unknown' };
  return {
    name: m[1],
    type: m[2],
    default: m[3],
    min: m[4] !== undefined ? Number(m[4]) : undefined,
    max: m[5] !== undefined ? Number(m[5]) : undefined,
  };
}

function parseInfo(line: string): EngineLine | null {
  const t = line.split(/\s+/);
  const out: EngineLine = { multipv: 1, depth: 0, pv: [] };
  let sawScore = false;
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = Number(t[++i]); break;
      case 'seldepth': out.seldepth = Number(t[++i]); break;
      case 'multipv': out.multipv = Number(t[++i]); break;
      case 'nodes': out.nodes = Number(t[++i]); break;
      case 'nps': out.nps = Number(t[++i]); break;
      case 'score': {
        const kind = t[++i];
        const val = Number(t[++i]);
        if (kind === 'cp') out.cp = val;
        else if (kind === 'mate') out.mate = val;
        sawScore = true;
        break;
      }
      case 'pv':
        out.pv = t.slice(i + 1);
        i = t.length;
        break;
      // Skip values we don't use.
      case 'currmove': case 'currmovenumber': case 'hashfull': case 'tbhits': case 'time': case 'cpuload':
        i++;
        break;
      case 'string':
        return null;
    }
  }
  return sawScore && out.pv.length > 0 ? out : null;
}
