import { describe, it, expect, vi, afterEach } from "vitest";

describe("use-cache deadlock probe", () => {
  afterEach(() => {
    // oxlint-disable-next-line typescript/no-explicit-any
    delete (globalThis as any)[Symbol.for("vinext.dev.useCacheProbe")];
  });

  // -------------------------------------------------------------------------
  // Error classes
  // -------------------------------------------------------------------------

  describe("UseCacheTimeoutError", () => {
    it("has digest USE_CACHE_TIMEOUT", async () => {
      const { UseCacheTimeoutError, isUseCacheTimeoutError } =
        await import("../packages/vinext/src/shims/use-cache-errors.js");
      const err = new UseCacheTimeoutError();
      expect(err.digest).toBe("USE_CACHE_TIMEOUT");
      expect(isUseCacheTimeoutError(err)).toBe(true);
      expect(err.message).toContain("Filling a cache during prerender timed out");
    });

    it("isUseCacheTimeoutError returns false for plain errors", async () => {
      const { isUseCacheTimeoutError } =
        await import("../packages/vinext/src/shims/use-cache-errors.js");
      expect(isUseCacheTimeoutError(new Error("plain"))).toBe(false);
      expect(isUseCacheTimeoutError(null)).toBe(false);
      expect(isUseCacheTimeoutError(undefined)).toBe(false);
      expect(isUseCacheTimeoutError("string")).toBe(false);
    });
  });

  describe("UseCacheDeadlockError", () => {
    it("has digest USE_CACHE_DEADLOCK", async () => {
      const { UseCacheDeadlockError, isUseCacheDeadlockError } =
        await import("../packages/vinext/src/shims/use-cache-errors.js");
      const err = new UseCacheDeadlockError();
      expect(err.digest).toBe("USE_CACHE_DEADLOCK");
      expect(isUseCacheDeadlockError(err)).toBe(true);
      expect(err.message).toContain("stuck on shared state from the outer render scope");
    });

    it("isUseCacheDeadlockError returns false for plain errors", async () => {
      const { isUseCacheDeadlockError } =
        await import("../packages/vinext/src/shims/use-cache-errors.js");
      expect(isUseCacheDeadlockError(new Error("plain"))).toBe(false);
      expect(isUseCacheDeadlockError(null)).toBe(false);
      expect(isUseCacheDeadlockError(undefined)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Probe globals
  // -------------------------------------------------------------------------

  describe("use-cache-probe-globals", () => {
    it("setUseCacheProbe / getUseCacheProbe round-trip", async () => {
      const { setUseCacheProbe, getUseCacheProbe } =
        await import("../packages/vinext/src/server/use-cache-probe-globals.js");
      const probe = vi.fn().mockResolvedValue(true);
      setUseCacheProbe(probe);
      expect(getUseCacheProbe()).toBe(probe);
      setUseCacheProbe(undefined);
      expect(getUseCacheProbe()).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Dev timeout (no probe installed)
  // -------------------------------------------------------------------------

  describe("dev timeout without probe", () => {
    it("throws UseCacheTimeoutError when function hangs longer than timeout", async () => {
      const { registerCachedFunction } =
        await import("../packages/vinext/src/shims/cache-runtime.js");
      const { UseCacheTimeoutError } =
        await import("../packages/vinext/src/shims/use-cache-errors.js");

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const oldTimeout = process.env.__VINEXT_USE_CACHE_TIMEOUT;
      process.env.__VINEXT_USE_CACHE_TIMEOUT = "0.05"; // 50 ms

      const fn = async () => {
        await new Promise(() => {}); // never resolves
        return "unreachable";
      };
      const cached = registerCachedFunction(fn, "test:hang");

      await expect(cached()).rejects.toBeInstanceOf(UseCacheTimeoutError);

      process.env.NODE_ENV = oldEnv;
      if (oldTimeout === undefined) delete process.env.__VINEXT_USE_CACHE_TIMEOUT;
      else process.env.__VINEXT_USE_CACHE_TIMEOUT = oldTimeout;
    }, 5_000);

    it("resolves normally when function completes before timeout", async () => {
      const { registerCachedFunction } =
        await import("../packages/vinext/src/shims/cache-runtime.js");

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const oldTimeout = process.env.__VINEXT_USE_CACHE_TIMEOUT;
      process.env.__VINEXT_USE_CACHE_TIMEOUT = "5";

      const fn = async (x: number) => x * 2;
      const cached = registerCachedFunction(fn, "test:fast");

      await expect(cached(7)).resolves.toBe(14);

      process.env.NODE_ENV = oldEnv;
      if (oldTimeout === undefined) delete process.env.__VINEXT_USE_CACHE_TIMEOUT;
      else process.env.__VINEXT_USE_CACHE_TIMEOUT = oldTimeout;
    });
  });

  // -------------------------------------------------------------------------
  // Dev timeout with probe installed
  // -------------------------------------------------------------------------

  describe("dev deadlock probe", () => {
    it("throws UseCacheDeadlockError when probe completes while main hangs", async () => {
      const { registerCachedFunction } =
        await import("../packages/vinext/src/shims/cache-runtime.js");
      const { UseCacheDeadlockError } =
        await import("../packages/vinext/src/shims/use-cache-errors.js");
      const { setUseCacheProbe } =
        await import("../packages/vinext/src/server/use-cache-probe-globals.js");

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const oldTimeout = process.env.__VINEXT_USE_CACHE_TIMEOUT;
      const oldProbe = process.env.__VINEXT_PROBE_THRESHOLD_MS;
      process.env.__VINEXT_USE_CACHE_TIMEOUT = "10"; // 10 s fill timeout
      process.env.__VINEXT_PROBE_THRESHOLD_MS = "50"; // 50 ms probe threshold

      // Install a mock probe that "completes" immediately (positive signal)
      setUseCacheProbe(async () => true);

      const fn = async () => {
        await new Promise(() => {}); // never resolves
        return "unreachable";
      };
      const cached = registerCachedFunction(fn, "test:deadlock");

      await expect(cached()).rejects.toBeInstanceOf(UseCacheDeadlockError);

      process.env.NODE_ENV = oldEnv;
      if (oldTimeout === undefined) delete process.env.__VINEXT_USE_CACHE_TIMEOUT;
      else process.env.__VINEXT_USE_CACHE_TIMEOUT = oldTimeout;
      if (oldProbe === undefined) delete process.env.__VINEXT_PROBE_THRESHOLD_MS;
      else process.env.__VINEXT_PROBE_THRESHOLD_MS = oldProbe;
      setUseCacheProbe(undefined);
    }, 5_000);

    it("falls back to UseCacheTimeoutError when probe returns false", async () => {
      const { registerCachedFunction } =
        await import("../packages/vinext/src/shims/cache-runtime.js");
      const { UseCacheTimeoutError } =
        await import("../packages/vinext/src/shims/use-cache-errors.js");
      const { setUseCacheProbe } =
        await import("../packages/vinext/src/server/use-cache-probe-globals.js");

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const oldTimeout = process.env.__VINEXT_USE_CACHE_TIMEOUT;
      process.env.__VINEXT_USE_CACHE_TIMEOUT = "0.05"; // 50 ms

      // Probe returns false (inconclusive)
      setUseCacheProbe(async () => false);

      const fn = async () => {
        await new Promise(() => {});
        return "unreachable";
      };
      const cached = registerCachedFunction(fn, "test:probe-false");

      await expect(cached()).rejects.toBeInstanceOf(UseCacheTimeoutError);

      process.env.NODE_ENV = oldEnv;
      if (oldTimeout === undefined) delete process.env.__VINEXT_USE_CACHE_TIMEOUT;
      else process.env.__VINEXT_USE_CACHE_TIMEOUT = oldTimeout;
      setUseCacheProbe(undefined);
    }, 5_000);

    it("does not throw deadlock if main resolves during probe", async () => {
      const { registerCachedFunction } =
        await import("../packages/vinext/src/shims/cache-runtime.js");
      const { setUseCacheProbe } =
        await import("../packages/vinext/src/server/use-cache-probe-globals.js");

      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const oldTimeout = process.env.__VINEXT_USE_CACHE_TIMEOUT;
      process.env.__VINEXT_USE_CACHE_TIMEOUT = "2";

      // Slow probe that returns true after 150 ms, but main resolves in 80 ms
      setUseCacheProbe(async () => {
        await new Promise((r) => setTimeout(r, 150));
        return true;
      });

      let resolveMain: (() => void) | undefined;
      const fn = async () => {
        await new Promise<void>((r) => {
          resolveMain = r;
        });
        return "resolved";
      };
      const cached = registerCachedFunction(fn, "test:mid-probe-recovery");

      const promise = cached();
      // Let the probe schedule start (50 ms threshold) but resolve main before
      // the probe completes.
      setTimeout(() => resolveMain?.(), 80);

      await expect(promise).resolves.toBe("resolved");

      process.env.NODE_ENV = oldEnv;
      if (oldTimeout === undefined) delete process.env.__VINEXT_USE_CACHE_TIMEOUT;
      else process.env.__VINEXT_USE_CACHE_TIMEOUT = oldTimeout;
      setUseCacheProbe(undefined);
    }, 5_000);
  });
});
