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
 * **Where to call from.** This module exports a function so callers
 * can gate it correctly. Vinext invokes it from:
 *   - The `vinext:config` plugin's `config()` hook when
 *     `command === "serve" && !isPreview` — covers `vinext dev`,
 *     `vp dev`, `vite dev`, and library embedders that call
 *     `createServer` themselves.
 *   - `startProdServer()` in `prod-server.ts` — covers `vinext start`
 *     for self-hosted Node deployments. Cloudflare Workers prod
 *     doesn't load this module; the runtime owns socket lifecycle.
 *
 * Vitest workers and `vinext build` never reach either entry point,
 * so genuine peer-disconnect errors in those contexts surface
 * normally.
 *
 * **Listener ordering.** Vinext's listener registers when the
 * relevant entry point initializes, after most user setup, so
 * earlier observers (Sentry, structured logging) still see
 * non-peer-disconnect errors before the sync re-throw aborts further
 * iteration.
 *
 * **Symbol.for caveat.** `Symbol.for("vinext.socketErrorBackstop")`
 * is process-global, so if two different vinext versions are loaded
 * in the same process the first to evaluate wins and the second's
 * filter rules silently don't apply. Idempotent across multiple
 * invocations within a single process (e.g. server restarts within
 * a dev session, or a process that runs both dev and prod entries).
 *
 * Set `VINEXT_DEBUG_SOCKET_ERRORS=1` to log a one-line marker each
 * time the listener absorbs an error.
 */
const SOCKET_BACKSTOP_FLAG = Symbol.for("vinext.socketErrorBackstop");

export function installSocketErrorBackstop(): void {
  const proc = process as typeof process & { [SOCKET_BACKSTOP_FLAG]?: true };
  if (proc[SOCKET_BACKSTOP_FLAG]) return;
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
