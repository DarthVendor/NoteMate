/*
 * The puzzle mode's own Stockfish (never the analysis engine, whose search follows the board and is shown to the
 * user): the configured build (the engine server at :4174 when set), else the single-threaded Lite build. One search
 * at a time, each time-boxed; started on first use.
 */
import { EngineClient } from '../engine/EngineClient';
import type { EngineSource } from '../engine/engines';
import type { EngineEval, VerifyEngine } from './puzzleVerify';
import { finished } from './puzzleVerify';

export class PuzzleEngine implements VerifyEngine {
  private client: Promise<EngineClient> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private source: () => EngineSource | null;
  private dead = false;
  constructor(source: () => EngineSource | null) {
    this.source = source;
  }

  private start(): Promise<EngineClient> {
    if (this.client) return this.client;
    const src = this.source();
    if (!src) return Promise.reject(new Error('no Stockfish build is available'));
    const ready = (async () => {
      const c = new EngineClient(src.script, src.remote);
      await new Promise<void>((resolve, reject) => {
        c.onError = (m) => reject(new Error(m));
        const timer = setTimeout(() => reject(new Error('the engine did not start')), 60_000);
        c.init().then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });
      c.onError = undefined;
      await c.setOption('Threads', 1);
      await c.setOption('Hash', 32);
      await c.newGame();
      if (this.dead) c.terminate();
      return c;
    })();
    ready.catch(() => {
      if (this.client === ready) this.client = null;
    });
    this.client = ready;
    return ready;
  }

  analyse(fen: string, limit: { depth: number; movetime: number }): Promise<EngineEval | null> {
    const done = finished(fen);
    if (done) return Promise.resolve(done);
    const job = this.chain.then(async (): Promise<EngineEval | null> => {
      if (this.dead) return null;
      const c = await this.start();
      const lines = await c.searchLines(fen, { depth: limit.depth, movetime: limit.movetime }, 1, limit.movetime + 8000);
      const top = lines[0];
      if (!top) return null;
      return { move: top.pv[0] ?? null, cp: top.cp, mate: top.mate, pv: top.pv, depth: top.depth };
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  terminate() {
    this.dead = true;
    this.client?.then((c) => c.terminate()).catch(() => undefined);
    this.client = null;
  }
}
