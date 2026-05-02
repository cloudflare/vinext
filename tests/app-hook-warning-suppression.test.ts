import { describe, expect, it, vi } from "vite-plus/test";

describe("app-hook-warning-suppression", () => {
  // The module patches console.error at import time. We verify the
  // patch behaviour by replacing console.error before import so the
  // module captures our spy as the "original" that it forwards to.

  it("suppresses 'Invalid hook call' messages when the ALS store is true", async () => {
    const origError = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      const mod = await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      mod.suppressHookWarningAls.run(true, () => {
        console.error("Invalid hook call: check render method of ServerComponent");
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  it("does NOT suppress non-hook messages even when the ALS store is true", async () => {
    const origError = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      const mod = await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      mod.suppressHookWarningAls.run(true, () => {
        console.error("A real error that should not be suppressed");
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0]?.[0]).toBe("A real error that should not be suppressed");
    } finally {
      console.error = origError;
    }
  });

  it("passes 'Invalid hook call' messages through when the ALS store is NOT set", async () => {
    const origError = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      const mod = await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      // Outside of .run(), the ALS store is undefined.
      expect(mod.suppressHookWarningAls.getStore()).toBeUndefined();

      console.error("Invalid hook call: check render method of Page");
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      console.error = origError;
    }
  });

  it("forwards all arguments to the original console.error when not suppressing", async () => {
    const origError = console.error;
    const spy = vi.fn();
    console.error = spy;
    try {
      await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      console.error("message", { detail: "payload" }, 42);
      expect(spy).toHaveBeenCalledWith("message", { detail: "payload" }, 42);
    } finally {
      console.error = origError;
    }
  });
});
