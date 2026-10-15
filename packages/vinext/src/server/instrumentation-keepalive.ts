import { getRequestExecutionContext } from "vinext/shims/request-context";

/**
 * The shape of the host context `waitUntil()` is read from. `waitUntil` stays
 * optional because some host contexts only expose it on real Workers requests.
 */
type InitializationKeepAliveContext = {
  waitUntil?(promise: Promise<unknown>): void;
};

/**
 * Keep a shared initialization promise alive until it settles.
 *
 * workerd cancels the IoContext of a request whose client disconnects. Work
 * that request was awaiting — a dynamic `import()`, I/O inside
 * `instrumentation.ts`'s `register()` — is dropped with it, so a memoized
 * initialization promise created by that request (`init ??= start()`) would
 * never settle. Every later request in the isolate would then await it
 * forever, burning no CPU until the client gives up (cloudflare/vinext#4012).
 *
 * Passing the promise to the creating request's `waitUntil()` before the first
 * `await` extends that IoContext until the promise settles, so the shared
 * promise becomes usable for every later request. Calling this on every
 * request is cheap and idempotent: only the call made by the request that
 * created the promise can extend anything.
 *
 * The extra `catch` exists only so a failed initialization is not reported as
 * an unhandled rejection by `waitUntil`; the request that awaits the promise
 * still observes the rejection.
 */
export function keepInitializationAlive(
  initialization: unknown,
  ctx?: InitializationKeepAliveContext | null,
): void {
  if (
    initialization === null ||
    initialization === undefined ||
    typeof (initialization as { then?: unknown }).then !== "function"
  ) {
    return;
  }
  const executionContext = ctx ?? getRequestExecutionContext();
  if (!executionContext || typeof executionContext.waitUntil !== "function") return;
  executionContext.waitUntil(Promise.resolve(initialization).catch(() => {}));
}
