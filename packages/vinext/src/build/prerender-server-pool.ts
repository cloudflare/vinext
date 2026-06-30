/**
 * Parallel prerender server pool.
 *
 * React SSR/RSC rendering during prerender is CPU-bound JS. vinext renders
 * every route by fetching it from a single in-process production server, so the
 * promise pool in `prerender.ts` only overlaps I/O — the actual rendering
 * serializes on one core. This module forks a pool of OS processes (one vinext
 * production server each, on its own ephemeral port) so the prerender phase can
 * spread rendering across cores, mirroring Next.js's static worker pool. The
 * caller load-balances per-route fetches across `ports`.
 *
 * child_process (not worker_threads) is deliberate: worker threads share the
 * process and contend badly for CPU on this workload (measured ~2× slower
 * per route and non-scaling), which is also why Next.js uses processes.
 */
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(__dirname, "prerender-server-entry.js");

/**
 * Whether the forkable worker entry exists as a runnable `.js` sibling. False
 * when vinext runs from source (e.g. the test suite transpiles `.ts` on the
 * fly and a forked plain-node child can't load `.ts`); callers fall back to the
 * single in-process server. True in the published/built package.
 */
export function prerenderPoolAvailable(): boolean {
  return fs.existsSync(WORKER_ENTRY);
}

/** Hard cap on render processes. Beyond this the main thread (which collects
 * HTML and writes files) becomes the bottleneck, so more workers don't help. */
const MAX_POOL_SIZE = 8;
/** Don't fork a dedicated process unless a worker gets at least this many
 * routes — below this the fork + bundle-import startup cost outweighs the
 * parallel-render saving (measured: a 2-worker pool only reliably beats the
 * single server from ~50 routes/worker up). */
const MIN_ROUTES_PER_WORKER = 48;
/** Rough memory budget per worker (a worker loads the whole server bundle).
 * Used to cap the pool on memory-constrained machines so K render processes
 * don't OOM. Conservative — measured ~260-380 MB/worker for a mid-size app. */
const APPROX_BYTES_PER_WORKER = 768 * 1024 * 1024;
/** Per-worker readiness timeout. */
const WORKER_READY_TIMEOUT_MS = 60_000;

export type PrerenderServerPool = {
  /** Ports of the forked render servers, for round-robin per-route fetches. */
  ports: number[];
  /**
   * Throw if any worker exited unexpectedly (i.e. not via `close()`). The
   * caller MUST call this after the render loop: a crashed worker makes every
   * route routed to it fail with a connection error, which the per-route
   * handler records as a (non-fatal) error — without this check the build
   * would emit partial output and still exit 0. Mirrors the single-process
   * design, where a server crash takes the whole build down loudly.
   */
  assertHealthy: () => void;
  /** Kill every forked server. Safe to call more than once. */
  close: () => Promise<void>;
};

/**
 * Choose how many render processes to fork for `routeCount` routes.
 *
 * Returns 1 to mean "don't fork — render in-process as before" (small apps,
 * single/dual-core, low memory, or an explicit `--prerender-concurrency 1`).
 * `maxOverride` comes from `--prerender-concurrency`.
 */
export function resolvePrerenderPoolSize(routeCount: number, maxOverride?: number): number {
  const cores = Math.max(1, os.availableParallelism());
  // Leave one core for the main thread (fetch + file writes) and OS.
  const byCores = Math.max(1, Math.min(cores - 1, MAX_POOL_SIZE));
  // Cap by available memory so K bundles don't OOM on constrained CI.
  const byMemory = Math.max(1, Math.floor(os.totalmem() / APPROX_BYTES_PER_WORKER));
  const cap = maxOverride && maxOverride > 0 ? Math.min(maxOverride, byCores) : byCores;
  const byRoutes = Math.floor(routeCount / MIN_ROUTES_PER_WORKER);
  return Math.max(1, Math.min(cap, byMemory, byRoutes));
}

/**
 * Fork `size` production servers against `outDir` and resolve once all are
 * listening. Each child reports its port over IPC. Rejects (and tears down any
 * already-started children) if any child fails to come up.
 */
export async function startPrerenderServerPool(
  outDir: string,
  size: number,
): Promise<PrerenderServerPool> {
  const entry = WORKER_ENTRY;
  const children: ChildProcess[] = [];
  let shuttingDown = false;
  let crash: { port?: number; code: number | null; signal: NodeJS.Signals | null } | null = null;

  const close = async (): Promise<void> => {
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
  };

  try {
    const readies = Array.from({ length: size }, () => {
      const child = fork(entry, [], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VINEXT_PRERENDER: "1",
          VINEXT_PRERENDER_OUTDIR: outDir,
        },
        // Inherit stdout/stderr so server-side errors surface; keep IPC.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      children.push(child);

      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("[vinext] prerender render server did not start within 60s"));
        }, WORKER_READY_TIMEOUT_MS);
        child.once("message", (msg: { type?: string; port?: number; error?: string }) => {
          clearTimeout(timer);
          if (msg?.type === "ready" && typeof msg.port === "number") {
            // Once ready, a later exit before close() is a crash — record it so
            // assertHealthy() can fail the build instead of shipping partial output.
            child.once("exit", (code, signal) => {
              if (!shuttingDown && !crash) {
                crash = { port: msg.port, code, signal };
              }
            });
            resolve(msg.port);
          } else {
            reject(
              new Error(`[vinext] prerender render server failed: ${msg?.error ?? "unknown"}`),
            );
          }
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        // A child killed by signal reports code === null; reject on either so an
        // OOM-killed (SIGKILL) startup fails fast instead of waiting out the 60s
        // readiness timeout.
        child.once("exit", (code, signal) => {
          if (code || signal) {
            clearTimeout(timer);
            reject(
              new Error(
                `[vinext] prerender render server exited during startup (code ${code}, signal ${signal})`,
              ),
            );
          }
        });
      });
    });

    const ports = await Promise.all(readies);
    const assertHealthy = (): void => {
      if (crash) {
        throw new Error(
          `[vinext] A prerender render worker (port ${crash.port}) exited unexpectedly ` +
            `(code ${crash.code}, signal ${crash.signal}) during the build. ` +
            `Prerender output is incomplete; failing the build. ` +
            `This is often an out-of-memory kill — try a lower --prerender-concurrency.`,
        );
      }
    };
    return { ports, assertHealthy, close };
  } catch (err) {
    await close();
    throw err;
  }
}
