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
 * ECONNABORTED) and synchronously re-throws everything else,
 * preserving Node's default crash semantics for genuine bugs. This
 * is more conservative than Next.js's equivalent
 * (`router-server.ts`'s log-only handler), which silently swallows
 * every uncaught — vinext keeps real bugs surfacing.
 *
 * **Installed at module load.** Earlier iterations tried to gate
 * install via Vite's `config()` hook (`command === "serve"`) so it
 * was strictly dev-only, but the hook didn't fire reliably in
 * vite-plus's lifecycle — install was silently skipped. The
 * connection-level guard from #911 confirms `configureServer`-tied
 * lifecycle hooks are timing-fragile too. Module-load install is
 * the only place that's been reliably observed to fire (verified
 * via the `VINEXT_DEBUG_SOCKET_ERRORS` marker).
 *
 * The earlier reason for hoisting still applies: prior versions tied
 * teardown to `httpServer` `'close'`, which Vite emits on dep
 * re-optimization and full reloads, leaving a window where the
 * listener was absent when a stale stream errored. No teardown here.
 *
 * **Vitest skip.** Vitest workers import this module via test files
 * that depend on `index.ts`. Skip install in those contexts so
 * genuine peer-disconnect errors during test runs surface normally.
 * `process.env.VITEST === "true"` is set by Vitest in every worker.
 *
 * Build runs (`vinext build`) also import index.ts but the listener
 * is harmless there — the build process is short-lived and doesn't
 * stream peer-disconnect-prone responses. Matches Next.js's pattern
 * of installing in any HTTP-serving entry without further gating.
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

export function installSocketErrorBackstop(): void {
  const proc = process as typeof process & { [SOCKET_BACKSTOP_FLAG]?: true };
  if (proc[SOCKET_BACKSTOP_FLAG]) return;
  if (process.env.VITEST === "true") return;
  proc[SOCKET_BACKSTOP_FLAG] = true;

  const debug = process.env.VINEXT_DEBUG_SOCKET_ERRORS === "1";
  const peerDisconnectCode = (err: unknown): string | undefined => {
    const code = (err as { code?: string } | null)?.code;
    return code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" ? code : undefined;
  };
  if (debug) console.warn("[vinext] socket-error backstop installed");
  process.on("uncaughtException", (err: Error) => {
    const code = peerDisconnectCode(err);
    if (code) {
      if (debug) console.warn(`[vinext] absorbed uncaughtException ${code}`);
      return;
    }
    throw err;
  });
  process.on("unhandledRejection", (reason: unknown) => {
    const code = peerDisconnectCode(reason);
    if (code) {
      if (debug) console.warn(`[vinext] absorbed unhandledRejection ${code}`);
      return;
    }
    throw reason;
  });
}

// Auto-install at module load. The Vite plugin lifecycle hooks proved
// timing-fragile in vite-plus, so we install eagerly. The Vitest skip
// inside installSocketErrorBackstop() is the only context-specific
// guard. Idempotent — prod-server.ts's explicit call is a no-op when
// loaded in the same process.
installSocketErrorBackstop();
