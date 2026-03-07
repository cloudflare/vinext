/**
 * Shared state for instrumentation.ts testing in app-router-cloudflare.
 *
 * ## Why plain module-level variables work here
 *
 * register() is now emitted as a top-level `await` inside the generated RSC
 * entry module (see `generateRscEntry` in `app-dev-server.ts`). This means it
 * runs inside the Cloudflare Worker process — the same process and module graph
 * as the API routes. Plain module-level variables are therefore visible to both
 * the instrumentation code and the API route that reads them.
 *
 * This is different from the old approach (writing to a temp file on disk) which
 * was needed when register() ran in the host Node.js process and API routes ran
 * in the miniflare Worker subprocess (two separate processes, no shared memory).
 */

export type CapturedRequestError = {
  message: string;
  path: string;
  method: string;
  routerKind: string;
  routePath: string;
  routeType: string;
}

/** Set to true when instrumentation.ts register() is called. */
let registerCalled = false;

/** List of errors captured by onRequestError(). */
const capturedErrors: CapturedRequestError[] = [];

export function isRegisterCalled(): boolean {
  return registerCalled;
}

export function getCapturedErrors(): CapturedRequestError[] {
  return [...capturedErrors];
}

export function markRegisterCalled(): void {
  registerCalled = true;
}

export function recordRequestError(entry: CapturedRequestError): void {
  capturedErrors.push(entry);
}

export function resetInstrumentationState(): void {
  registerCalled = false;
  capturedErrors.length = 0;
}
