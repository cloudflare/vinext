import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

describe("app-hook-warning-suppression", () => {
  // The module patches console.error at import time. In a vitest environment,
  // dynamic imports are cached across tests within the same suite. To ensure
  // each test gets a fresh module evaluation (so the side-effect runs and
  // captures the test's spy as _origConsoleError), we reset the module cache
  // before each test.
  beforeEach(() => {
    vi.resetModules();
  });

  it("suppresses 'Invalid hook call' messages when the ALS store is true", async () => {
    const spy = vi.fn();
    const prev = console.error;
    console.error = spy;
    try {
      const { suppressHookWarningAls } =
        await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      // The module's patched console.error is active because import() ran the
      // side-effect. suppressHookWarningAls.run(true, ...) sets the ALS store;
      // the patched console.error checks the store and suppresses the message.
      suppressHookWarningAls.run(true, () => {
        console.error("Invalid hook call: check render method of ServerComponent");
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      console.error = prev;
    }
  });

  it("does NOT suppress non-hook messages even when the ALS store is true", async () => {
    const spy = vi.fn();
    const prev = console.error;
    console.error = spy;
    try {
      const { suppressHookWarningAls } =
        await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      suppressHookWarningAls.run(true, () => {
        console.error("A real error that should not be suppressed");
      });
      // The patched console.error should forward non-hook messages to the
      // original (spy), not suppress them.
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0]?.[0]).toBe("A real error that should not be suppressed");
    } finally {
      console.error = prev;
    }
  });

  it("passes 'Invalid hook call' messages through when the ALS store is NOT set", async () => {
    const spy = vi.fn();
    const prev = console.error;
    console.error = spy;
    try {
      const { suppressHookWarningAls } =
        await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      // Outside of .run(), the ALS store is undefined. The patched
      // console.error should forward the message to the original (spy).
      expect(suppressHookWarningAls.getStore()).toBeUndefined();

      console.error("Invalid hook call: check render method of Page");
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      console.error = prev;
    }
  });

  it("forwards all arguments to the original console.error when not suppressing", async () => {
    const spy = vi.fn();
    const prev = console.error;
    console.error = spy;
    try {
      await import("../packages/vinext/src/server/app-hook-warning-suppression.js");

      // The patched console.error is active. Non-hook messages with multiple
      // arguments should be forwarded exactly as received.
      console.error("message", { detail: "payload" }, 42);
      expect(spy).toHaveBeenCalledWith("message", { detail: "payload" }, 42);
    } finally {
      console.error = prev;
    }
  });
});
