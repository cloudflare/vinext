/**
 * Shared state for instrumentation.ts testing in app-router-cloudflare.
 *
 * Cloudflare dev and worker paths can evaluate instrumentation and route modules
 * through different module instances. Store state on globalThis so the startup
 * register() path and the request-handling path observe the same values.
 */

export type CapturedRequestError = {
  message: string;
  path: string;
  method: string;
  routerKind: string;
  routePath: string;
  routeType: string;
}

type InstrumentationState = {
  capturedErrors: CapturedRequestError[];
  registerCalled: boolean;
};

function getInstrumentationState(): InstrumentationState {
  const scopedGlobal = globalThis as typeof globalThis & {
    __VINEXT_CLOUDFLARE_INSTRUMENTATION_STATE__?: InstrumentationState;
  };

  if (!scopedGlobal.__VINEXT_CLOUDFLARE_INSTRUMENTATION_STATE__) {
    scopedGlobal.__VINEXT_CLOUDFLARE_INSTRUMENTATION_STATE__ = {
      capturedErrors: [],
      registerCalled: false,
    };
  }

  return scopedGlobal.__VINEXT_CLOUDFLARE_INSTRUMENTATION_STATE__;
}

export function isRegisterCalled(): boolean {
  return getInstrumentationState().registerCalled;
}

export function getCapturedErrors(): CapturedRequestError[] {
  return [...getInstrumentationState().capturedErrors];
}

export function markRegisterCalled(): void {
  getInstrumentationState().registerCalled = true;
}

export function recordRequestError(entry: CapturedRequestError): void {
  getInstrumentationState().capturedErrors.push(entry);
}

export function resetInstrumentationState(): void {
  const state = getInstrumentationState();
  state.registerCalled = false;
  state.capturedErrors.length = 0;
}
