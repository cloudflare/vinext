// Ported from Next.js's offline module and its prefetch scheduler hook:
// packages/next/src/client/components/offline.ts,
// packages/next/src/client/components/segment-cache/scheduler.ts.
// Navigations, Server Actions and the useOffline() indicator are covered in the
// browser by tests/e2e/app-router-use-offline/use-offline.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Both modules keep state at module scope, so each test loads them fresh.
const loadOffline = () => import("../packages/vinext/src/shims/internal/offline.js");
const loadQueue = () => import("../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js");

const networkError = () => new TypeError("Failed to fetch");

/** Connectivity checks (HEAD) answer with `checks` in order, then succeed. */
function stubConnectivityChecks(checks: Array<"fail" | "hang">) {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const next = checks.shift();
      if (next === "fail") return Promise.reject(networkError());
      if (next === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve(new Response(null));
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("location", { href: "https://example.com/current" });
});

afterEach(async () => {
  (await loadOffline())._resetOfflineStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("offline retry", () => {
  it("keeps checking for the connection until it returns, then retries", async () => {
    const offline = await loadOffline();
    stubConnectivityChecks(["fail", "fail", "fail"]);
    const response = new Response("payload");
    const request = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(response);

    const result = offline.fetchRetryingWhenOffline(request);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(2);
    expect(offline.getOffline()).toBeNull();
  });

  it("counts a connectivity check that is slow to answer as online", async () => {
    const offline = await loadOffline();
    stubConnectivityChecks(["hang"]);
    const state = offline.notifyOffline();

    await vi.advanceTimersByTimeAsync(200);

    expect(offline.getOffline()).toBeNull();
    await expect(offline.waitForConnection(state)).resolves.toBeUndefined();
  });

  it("does not retry or go offline when a request is aborted", async () => {
    const offline = await loadOffline();
    const abort = new DOMException("superseded", "AbortError");

    await expect(offline.fetchRetryingWhenOffline(() => Promise.reject(abort))).rejects.toBe(abort);
    expect(offline.getOffline()).toBeNull();
  });
});

describe("prefetch queue with experimental.useOffline", () => {
  beforeEach(() => vi.stubEnv("__NEXT_USE_OFFLINE", "true"));

  it("holds prefetches while offline and sends them when the connection returns", async () => {
    const offline = await loadOffline();
    const queue = await loadQueue();
    stubConnectivityChecks(["fail"]);
    offline.notifyOffline();
    const prefetch = vi.fn(() => Promise.resolve(new Response("prefetch")));

    const result = queue.scheduleAppPrefetchFetch(prefetch, "low");
    await vi.advanceTimersByTimeAsync(0);
    expect(prefetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeInstanceOf(Response);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("sends a prefetch that lost the network again once it returns", async () => {
    await loadOffline();
    const queue = await loadQueue();
    stubConnectivityChecks(["fail"]);
    const response = new Response("prefetch");
    const prefetch = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(response);

    const result = queue.scheduleAppPrefetchFetch(prefetch, "low");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe(response);
  });
});
