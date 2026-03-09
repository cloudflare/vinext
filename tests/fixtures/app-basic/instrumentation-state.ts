/**
 * Shared in-memory state for instrumentation.ts and middleware testing.
 *
 * Both instrumentation.ts/middleware.ts and the API routes import from this
 * module so they share the same state within a single Node.js process.
 */

export type CapturedRequestError = {
  message: string;
  path: string;
  method: string;
  routerKind: string;
  routePath: string;
  routeType: string;
};

/**
 * Set to true when instrumentation.ts register() is called.
 *
 * Unlike the middleware counter below, this does NOT need globalThis.
 * instrumentation.ts is loaded in the RSC environment (via the vinext
 * instrumentation runner), and the /api/instrumentation-test route is also
 * an App Router route — also loaded in the RSC environment. Because both
 * files live in the same Vite module graph, ESM live bindings work normally:
 * when markRegisterCalled() updates this variable, the API route's import
 * sees the updated value immediately.
 *
 * The middleware counter must use globalThis because middleware.ts is loaded
 * in *two separate environments* (SSR env via ssrLoadModule, RSC env via the
 * RSC entry), so there is no shared module instance to rely on.
 */
export let registerCalled = false;

/** List of errors captured by onRequestError(). */
export const capturedErrors: CapturedRequestError[] = [];

/** Mark register() as having been called. */
export function markRegisterCalled(): void {
  registerCalled = true;
}

/** Record an error from onRequestError(). */
export function recordRequestError(entry: CapturedRequestError): void {
  capturedErrors.push(entry);
}

/** Reset all state (used between test runs if needed). */
export function resetInstrumentationState(): void {
  registerCalled = false;
  capturedErrors.length = 0;
  (globalThis as any)[MW_COUNT_KEY] = 0;
  (globalThis as any)[MW_PATHS_KEY] = [];
}

/**
 * Middleware invocation counter.
 *
 * Incremented each time the middleware function runs. In a hybrid app/pages
 * fixture, if middleware is double-executed (once via ssrLoadModule in the
 * Vite connect handler and again inline in the RSC entry), this counter will
 * be 2 for a single request instead of 1.
 *
 * Stored on globalThis for the same reason as instrumentation state: the
 * middleware.ts file is loaded in the SSR environment (via ssrLoadModule in
 * the Vite connect handler) AND imported directly into the RSC entry (RSC
 * environment). Those are separate module graphs with separate instances of
 * this module. globalThis is shared across all environments in the same
 * Node.js process, so both copies write to — and the API route reads from —
 * the same counter.
 */
const MW_COUNT_KEY = "__vinext_mw_count__";
const MW_PATHS_KEY = "__vinext_mw_paths__";

function _mwCount(): number {
  return (globalThis as any)[MW_COUNT_KEY] ?? 0;
}
function _mwPaths(): string[] {
  if (!(globalThis as any)[MW_PATHS_KEY]) {
    (globalThis as any)[MW_PATHS_KEY] = [];
  }
  return (globalThis as any)[MW_PATHS_KEY] as string[];
}

/** Get the total number of middleware invocations recorded across all environments. */
export function getMiddlewareInvocationCount(): number {
  return _mwCount();
}

/** Get the ordered list of pathnames seen by each middleware invocation. */
export function getMiddlewareInvokedPaths(): string[] {
  return [..._mwPaths()];
}

/** Record a middleware invocation. */
export function recordMiddlewareInvocation(pathname: string): void {
  (globalThis as any)[MW_COUNT_KEY] = _mwCount() + 1;
  _mwPaths().push(pathname);
}
