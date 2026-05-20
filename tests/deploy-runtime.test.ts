import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEPLOY_CACHE_CONTROL,
  isDeployRuntime,
} from "../packages/vinext/src/server/deploy-runtime.js";

// Node 24's `globalThis.navigator` is defined as a getter-only property, so
// the override has to use Object.defineProperty rather than direct assignment.
// We always restore the original descriptor after each test to avoid leaking
// the stub into adjacent suites running in the same worker.
function setNavigator(value: { userAgent?: string } | undefined): void {
  if (value === undefined) {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: undefined,
    });
    delete (globalThis as { navigator?: unknown }).navigator;
    return;
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

describe("deploy-runtime", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalDescriptor);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("exposes the Next.js deploy Cache-Control header constant", () => {
    expect(DEPLOY_CACHE_CONTROL).toBe("public, max-age=0, must-revalidate");
  });

  it("returns false under the Node test runtime (no navigator.userAgent match)", () => {
    setNavigator(undefined);
    expect(isDeployRuntime()).toBe(false);
  });

  it("returns true when navigator.userAgent === 'Cloudflare-Workers'", () => {
    setNavigator({ userAgent: "Cloudflare-Workers" });
    expect(isDeployRuntime()).toBe(true);
  });

  it("returns false when navigator.userAgent does not match", () => {
    setNavigator({ userAgent: "Mozilla/5.0" });
    expect(isDeployRuntime()).toBe(false);
  });
});
