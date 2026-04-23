// Multi-threaded / bounded-concurrency pool for verify jobs.
//
// Strategy:
//   • If worker_threads are available AND WORKER_THREADS=1, we spawn a pool of N threads
//     and fan tasks across them. This helps on multi-vCPU hosts (self-hosted, Docker).
//   • Otherwise (Vercel, single vCPU, or opt-out), we run a bounded-concurrency async
//     pool in the same thread — still much better than sequential, since verify is
//     I/O-bound (SMTP/IMAP/POP3 sockets), and Node's event loop handles it efficiently.
//
// Public API:
//   runPool(inputs, { concurrency }) → Promise<VerifyOutput[]>

import { verifyOne, VerifyInput, VerifyOutput } from "./verify-core";

const USE_THREADS = process.env.WORKER_THREADS === "1";

export interface PoolOptions {
  concurrency?: number;
  onResult?: (r: VerifyOutput, i: number) => void;
}

export async function runPool(
  inputs: VerifyInput[],
  opts: PoolOptions = {},
): Promise<VerifyOutput[]> {
  const concurrency = Math.max(1, Math.min(
    opts.concurrency || Number(process.env.POOL_CONCURRENCY) || 16,
    inputs.length || 1,
  ));

  if (USE_THREADS) {
    try {
      return await runWithThreads(inputs, concurrency, opts.onResult);
    } catch {
      // fall back to async pool if workers failed to spawn
    }
  }
  return runAsyncPool(inputs, concurrency, opts.onResult);
}

async function runAsyncPool(
  inputs: VerifyInput[],
  concurrency: number,
  onResult?: (r: VerifyOutput, i: number) => void,
): Promise<VerifyOutput[]> {
  const results = new Array<VerifyOutput>(inputs.length);
  let cursor = 0;
  async function worker() {
    while (cursor < inputs.length) {
      const i = cursor++;
      try {
        const r = await verifyOne(inputs[i]);
        results[i] = r;
        onResult?.(r, i);
      } catch (e: any) {
        const fail: VerifyOutput = {
          email: inputs[i].email,
          ok: false,
          smtp: null,
          imap: null,
          pop3: null,
          config: { source: "error", smtpHosts: 0, imapHosts: 0, pop3Hosts: 0 },
          elapsedMs: 0,
          error: String(e?.message || e),
        };
        results[i] = fail;
        onResult?.(fail, i);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ---------- worker_threads path ----------

async function runWithThreads(
  inputs: VerifyInput[],
  threads: number,
  onResult?: (r: VerifyOutput, i: number) => void,
): Promise<VerifyOutput[]> {
  const { Worker } = await import("worker_threads");
  const path = await import("path");
  const workerPath = path.resolve(process.cwd(), "lib/workers/verify-worker.js");

  const results = new Array<VerifyOutput>(inputs.length);
  let cursor = 0;
  let taskSeq = 0;

  const pool = await Promise.all(
    Array.from({ length: threads }, () => spawnWorker(Worker, workerPath)),
  );

  async function drain(w: Awaited<ReturnType<typeof spawnWorker>>): Promise<void> {
    while (cursor < inputs.length) {
      const i = cursor++;
      const id = ++taskSeq;
      try {
        const r = await w.submit(id, inputs[i]);
        results[i] = r;
        onResult?.(r, i);
      } catch (e: any) {
        const fail: VerifyOutput = {
          email: inputs[i].email, ok: false, smtp: null, imap: null, pop3: null,
          config: { source: "error", smtpHosts: 0, imapHosts: 0, pop3Hosts: 0 },
          elapsedMs: 0, error: String(e?.message || e),
        };
        results[i] = fail;
        onResult?.(fail, i);
      }
    }
    await w.terminate();
  }

  await Promise.all(pool.map(drain));
  return results;
}

async function spawnWorker(Worker: any, workerPath: string) {
  const w = new Worker(workerPath, { workerData: { requirePath: null } });
  const pending = new Map<number, { resolve: (v: VerifyOutput) => void; reject: (e: any) => void }>();

  await new Promise<void>((resolve, reject) => {
    const onMsg = (msg: any) => {
      if (msg?.type === "ready") {
        w.off("message", onMsg);
        w.off("error", onErr);
        resolve();
      } else if (msg?.type === "fatal" || msg?.ok === false) {
        reject(new Error(msg.error || "worker init failed"));
      }
    };
    const onErr = (e: Error) => reject(e);
    w.on("message", onMsg);
    w.on("error", onErr);
  });

  w.on("message", (msg: any) => {
    if (msg?.type !== "result") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "worker error"));
  });

  return {
    submit(id: number, input: VerifyInput): Promise<VerifyOutput> {
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ type: "task", id, input });
      });
    },
    terminate: () => w.terminate(),
  };
}
