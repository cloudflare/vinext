import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyNavigationRuntimeRscState,
  getNavigationRuntime,
  registerNavigationRuntimeFunctions,
} from "../packages/vinext/src/client/navigation-runtime.js";
import { VINEXT_RSC_STATE_HEADER } from "../packages/vinext/src/server/headers.js";

describe("applyNavigationRuntimeRscState", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    registerNavigationRuntimeFunctions({ getRscStateFingerprint: undefined });
    vi.unstubAllGlobals();
  });

  it("applies the registered visible-router-state fingerprint", () => {
    registerNavigationRuntimeFunctions({ getRscStateFingerprint: () => "visible-state" });
    const headers = new Headers();

    applyNavigationRuntimeRscState(headers);

    expect(headers.get(VINEXT_RSC_STATE_HEADER)).toBe("visible-state");
  });

  it("leaves headers unchanged before the App Router runtime is registered", () => {
    expect(getNavigationRuntime()?.functions.getRscStateFingerprint).toBeUndefined();
    const headers = new Headers();

    applyNavigationRuntimeRscState(headers);

    expect(headers.has(VINEXT_RSC_STATE_HEADER)).toBe(false);
  });
});
