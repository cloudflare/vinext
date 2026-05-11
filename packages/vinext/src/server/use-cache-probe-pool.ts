/**
 * Dev-only "use cache" probe worker pool.
 *
 * Uses Node.js worker_threads to re-execute a cached function in isolation.
 * The worker bypasses the ESM cache by appending ?v=probe-<timestamp> to the
 * module URL, giving it a fresh module scope.
 *
 * The pool is torn down on HMR / file invalidation so the next probe starts
 * with empty module caches.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { setUseCacheProbe, type UseCacheProbeRequestSnapshot } from "./use-cache-probe-globals.js";

let pool: WorkerPool | undefined;

type UseCacheProbePoolOptions = {
  /** Called whenever the dev server invalidates caches (HMR, route recompile). */
  onInvalidate?: (callback: () => void) => void;
};

type ProbeMessage = {
  modulePath: string;
  functionId: string;
  variant: string;
  encodedArguments: string;
  request: UseCacheProbeRequestSnapshot;
  timeoutMs: number;
};

type WorkerPool = {
  runProbe(msg: ProbeMessage): Promise<boolean>;
  end(): Promise<void>;
};

function getWorkerPath(): string {
  const poolDir = fileURLToPath(new URL(".", import.meta.url));
  // When running from source the file is .ts; when built it's .js.
  const tsPath = path.join(poolDir, "use-cache-probe-worker.ts");
  if (fs.existsSync(tsPath)) return tsPath;
  return path.join(poolDir, "use-cache-probe-worker.js");
}

function createWorkerPool(): WorkerPool {
  // Lazy-import worker_threads so this module can be loaded in contexts
  // where Node.js built-ins are unavailable (e.g. browser builds, though
  // this whole path is dev-only and never reached in production).
  const { Worker } = require("node:worker_threads") as typeof import("node:worker_threads");

  const workerPath = getWorkerPath();

  // Inherit parent's execArgv so tsx loader (or any other loader) propagates
  // to the worker. This lets the worker import .ts files when the parent runs
  // under tsx (the common vinext dev workflow).
  const execArgv = [...process.execArgv];

  const worker = new Worker(workerPath, {
    execArgv,
    stderr: true,
    stdout: true,
  });

  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (v: boolean) => void; reject: (e: unknown) => void }
  >();

  worker.on(
    "message",
    (msg: { id: number; completed: boolean } | { id: number; error: string }) => {
      const handler = pending.get(msg.id);
      if (!handler) return;
      pending.delete(msg.id);
      if ("error" in msg) {
        handler.reject(new Error(msg.error));
      } else {
        handler.resolve(msg.completed);
      }
    },
  );

  worker.on("error", (err: Error) => {
    for (const [, handler] of pending) {
      handler.reject(err);
    }
    pending.clear();
  });

  worker.on("exit", (code: number) => {
    if (code !== 0) {
      for (const [, handler] of pending) {
        handler.reject(new Error(`Probe worker exited with code ${code}`));
      }
      pending.clear();
    }
  });

  return {
    runProbe(msg: ProbeMessage): Promise<boolean> {
      const id = ++nextId;
      return new Promise<boolean>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, ...msg });
      });
    },
    async end(): Promise<void> {
      await worker.terminate().catch(() => {});
    },
  };
}

function getPool(): WorkerPool {
  if (!pool) {
    pool = createWorkerPool();
  }
  return pool;
}

async function tearDownPool(): Promise<void> {
  const current = pool;
  if (!current) return;
  pool = undefined;
  await current.end().catch(() => {});
}

export function installUseCacheProbePool(options?: UseCacheProbePoolOptions): void {
  if (options?.onInvalidate) {
    options.onInvalidate(() => {
      void tearDownPool();
    });
  }

  setUseCacheProbe(async (args) => {
    let activePool: WorkerPool;
    try {
      activePool = getPool();
    } catch {
      return false;
    }

    try {
      return await activePool.runProbe({
        modulePath: args.modulePath,
        functionId: args.id,
        variant: args.variant,
        encodedArguments: args.encodedArguments,
        request: args.request,
        timeoutMs: args.timeoutMs,
      });
    } catch {
      await tearDownPool();
      return false;
    }
  });
}
