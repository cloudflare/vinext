/**
 * Process-level backstop for peer-disconnect errors that escape
 * per-connection / per-request error guards.
 *
 * Three real call sites in vinext that hit this:
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
 * Filters strictly on peer-disconnect codes (ECONNRESET / EPIPE /
 * ECONNABORTED) plus benign static-asset `import()` rejections (see
 * `isBenignAssetImportError`), and synchronously re-throws everything
 * else, preserving Node's default crash semantics for genuine bugs.
 * This is more conservative than Next.js's equivalent
 * (`router-server.ts`'s log-only handler), which silently swallows
 * every uncaught — vinext keeps real bugs surfacing.
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
 * `startProdServer()` from inside `vinext build` to render pages
 * against a real HTTP server. User `fetch()` calls during prerender
 * hit external APIs that can drop connections; absorbing those would
 * silently produce corrupt prerendered output instead of crashing
 * the build. Prerender already sets `VINEXT_PRERENDER=1` for its
 * own purposes — the listener checks it at fire time and re-throws
 * unconditionally when set, acting as if no listener were installed.
 * Doing the check at install time wouldn't work: `index.ts` loads at
 * Vite plugin import, well before prerender starts, so by the time
 * `VINEXT_PRERENDER` is set the listener has already been installed
 * (we cannot uninstall and re-install per phase).
 *
 * Side-effect of the unconditional re-throw during prerender: an
 * orchestrator-induced ECONNRESET (e.g. the prerender's own HTTP
 * client aborting a stuck route fetch) will surface the build crash
 * as `Error: read ECONNRESET` rather than the underlying route
 * failure. Acceptable trade-off — a hung prerender route is itself
 * a build problem worth surfacing — but the resulting stack will
 * point at the disconnect, not the cause. Set
 * `VINEXT_DEBUG_SOCKET_ERRORS=1` to log peer-disconnect codes if
 * you need to disambiguate.
 *
 * **Test skip is install-time.** Vitest workers that import
 * `index.ts` directly should never have the listener installed —
 * peer-disconnect errors during test runs should surface normally.
 * `process.env.VITEST === "true"` is set by Vitest in every worker;
 * `NODE_ENV === "test"` covers other test runners that follow the
 * standard convention.
 *
 * **Listener ordering.** `index.ts` is imported synchronously at the
 * top of every user's `vite.config.ts`, so vinext's listener registers
 * before most user / tooling listeners (Sentry, OpenTelemetry,
 * structured logging). For peer-disconnect codes the early-return is
 * fine. For non-peer-disconnect errors the synchronous re-throw still
 * crashes the process with the original stack, but listeners
 * registered after vinext don't observe the event. Users who need
 * crash-reporter visibility for non-peer-disconnect errors must
 * register their handler before importing vinext.
 *
 * **Symbol.for caveat.** `Symbol.for("vinext.socketErrorBackstop")`
 * is process-global, so if two different vinext versions are loaded
 * in the same process the first to evaluate wins and the second's
 * filter rules silently don't apply.
 *
 * Set `VINEXT_DEBUG_SOCKET_ERRORS=1` to log a one-line marker each
 * time the listener absorbs an error.
 */
const SOCKET_BACKSTOP_FLAG = Symbol.for("vinext.socketErrorBackstop");

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
// are excluded so a genuine missing-module bug still surfaces as a hard crash.
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
 * modules with no extension) returns `false` so real bugs still crash.
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
 * Test-only: returns whether the backstop has been installed in this
 * process. Used by the unit test to assert idempotent install via the
 * Symbol.for guard. Not part of the public API.
 */
export function isSocketErrorBackstopInstalled(): boolean {
  return Boolean(
    (process as typeof process & { [SOCKET_BACKSTOP_FLAG]?: true })[SOCKET_BACKSTOP_FLAG],
  );
}

export function installSocketErrorBackstop(): void {
  const proc = process as typeof process & { [SOCKET_BACKSTOP_FLAG]?: true };
  if (proc[SOCKET_BACKSTOP_FLAG]) return;
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") return;
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
    if (process.env.VINEXT_PRERENDER === "1") throw err;
    const code = peerDisconnectCode(err);
    if (code) {
      if (debug) console.warn(`[vinext] absorbed uncaughtException ${code}`);
      return;
    }
    throw err;
  });
  process.on("unhandledRejection", (reason: unknown) => {
    if (absorbBenignAssetImport(reason, "unhandledRejection")) return;
    if (process.env.VINEXT_PRERENDER === "1") throw reason;
    const code = peerDisconnectCode(reason);
    if (code) {
      if (debug) console.warn(`[vinext] absorbed unhandledRejection ${code}`);
      return;
    }
    throw reason;
  });
}
