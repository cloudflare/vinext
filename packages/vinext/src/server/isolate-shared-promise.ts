/**
 * Keep the request that creates an isolate-shared promise alive until it
 * settles.
 *
 * workerd binds the I/O a promise waits on (timers, fetches, dynamic
 * `import()` under the legacy module registry) to the request that started it.
 * If that request is canceled first, for example because the client navigated
 * away or aborted a prefetch, the continuations are dropped and the promise
 * never settles. A promise memoized for the isolate is awaited by every later
 * request too, so they would all wait forever. `waitUntil()` keeps the creating
 * request's context running after cancellation, so the work finishes for
 * everyone.
 *
 * Call this only where the shared promise is created. Later requests that
 * merely await it need nothing.
 */

import {
  getRequestExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";

function ignore(): void {}

/**
 * Register `promise` with the creating request's `waitUntil()` and return it.
 *
 * @param ctx - The creating request's execution context. Defaults to the one
 *   in scope, for callers inside `runWithExecutionContext()`.
 */
export function shareIsolatePromise<T>(
  promise: Promise<T>,
  ctx?: Partial<Pick<ExecutionContextLike, "waitUntil">> | null,
): Promise<T> {
  const context = typeof ctx?.waitUntil === "function" ? ctx : getRequestExecutionContext();
  context?.waitUntil?.(promise.then(ignore, ignore));
  return promise;
}

// Shims that are also bundled for the browser, such as next/dynamic, cannot
// import request state. Every server build loads this module before it renders
// (the App and Pages entries, the cache handler and the ISR cache all import
// it), so publishing the helper on a global symbol lets those shims reach it on
// the server only. Keep the key in sync with shims/dynamic.ts.
const SHARE_ISOLATE_PROMISE_KEY = Symbol.for("vinext.shareIsolatePromise");
(globalThis as { [SHARE_ISOLATE_PROMISE_KEY]?: typeof shareIsolatePromise })[
  SHARE_ISOLATE_PROMISE_KEY
] ??= shareIsolatePromise;
