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
 * Keys for globalThis storage.
 *
 * Both registerCalled and capturedErrors must use globalThis for the same
 * reason as the middleware counter: in sequential test runs within the same
 * Vitest process, the production server is built twice. The second build
 * loads a fresh module instance (cache-busted by mtime), so module-level
 * variables are re-initialised. However, globalThis.__VINEXT_onRequestErrorHandler__
 * may still point to the onRequestError function from the *first* build's
 * module instance, which holds a closure over capturedErrors_v1 (the first
 * instance's array). By storing capturedErrors on globalThis, both the old
 * and new onRequestError functions write to — and the API route reads from —
 * the same array regardless of which module instance is active.
 */
const REGISTER_CALLED_KEY = "__vinext_test_register_called__";
const CAPTURED_ERRORS_KEY = "__vinext_test_captured_errors__";

function _getRegisterCalled(): boolean {
  return (globalThis as any)[REGISTER_CALLED_KEY] ?? false;
}

function _getCapturedErrors(): CapturedRequestError[] {
  if (!(globalThis as any)[CAPTURED_ERRORS_KEY]) {
    (globalThis as any)[CAPTURED_ERRORS_KEY] = [];
  }
  return (globalThis as any)[CAPTURED_ERRORS_KEY] as CapturedRequestError[];
}

/** True when instrumentation.ts register() has been called. */
export function getRegisterCalled(): boolean {
  return _getRegisterCalled();
}

/** List of errors captured by onRequestError(). */
export function getCapturedErrors(): CapturedRequestError[] {
  return _getCapturedErrors();
}

/** Mark register() as having been called. */
export function markRegisterCalled(): void {
  (globalThis as any)[REGISTER_CALLED_KEY] = true;
}

/** Record an error from onRequestError(). */
export function recordRequestError(entry: CapturedRequestError): void {
  _getCapturedErrors().push(entry);
}

/** Reset all state (used between test runs if needed). */
export function resetInstrumentationState(): void {
  (globalThis as any)[REGISTER_CALLED_KEY] = false;
  (globalThis as any)[CAPTURED_ERRORS_KEY] = [];
  (globalThis as any)[MW_COUNT_KEY] = 0;
  (globalThis as any)[MW_PATHS_KEY] = [];
}

/**
 * Middleware invocation counter.
 *
 * Incremented each time the middleware function runs. In a hybrid app/pages
 * fixture the connect handler forwards middleware results to the RSC entry
 * via x-vinext-mw-ctx so middleware only runs once per request.
 *
 * Stored on globalThis because the middleware.ts file is loaded in the SSR
 * environment (via ssrLoadModule in the Vite connect handler) AND imported
 * directly into the RSC entry (RSC environment). Those are separate module
 * graphs with separate instances of this module. globalThis is shared across
 * all environments in the same Node.js process, so both copies write to —
 * and the API route reads from — the same counter.
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
