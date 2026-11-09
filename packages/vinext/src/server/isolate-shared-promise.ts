/**
 * Make a promise memoized for the isolate safe for every request to await.
 *
 * Two workerd behaviors make a promise shared across requests unsafe as is:
 *
 * - workerd binds the I/O a promise waits on (timers, fetches, dynamic
 *   `import()` under the legacy module registry) to the request that started
 *   it. If that request is canceled first, for example because the client
 *   navigated away or aborted a prefetch, the continuations are dropped and the
 *   promise never settles. Every later request that awaits it would wait
 *   forever. `waitUntil()` keeps the creating request's context running after
 *   cancellation, so the work finishes for everyone.
 * - workerd tags each promise with the request that creates it, and resumes
 *   each request awaiting a tagged promise in that request's own context. V8's
 *   optimizing compilers (Maglev and TurboFan) allocate promises without the
 *   tag (https://github.com/cloudflare/workerd/issues/8228), so a promise
 *   created by optimized code resumes every waiter in the request that settles
 *   it. workerd then rejects the waiters' I/O, tracing spans and `console`
 *   calls there with "Cannot perform I/O on behalf of a different request".
 *   `Promise.withResolvers()` is a builtin those compilers call rather than
 *   inline, so its promise is always tagged.
 *
 * Call these only where the shared promise is created. Later requests that
 * merely await the returned promise need nothing.
 */

import {
  getRequestExecutionContext,
  type ExecutionContextLike,
} from "vinext/shims/request-context";

function ignore(): void {}

// The ES2022 lib vinext compiles against has no types for Promise.withResolvers
// (ES2024). Node 20, still the default runtime of some deploy targets such as
// Nitro's aws_amplify preset, lacks it; only workerd tags promises anyway.
type PromiseWithResolversConstructor = PromiseConstructor & {
  withResolvers?<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

/**
 * Return a promise that follows `promise` and carries the creating request's
 * tag, so each request awaiting it resumes in its own context.
 */
export function tagPromiseWithRequest<T>(promise: Promise<T>): Promise<T> {
  const PromiseConstructor = Promise as PromiseWithResolversConstructor;
  if (typeof PromiseConstructor.withResolvers !== "function") return promise;
  const tagged = PromiseConstructor.withResolvers<T>();
  void promise.then(tagged.resolve, tagged.reject);
  return tagged.promise;
}

/**
 * Register `promise` with the creating request's `waitUntil()` and return a
 * promise that follows it, tagged with the creating request (see
 * `tagPromiseWithRequest`). Memoize the returned promise, not `promise`.
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
  return tagPromiseWithRequest(promise);
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
