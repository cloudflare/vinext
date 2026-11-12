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
 * `VINEXT_PRERENDER`, `NEXT_PHASE`, `VINEXT_PRERENDER_OUTDIR`, and the optional
 * `VINEXT_PRERENDER_RSC_ENTRY_PATH`, `VINEXT_PRERENDER_SERVER_DIR`, and
 * `VINEXT_PRERENDER_SERVER_ENTRY_PATH` are passed via the fork env so they are set
 * before any module loads (some server and user modules read the phase at
 * import time).
 */
import { startProdServer } from "../server/prod-server.js";
import { NoOpCacheHandler, setCacheHandler } from "vinext/shims/cache-handler";
import { registerPrerenderCloudflareLoader } from "./prerender-cloudflare-loader.js";

// A Workers server bundle can replace `globalThis.process` with a polyfill that
// has no IPC channel, so keep the real process for talking to the parent.
const nodeProcess = process;

async function main(): Promise<void> {
  const outDir = process.env.VINEXT_PRERENDER_OUTDIR;
  const rscEntryPath = process.env.VINEXT_PRERENDER_RSC_ENTRY_PATH;
  const serverDir = process.env.VINEXT_PRERENDER_SERVER_DIR;
  const serverEntryPath = process.env.VINEXT_PRERENDER_SERVER_ENTRY_PATH;
  if (!outDir) {
    throw new Error("[vinext] prerender server worker: VINEXT_PRERENDER_OUTDIR not set");
  }
  // Match the single-process prerender path, which installs a NoOp cache
  // handler in the build process (prerenderPages/prerenderApp). The cache
  // handler is a process-global (globalThis + Symbol.for), so setting it here
  // makes this child render byte-identically to the in-process server — no ISR
  // / unstable_cache / fetch-cache reuse across routes within a worker.
  setCacheHandler(new NoOpCacheHandler());
  if (process.env.VINEXT_PRERENDER_SOURCE_MAPS === "1") {
    // Mirror the build process before the server bundle loads.
    process.setSourceMapsEnabled(true);
    Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
  }
  registerPrerenderCloudflareLoader();
  const { port } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir,
    ...(rscEntryPath ? { rscEntryPath } : {}),
    ...(serverDir ? { serverDir } : {}),
    ...(serverEntryPath ? { serverEntryPath } : {}),
    noCompression: true,
    purpose: "prerender",
    silent: process.env.VINEXT_PRERENDER_SERVER_LOG !== "1",
  });
  if (typeof nodeProcess.send === "function") {
    nodeProcess.send({ type: "vinext:prerender-server-ready", port });
  } else {
    throw new Error("[vinext] prerender server worker: no IPC channel to parent");
  }
}

// If the parent build process dies (crash, SIGKILL, cancelled CI job), the IPC
// channel closes — exit so this listening server doesn't survive as an orphan
// holding its port and ~hundreds of MB.
nodeProcess.on("disconnect", () => nodeProcess.exit(0));

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (typeof nodeProcess.send === "function") {
    nodeProcess.send({ type: "vinext:prerender-server-error", error: message }, () =>
      nodeProcess.exit(1),
    );
    return;
  }
  nodeProcess.exit(1);
});
