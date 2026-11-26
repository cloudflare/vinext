/**
 * Process-level backstop for errors that escape per-connection /
 * per-request error guards.
 *
 * Three real call sites in vinext that hit this with peer-disconnect
 * errors:
 *   - `fromWeb(fetch().body).pipe(res)` in proxyExternalRewriteNode.
 *   - Streaming surfaces inside `@vitejs/plugin-rsc` with their own
 *     pipe topology (destinations aren't inbound connection sockets).
 *   - Outbound sockets created by middleware `fetch()`.
 *
 * Node's `pipe()` re-emits source errors onto the destination when
 * the destination has no `'error'` listener, throwing synchronously
 * inside a `nextTick` callback. The throw escapes to
 * `uncaughtException`, where this listener filters it.
 *
 * Always absorbs benign static-asset `import()` rejections (see
 * `isBenignAssetImportError`). Outside prerender it also silently
 * absorbs peer-disconnect codes (ECONNRESET / EPIPE / ECONNABORTED) and
 * Node's cancelled-request-body enqueue race (see
 * `isCancelledRequestBodyEnqueueError`). Everything else depends on the
 * phase:
 *
 *   - **Running server** (`vite dev`, `vinext start`, standalone
 *     `server.js`): logged and absorbed, matching the log-only
 *     `uncaughtException` / `unhandledRejection` handlers that Next.js's
 *     `router-server.ts` installs for both `next dev` and `next start`.
 *     App code may legitimately leave a rejection unhandled for a few
 *     ticks (Next.js's documented "Preloading data" pattern,
 *     fire-and-forget calls), and request input can often choose whether
 *     it rejects, so crashing would let one anonymous request take down
 *     the whole process. The dev server's `configureServer` hook and
 *     `startProdServer()` opt in via `{ runningServer: true }`.
 *   - **Prerender render worker** (forked by `build/prerender-server-pool.ts`,
 *     opted in by `build/prerender-server-entry.ts` via
 *     `{ prerenderWorker: true }`): an unhandled rejection is logged and
 *     absorbed, matching Next.js's static export worker
 *     (`packages/next/src/export/worker.ts`). A rejection left floating by
 *     app code at module scope or during a render (e.g. a
 *     `"URL dependency"` `import()`) can't change the output of a render
 *     that never awaited it, and Next.js still builds. Like that worker,
 *     an unhandled framework signal (`notFound()`, `redirect()`,
 *     `forbidden()`, `unauthorized()`, dynamic usage, bailout to client
 *     rendering) is ignored. An uncaught exception is reported and ends
 *     the worker, which fails the build: a framework signal with Next.js's
 *     message and {@link FATAL_UNHANDLED_NEXT_API_EXIT_CODE}, anything
 *     else with exit code 1, since vinext has no per-page generation
 *     timeout to release a request the throw left waiting.
 *   - **Build**, including the build process during prerender:
 *     synchronously re-thrown, preserving Node's default crash semantics,
 *     as Next.js's build process exits on these errors.
 *
 * **Installed at module load.** Earlier iterations tried to gate
 * install via Vite's `config()` hook (`command === "serve"`) so it
 * was strictly dev-only, but the hook didn't fire reliably in
 * vite-plus's lifecycle — install was silently skipped. The
 * connection-level guard from #911 confirms `configureServer`-tied
 * lifecycle hooks are timing-fragile too. Module-load install is
 * the only place reliably observed to fire (verified via the
 * `VINEXT_DEBUG_SOCKET_ERRORS` marker).
 *
 * **Prerender check is dynamic, not install-time.** Prerender (in
 * `build/prerender.ts` and `build/run-prerender.ts`) calls
 * `startProdServer()` from inside `vite build`, or in forked render
 * workers, to render pages against a real HTTP server. It sets
 * `VINEXT_PRERENDER=1` for its own purposes, and the listener checks it
 * at fire time. Doing the check at install time wouldn't work:
 * `index.ts` loads at Vite plugin import, well before prerender starts,
 * so by the time `VINEXT_PRERENDER` is set the listener has already
 * been installed (we cannot uninstall and re-install per phase).
 *
 * In a render worker every other unhandled rejection is logged rather
 * than absorbed silently, peer disconnects included, as Next.js's export
 * worker logs them. Only benign asset-import errors and unhandled
 * framework-signal rejections pass without a log line. A render that a
 * dropped connection breaks fails on its own, so the route is reported
 * where it rendered. The in-process prerender server, used only when
 * vinext runs from source, shares the build process and keeps its
 * re-throw.
 *
 * **Test skip is install-time.** Vitest workers that import
 * `index.ts` directly should never have the listener installed —
 * peer-disconnect errors during test runs should surface normally.
 * `process.env.VITEST === "true"` is set by Vitest in every worker;
 * `NODE_ENV === "test"` covers other test runners that follow the
 * standard convention, except for a running server or a prerender render
 * worker, which install the listener whatever NODE_ENV is, as Next.js's
 * router server and export worker do.
 *
 * **Listener ordering.** `index.ts` is imported synchronously at the
 * top of every user's `vite.config.ts`, so vinext's listener registers
 * before most user / tooling listeners (Sentry, OpenTelemetry,
 * structured logging). For peer-disconnect codes the early-return is
 * fine, and on a running production server (or for an unhandled
 * rejection in a prerender render worker) every other error is logged
 * without throwing, so later listeners still observe it. In the re-throw
 * phase the synchronous re-throw still crashes the process with the
 * original stack, but listeners registered after vinext don't observe the
 * event. Users who need crash-reporter visibility there must register
 * their handler before importing vinext.
 *
 * **Symbol.for caveat.** `Symbol.for("vinext.socketErrorBackstop")`
 * is process-global, so if two different vinext versions are loaded
 * in the same process the first to evaluate wins and the second's
 * filter rules silently don't apply.
 *
 * Set `VINEXT_DEBUG_SOCKET_ERRORS=1` to log a one-line marker each
 * time the listener absorbs an error.
 */
import { isValidNavigationSignalError } from "../utils/navigation-signal.js";

const SOCKET_BACKSTOP_FLAG = Symbol.for("vinext.socketErrorBackstop");
const RUNNING_SERVER_FLAG = Symbol.for("vinext.socketErrorBackstop.runningServer");
const PRERENDER_WORKER_FLAG = Symbol.for("vinext.socketErrorBackstop.prerenderWorker");

/**
 * The exit code of a prerender that hit an uncaught framework signal, as
 * Next.js's export worker exits with (`FATAL_UNHANDLED_NEXT_API_EXIT_CODE`).
 */
export const FATAL_UNHANDLED_NEXT_API_EXIT_CODE = 78;

type BackstopProcess = typeof process & {
  [SOCKET_BACKSTOP_FLAG]?: true;
  [RUNNING_SERVER_FLAG]?: true;
  [PRERENDER_WORKER_FLAG]?: true;
};

/**
 * Pure predicate: returns the peer-disconnect code when `err` carries
 * one of `ECONNRESET` / `EPIPE` / `ECONNABORTED`, otherwise `undefined`.
 * Exported for unit testing in isolation (no process-state mutation).
 */
export function peerDisconnectCode(err: unknown): string | undefined {
  const code = (err as { code?: string } | null)?.code;
  return code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" ? code : undefined;
}

// Static-asset extensions that a bundled server module may reference via
// `new URL("./asset", import.meta.url)`. A dynamic `import()` of such a URL
// can never resolve on Node (these are not ES modules), so when a user module
// leaves one as a floating side-effect — e.g.
//   import(new URL("./style.css", import.meta.url).href)
// — Node throws ERR_UNKNOWN_FILE_EXTENSION (asset present) or
// ERR_MODULE_NOT_FOUND (asset not co-located with the chunk). Next.js treats
// these "URL dependency" side-effects as build-safe (the test fixture comment
// literally reads "it shouldn't break the build"), so the prerender backstop
// must not crash on them. Kept deliberately narrow: JS/TS module extensions
// are excluded so a genuine missing-module bug is still reported.
const STATIC_ASSET_IMPORT_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".txt",
  ".md",
  ".csv",
  ".xml",
  ".pdf",
  ".wasm",
]);

/**
 * Pure predicate: returns `true` when `err` is a benign failure from a
 * dynamic `import()` of a static asset URL — the "URL dependency" pattern
 * that Next.js tolerates at build time. Two shapes are recognised:
 *
 *   - `ERR_UNKNOWN_FILE_EXTENSION`: the asset resolved on disk but is not an
 *     ES module (e.g. a co-located `./style.css`). The error message ends in
 *     the offending extension in quotes: `... extension ".css" for /path`.
 *   - `ERR_MODULE_NOT_FOUND`: the asset URL did not resolve (the chunk lives
 *     in `dist/server/` but the source asset does not). Node attaches the
 *     unresolved specifier on `err.url`; we match only when it points at a
 *     static-asset extension.
 *
 * Anything outside this allow-list (including missing `.js`/`.mjs`/`.ts`
 * modules with no extension) returns `false` so real bugs are still reported.
 * Exported for unit testing in isolation.
 */
export function isBenignAssetImportError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;

  if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
    const message = (err as { message?: string }).message ?? "";
    const match = /extension\s+"([^"]+)"/.exec(message);
    return match != null && STATIC_ASSET_IMPORT_EXTENSIONS.has(match[1].toLowerCase());
  }

  if (code === "ERR_MODULE_NOT_FOUND") {
    const url = (err as { url?: unknown }).url;
    if (typeof url !== "string") return false;
    const pathname = url.split("?", 1)[0].split("#", 1)[0];
    const dot = pathname.lastIndexOf(".");
    if (dot === -1) return false;
    return STATIC_ASSET_IMPORT_EXTENSIONS.has(pathname.slice(dot).toLowerCase());
  }

  return false;
}

/**
 * Pure predicate: returns `true` when `err` is Node's
 * `Readable.toWeb()` adapter enqueueing into a request body stream that was
 * already cancelled. `pull()` calls `req.resume()`, which schedules `flow()`
 * on `nextTick`; if the body is cancelled before that tick runs, `flow()`
 * still emits the chunks already buffered in `req` and the adapter's
 * `onData` throws inside the `nextTick` callback. srvx (used by
 * `@vitejs/plugin-rsc` in dev) builds `request.body` this way, so any
 * cancelled request body, e.g. an oversized Server Action, can crash the
 * dev server. Node main drops that data instead (`if (wasCanceled) return;`
 * in `onData`), so absorbing it matches upstream behaviour. Exported for
 * unit testing in isolation.
 */
export function isCancelledRequestBodyEnqueueError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const { code, message, stack } = err as { code?: string; message?: string; stack?: string };
  return (
    code === "ERR_INVALID_STATE" &&
    typeof message === "string" &&
    message.includes("Controller is already closed") &&
    typeof stack === "string" &&
    /\.onData \(node:internal\/webstreams\/adapters:\d+/.test(stack)
  );
}

/**
 * Next.js's `isDynamicUsageError`, the errors its export worker never logs:
 * a valid navigation signal (`redirect()`, `notFound()`, `forbidden()`,
 * `unauthorized()`), dynamic server usage, or a bailout to client rendering.
 * Navigation digests are validated in full, as Next.js's `isNextRouterError`
 * does, so an arbitrary digest prefix can't hide a real error.
 */
function isFrameworkSignalError(err: unknown): boolean {
  if (isValidNavigationSignalError(err)) return true;
  if (err === null || typeof err !== "object" || !("digest" in err)) return false;
  const digest = (err as { digest: unknown }).digest;
  return digest === "DYNAMIC_SERVER_USAGE" || digest === "BAILOUT_TO_CLIENT_SIDE_RENDERING";
}

/**
 * Test-only: returns whether the backstop has been installed in this
 * process. Used by the unit test to assert idempotent install via the
 * Symbol.for guard. Not part of the public API.
 */
export function isSocketErrorBackstopInstalled(): boolean {
  return Boolean((process as BackstopProcess)[SOCKET_BACKSTOP_FLAG]);
}

/**
 * Installs the backstop once per process. Pass `{ runningServer: true }`
 * from a long-lived production server to log, rather than re-throw,
 * errors outside the absorbed set, and `{ prerenderWorker: true }` from a
 * forked prerender render worker for its prerender handling. The flags are
 * process-global and sticky, so they also apply when `index.ts` installed
 * the listeners first.
 */
export function installSocketErrorBackstop(
  options: { prerenderWorker?: boolean; runningServer?: boolean } = {},
): void {
  const proc = process as BackstopProcess;
  if (options.runningServer) proc[RUNNING_SERVER_FLAG] = true;
  if (options.prerenderWorker) proc[PRERENDER_WORKER_FLAG] = true;
  if (proc[SOCKET_BACKSTOP_FLAG]) return;
  if (process.env.VITEST === "true") return;
  // A running server or a prerender render worker installs it whatever
  // NODE_ENV is, as `next start`, `next dev` and Next.js's export worker
  // install their handlers. A test runner that sets NODE_ENV=test (Jest) can
  // still start one as a separate process, and a build keeps NODE_ENV=test
  // for its workers.
  if (process.env.NODE_ENV === "test" && !options.runningServer && !options.prerenderWorker) {
    return;
  }
  proc[SOCKET_BACKSTOP_FLAG] = true;

  const debug = process.env.VINEXT_DEBUG_SOCKET_ERRORS === "1";
  if (debug) console.warn("[vinext] socket-error backstop installed");

  // A floating `import(new URL("./asset", import.meta.url).href)` in user
  // module-load code is a "URL dependency" side-effect that Next.js compiles
  // without crashing. On Node the dynamic import rejects (a static asset is
  // not an ES module), and because the promise is never awaited the rejection
  // surfaces as a process-level unhandledRejection/uncaughtException. Absorb
  // that narrow case in both phases — during prerender (so the build doesn't
  // fail) and during the running server (so the route can still respond) —
  // since the rejection is unrelated to any in-flight render or response.
  const absorbBenignAssetImport = (reason: unknown, kind: string): boolean => {
    if (!isBenignAssetImportError(reason)) return false;
    if (debug) {
      const code = (reason as { code?: string } | null)?.code;
      console.warn(`[vinext] absorbed ${kind} ${code} (asset URL import)`);
    }
    return true;
  };

  process.on("uncaughtException", (err: Error) => {
    if (absorbBenignAssetImport(err, "uncaughtException")) return;
    if (process.env.VINEXT_PRERENDER === "1") {
      if (!proc[PRERENDER_WORKER_FLAG]) throw err;
      if (isFrameworkSignalError(err)) {
        console.error(
          "[vinext] A Next.js API that uses exceptions to signal framework behavior was uncaught. " +
            "This suggests improper usage of a Next.js API. The original error is printed below " +
            "and the build will now exit.",
        );
        console.error(err);
        process.exit(FATAL_UNHANDLED_NEXT_API_EXIT_CODE);
      }
      // Next.js's export worker logs it and keeps rendering, but bounds each
      // page by `staticPageGenerationTimeout`. vinext has no such bound, so a
      // request left waiting on the work the throw abandoned would hang the
      // build; the worker exits with the error instead.
      console.error("[vinext] uncaughtException during prerender:", err);
      process.exit(1);
    }
    const code = peerDisconnectCode(err);
    if (code) {
      if (debug) console.warn(`[vinext] absorbed uncaughtException ${code}`);
      return;
    }
    if (isCancelledRequestBodyEnqueueError(err)) {
      if (debug)
        console.warn(
          "[vinext] absorbed uncaughtException ERR_INVALID_STATE (cancelled request body)",
        );
      return;
    }
    if (proc[RUNNING_SERVER_FLAG]) {
      console.error("[vinext] uncaughtException:", err);
      return;
    }
    throw err;
  });
  // A rejection handled after its `unhandledRejection` turn, such as a
  // preloaded promise awaited later, is expected, so Node's
  // PromiseRejectionHandledWarning is suppressed, as Next.js's router server
  // and export worker suppress it.
  process.on("rejectionHandled", () => {});
  process.on("unhandledRejection", (reason: unknown) => {
    if (absorbBenignAssetImport(reason, "unhandledRejection")) return;
    if (process.env.VINEXT_PRERENDER === "1") {
      if (!proc[PRERENDER_WORKER_FLAG]) throw reason;
      if (!isFrameworkSignalError(reason)) console.error("[vinext] unhandledRejection:", reason);
      return;
    }
    const code = peerDisconnectCode(reason);
    if (code) {
      if (debug) console.warn(`[vinext] absorbed unhandledRejection ${code}`);
      return;
    }
    if (proc[RUNNING_SERVER_FLAG]) {
      console.error("[vinext] unhandledRejection:", reason);
      return;
    }
    throw reason;
  });
}
