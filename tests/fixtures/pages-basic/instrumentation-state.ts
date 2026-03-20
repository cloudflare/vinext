/**
 * Shared in-memory state for instrumentation.ts testing in pages-basic.
 *
 * ## Why globalThis?
 *
 * vinext loads instrumentation.ts via a direct-call ModuleRunner built on the
 * SSR DevEnvironment's fetchModule() method. That runner creates its own isolated
 * module graph — separate from the Vite SSR module graph that handles API routes.
 *
 * If state were stored as plain module-level variables, the runner instance would
 * set registerCalled = true in its copy, but the API route would read from its own
 * copy (always false). Storing everything on globalThis bridges the gap: both
 * module graph instances run in the same Node.js process and share the same global
 * object, so writes from one are immediately visible to reads from the other.
 *
 * This is the same pattern used by instrumentation.ts itself to store the
 * onRequestError handler across Vite environment boundaries.
 */

export interface CapturedRequestError {
  message: string;
  path: string;
  method: string;
  routerKind: string;
  routePath: string;
  routeType: string;
}

const REGISTER_KEY = "__vinext_pages_test_registerCalled__";
const ERRORS_KEY = "__vinext_pages_test_capturedErrors__";

function _errors(): CapturedRequestError[] {
  if (!(globalThis as any)[ERRORS_KEY]) {
    (globalThis as any)[ERRORS_KEY] = [];
  }
  return (globalThis as any)[ERRORS_KEY] as CapturedRequestError[];
}

/** True once instrumentation.ts register() has been called. */
export function isRegisterCalled(): boolean {
  return (globalThis as any)[REGISTER_KEY] === true;
}

/** All errors captured by onRequestError() so far. */
export function getCapturedErrors(): CapturedRequestError[] {
  return _errors();
}

/** Called by instrumentation.ts register(). */
export function markRegisterCalled(): void {
  (globalThis as any)[REGISTER_KEY] = true;
}

/** Called by instrumentation.ts onRequestError(). */
export function recordRequestError(entry: CapturedRequestError): void {
  _errors().push(entry);
}

/** Reset all state (used between test runs). */
export function resetInstrumentationState(): void {
  (globalThis as any)[REGISTER_KEY] = false;
  (globalThis as any)[ERRORS_KEY] = [];
}
