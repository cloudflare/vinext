import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type FetchQueue =
  typeof import("../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js");

async function loadQueue(): Promise<FetchQueue> {
  vi.resetModules();
  return import("../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe("app prefetch fetch queue revalidation cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds low- and high-priority prefetches for 300ms after a revalidation", async () => {
    // Next.js: REVALIDATION_COOLDOWN_MS in client/components/segment-cache/scheduler.ts
    const queue = await loadQueue();
    const fetcher = vi.fn(async () => new Response(""));

    queue.startAppPrefetchRevalidationCooldown();
    void queue.scheduleAppPrefetchFetch(fetcher, "low");
    void queue.scheduleAppPrefetchFetch(fetcher, "high");
    let probeReleased = false;
    void queue.waitForAppPrefetchRevalidationCooldown().then(() => {
      probeReleased = true;
    });
    await flushMicrotasks();
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(299);
    expect(fetcher).not.toHaveBeenCalled();
    expect(probeReleased).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(probeReleased).toBe(true);
  });

  it("keeps the concurrency cap when the cooldown releases held prefetches", async () => {
    const queue = await loadQueue();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));

    queue.startAppPrefetchRevalidationCooldown();
    for (let index = 0; index < 6; index++) {
      void queue.scheduleAppPrefetchFetch(fetcher, "low");
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("restarts the cooldown when another revalidation lands", async () => {
    const queue = await loadQueue();
    const fetcher = vi.fn(async () => new Response(""));

    queue.startAppPrefetchRevalidationCooldown();
    void queue.scheduleAppPrefetchFetch(fetcher, "low");
    await vi.advanceTimersByTimeAsync(200);
    queue.startAppPrefetchRevalidationCooldown();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports held prefetches and never promotes them past the cooldown", async () => {
    const queue = await loadQueue();
    const lowFetcher = vi.fn(async () => new Response("low"));
    const highFetcher = vi.fn(async () => new Response("high"));
    const gated = queue.markGatedAppPrefetchFetch(new Promise<Response>(() => {}));

    queue.startAppPrefetchRevalidationCooldown();
    const low = queue.scheduleAppPrefetchFetch(lowFetcher, "low");
    const high = queue.scheduleAppPrefetchFetch(highFetcher, "high");
    await flushMicrotasks();
    expect(queue.isAppPrefetchFetchHeldByRevalidationCooldown(low)).toBe(true);
    expect(queue.isAppPrefetchFetchHeldByRevalidationCooldown(high)).toBe(true);
    expect(queue.isAppPrefetchFetchHeldByRevalidationCooldown(gated)).toBe(true);

    queue.promoteAppPrefetchFetch(low);
    queue.promoteAppPrefetchFetch(high);
    expect(lowFetcher).not.toHaveBeenCalled();
    expect(highFetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(lowFetcher).toHaveBeenCalledTimes(1);
    expect(highFetcher).toHaveBeenCalledTimes(1);
    expect(queue.isAppPrefetchFetchHeldByRevalidationCooldown(low)).toBe(false);
    expect(queue.isAppPrefetchFetchHeldByRevalidationCooldown(high)).toBe(false);
    expect(queue.isAppPrefetchFetchHeldByRevalidationCooldown(gated)).toBe(false);
  });

  it("drops a held high-priority prefetch that is cancelled", async () => {
    const queue = await loadQueue();
    const fetcher = vi.fn(async () => new Response(""));

    queue.startAppPrefetchRevalidationCooldown();
    const high = queue.scheduleAppPrefetchFetch(fetcher, "high");
    queue.cancelAppPrefetchFetch(high);
    await expect(high).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(300);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends prefetches immediately without a revalidation", async () => {
    const queue = await loadQueue();
    const fetcher = vi.fn(async () => new Response(""));

    void queue.scheduleAppPrefetchFetch(fetcher, "high");
    void queue.scheduleAppPrefetchFetch(fetcher, "low");
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(queue.waitForAppPrefetchRevalidationCooldown()).resolves.toBeUndefined();
  });
});
