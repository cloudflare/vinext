/**
 * Lazy, idempotent instrumentation initialisation.
 *
 * The generated App Router RSC entry calls this on the first request instead
 * of embedding the bookkeeping directly in codegen. This keeps the entry
 * module thin (it only describes the app shape) while the actual runtime
 * behaviour lives in a normal typed module that can be unit-tested.
 *
 * ## Why lazy?
 *
 * A top-level `await` at module evaluation time blocks the entire V8 isolate
 * startup phase. On Cloudflare Workers that latency is added to every cold
 * start. Moving the `register()` call into the first request handler keeps
 * module evaluation synchronous while still guaranteeing that instrumentation
 * runs before any request is handled.
 *
 * ## Why idempotent?
 *
 * The same handler may be invoked concurrently (e.g. on a warm Worker).
 * A module-level `initialized` flag + a shared promise ensure that
 * `register()` is called exactly once even when multiple requests race.
 *
 * ## Next.js semantics
 *
 * Next.js calls `register()` once when the server process starts, before any
 * request handling. Our lazy init preserves that guarantee because the first
 * request cannot proceed past this call until `register()` has resolved.
 *
 * References:
 * - https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import type { OnRequestErrorHandler } from "./instrumentation.js";

let initialized = false;
let initPromise: Promise<void> | null = null;

function isOnRequestErrorHandler(value: unknown): value is OnRequestErrorHandler {
  return typeof value === "function";
}

/**
 * Ensure the instrumentation module's `register()` and `onRequestError`
 * hooks have been applied exactly once.
 *
 * @param instrumentationModule - The imported `instrumentation.ts` module.
 *   Passed as an argument so the generated entry can import it normally
 *   without this helper needing to know the module path.
 */
export async function ensureInstrumentationRegistered(
  instrumentationModule: Record<string, unknown>,
): Promise<void> {
  if (process.env.VINEXT_PRERENDER === "1") return;
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (typeof instrumentationModule.register === "function") {
      await instrumentationModule.register();
    }

    // Store the onRequestError handler on globalThis so it is visible to
    // reportRequestError() regardless of which Vite environment module graph
    // it is called from. With @vitejs/plugin-rsc the RSC and SSR environments
    // run in the same Node.js process and share globalThis. With
    // @cloudflare/vite-plugin everything runs inside the Worker so globalThis
    // is the Worker's global — also correct.
    if (isOnRequestErrorHandler(instrumentationModule.onRequestError)) {
      globalThis.__VINEXT_onRequestErrorHandler__ = instrumentationModule.onRequestError;
    }

    initialized = true;
  })();

  return initPromise;
}
