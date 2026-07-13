/**
 * Child-process entry for a parallel prerender render server.
 *
 * Forked by `prerender-server-pool.ts`. React SSR/RSC rendering is CPU-bound
 * JS, so a single-process promise pool serializes every render on one core.
 * This entry lets the prerender phase fan rendering out across N OS processes
 * (one per core, like Next.js's static worker pool): each child starts a normal
 * vinext production server on an ephemeral port and reports it to the parent
 * over IPC. The parent then load-balances per-route fetches across the pool.
 *
 * `VINEXT_PRERENDER` / `VINEXT_PRERENDER_OUTDIR` are passed via the fork env so
 * they are set before any module loads (some server modules read the flag at
 * import time).
 */
import { startProdServer } from "../server/prod-server.js";
import { NoOpCacheHandler, setCacheHandler } from "vinext/shims/cache-handler";

async function main(): Promise<void> {
  const outDir = process.env.VINEXT_PRERENDER_OUTDIR;
  if (!outDir) {
    throw new Error("[vinext] prerender server worker: VINEXT_PRERENDER_OUTDIR not set");
  }
  // Match the single-process prerender path, which installs a NoOp cache
  // handler in the build process (prerenderPages/prerenderApp). The cache
  // handler is a process-global (globalThis + Symbol.for), so setting it here
  // makes this child render byte-identically to the in-process server — no ISR
  // / unstable_cache / fetch-cache reuse across routes within a worker.
  setCacheHandler(new NoOpCacheHandler());
  const { port } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir,
    noCompression: true,
    purpose: "prerender",
    silent: true,
  });
  if (typeof process.send === "function") {
    process.send({ type: "ready", port });
  } else {
    throw new Error("[vinext] prerender server worker: no IPC channel to parent");
  }
}

// If the parent build process dies (crash, SIGKILL, cancelled CI job), the IPC
// channel closes — exit so this listening server doesn't survive as an orphan
// holding its port and ~hundreds of MB.
process.on("disconnect", () => process.exit(0));

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (typeof process.send === "function") {
    process.send({ type: "error", error: message }, () => process.exit(1));
    return;
  }
  process.exit(1);
});
