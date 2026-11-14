import { Worker } from "node:worker_threads";
import type { SubtrExtract } from "@rl/metrics";

export interface SubtrWorkerOptions {
  /** The bundled worker (desktop app). Without it, runs worker.ts through tsx (development). */
  workerPath?: string;
  /** subtr-actor's .wasm file. Without it, the one in node_modules. */
  wasmPath?: string;
  /** Stop the worker after this long without work, to give its memory back. */
  idleMs?: number;
  /** Give up on a replay after this long. */
  timeoutMs?: number;
}

/** The parser itself couldn't run (missing or broken WASM, the worker didn't start): no replay's fault. */
export class SubtrSetupError extends Error {}

/** One worker thread running subtr-actor, started when needed. */
export class SubtrWorker {
  private worker: Worker | null = null;
  private next = 1;
  private pending = new Map<number, { resolve: (x: SubtrExtract) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SubtrWorkerOptions = {}) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = this.opts.workerPath
      ? new Worker(this.opts.workerPath, { workerData: { wasmPath: this.opts.wasmPath } })
      : new Worker(new URL("./worker.ts", import.meta.url), { workerData: { wasmPath: this.opts.wasmPath }, execArgv: ["--import", "tsx"] });
    w.unref();
    w.on("message", (m: { id: number; ok: boolean; setup?: boolean; extract?: SubtrExtract; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.extract!);
      else p.reject(m.setup ? new SubtrSetupError(m.error ?? "the replay parser couldn't start") : new Error(m.error ?? "subtr-actor failed"));
      this.scheduleIdle();
    });
    const fail = (e: Error) => {
      // A worker stopped on purpose (idle, timeout) may exit after a new one started: leave that one alone.
      if (this.worker !== w) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
      this.worker = null;
    };
    w.on("error", (e) => fail(new SubtrSetupError(`the replay parser failed: ${e.message}`)));
    w.on("exit", (code) => fail(new SubtrSetupError(`the replay parser stopped (exit ${code})`)));
    this.worker = w;
    return w;
  }

  private scheduleIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.pending.size) return;
    this.idleTimer = setTimeout(() => void this.close(), this.opts.idleMs ?? 120_000);
    this.idleTimer.unref();
  }

  /** Parse a replay file. */
  extract(path: string): Promise<SubtrExtract> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const w = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("parsing the replay took too long"));
        void this.close();
      }, this.opts.timeoutMs ?? 180_000);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, path });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}
