// Behaviour ported from Next.js's offline module:
// packages/next/src/client/components/offline.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/offline.ts
// and its consumers (router-reducer/fetch-server-response.ts,
// reducers/server-action-reducer.ts, segment-cache/scheduler.ts). The browser
// flow is covered by tests/e2e/app-router-use-offline/use-offline.spec.ts,
// ported from test/e2e/app-dir/use-offline/use-offline.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type OfflineModule = typeof import("../packages/vinext/src/shims/internal/offline.js");
type QueueModule =
  typeof import("../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js");

async function loadOffline(): Promise<OfflineModule> {
  return import("../packages/vinext/src/shims/internal/offline.js");
}

async function loadQueue(): Promise<{ offline: OfflineModule; queue: QueueModule }> {
  const offline = await loadOffline();
  const queue = await import("../packages/vinext/src/shims/internal/app-prefetch-fetch-queue.js");
  return { offline, queue };
}

function networkError(): TypeError {
  return new TypeError("Failed to fetch");
}

/** A fetch stub: HEAD checks answer from `heads` in order, other calls from `gets`. */
function stubFetch(options: {
  heads?: Array<"fail" | "ok" | "hang">;
  gets?: Array<"fail" | Response>;
}) {
  const heads = [...(options.heads ?? [])];
  const gets = [...(options.gets ?? [])];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      const next = heads.shift() ?? "ok";
      if (next === "fail") return Promise.reject(networkError());
      if (next === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    const next = gets.shift();
    if (next === undefined || next === "fail") return Promise.reject(networkError());
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function headCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "HEAD");
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  vi.stubGlobal("location", { href: "https://example.com/current?q=1" });
});

afterEach(async () => {
  (await loadOffline())._resetOfflineStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("offline state", () => {
  it("does not treat an abort or a timeout as a network error", async () => {
    const offline = await loadOffline();
    stubFetch({});
    expect(offline.checkOfflineError(new DOMException("x", "AbortError"))).toBe(false);
    expect(offline.checkOfflineError(new DOMException("x", "TimeoutError"))).toBe(false);
    expect(offline.getOffline()).toBeNull();
  });

  it("enters the offline state on a network error and tells the provider", async () => {
    const offline = await loadOffline();
    stubFetch({ heads: ["fail"] });
    const changes: boolean[] = [];
    offline.setOfflineChangeListener((isOffline) => changes.push(isOffline));

    expect(offline.checkOfflineError(networkError())).toBe(true);
    expect(offline.getOffline()).not.toBeNull();
    expect(changes).toEqual([true]);
    // A second error joins the same state.
    const state = offline.getOffline();
    offline.checkOfflineError(networkError());
    expect(offline.getOffline()).toBe(state);
    expect(changes).toEqual([true]);
  });

  it("polls the current URL with HEAD and the RSC header, backing off 500, 1000, 2000, 3000 ms", async () => {
    const offline = await loadOffline();
    const fetchMock = stubFetch({ heads: ["fail", "fail", "fail", "fail", "fail", "ok"] });
    const changes: boolean[] = [];
    offline.setOfflineChangeListener((isOffline) => changes.push(isOffline));

    offline.notifyOffline();
    await vi.advanceTimersByTimeAsync(0);
    expect(headCalls(fetchMock)).toHaveLength(1);
    const [url, init] = headCalls(fetchMock)[0];
    expect(url).toBe("https://example.com/current?q=1");
    expect(init?.headers).toEqual({ RSC: "1" });

    for (const [delay, calls] of [
      [500, 2],
      [1000, 3],
      [2000, 4],
      [3000, 5],
      [3000, 6],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(headCalls(fetchMock)).toHaveLength(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(headCalls(fetchMock)).toHaveLength(calls);
    }
    expect(offline.getOffline()).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  it("treats a HEAD check still waiting after 200 ms as back online", async () => {
    const offline = await loadOffline();
    stubFetch({ heads: ["hang"] });
    const state = offline.notifyOffline();
    let resolved = false;
    void offline.waitForConnection(state).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    expect(offline.getOffline()).toBeNull();
  });

  it("listens for the browser's offline and online events", async () => {
    const offline = await loadOffline();
    const fetchMock = stubFetch({ heads: ["fail", "ok"] });
    offline.installOfflineListeners();

    window.dispatchEvent(new Event("offline"));
    expect(offline.getOffline()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(headCalls(fetchMock)).toHaveLength(1);

    // `online` checks at once instead of waiting out the 500 ms backoff.
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(headCalls(fetchMock)).toHaveLength(2);
    expect(offline.getOffline()).toBeNull();
  });
});

describe("fetchRetryingWhenOffline", () => {
  it("waits for the connection and sends the request again", async () => {
    const offline = await loadOffline();
    const response = new Response("payload");
    const fetchMock = stubFetch({ heads: ["fail", "ok"], gets: ["fail", response] });
    const changes: boolean[] = [];
    offline.setOfflineChangeListener((isOffline) => changes.push(isOffline));

    const result = offline.fetchRetryingWhenOffline(() => fetch("/target.rsc"));
    await vi.advanceTimersByTimeAsync(0);
    expect(offline.getOffline()).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/target.rsc")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe(response);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/target.rsc")).toHaveLength(2);
    expect(changes).toEqual([true, false]);
  });

  it("leaves the offline state when a request succeeds", async () => {
    const offline = await loadOffline();
    stubFetch({ heads: ["fail", "fail", "fail"], gets: [new Response("ok")] });
    offline.notifyOffline();
    await offline.fetchRetryingWhenOffline(() => fetch("/other.rsc"));
    expect(offline.getOffline()).toBeNull();
  });

  it("throws an abort without entering the offline state", async () => {
    const offline = await loadOffline();
    const abort = new DOMException("superseded", "AbortError");
    await expect(offline.fetchRetryingWhenOffline(() => Promise.reject(abort))).rejects.toBe(abort);
    expect(offline.getOffline()).toBeNull();
  });

  it("throws a network error when the caller no longer wants a retry", async () => {
    const offline = await loadOffline();
    stubFetch({});
    const error = networkError();
    await expect(
      offline.fetchRetryingWhenOffline(
        () => Promise.reject(error),
        () => false,
      ),
    ).rejects.toBe(error);
  });
});

describe("prefetch queue while offline", () => {
  it("holds queued prefetches while offline and sends them when the connection returns", async () => {
    vi.stubEnv("__NEXT_USE_OFFLINE", "true");
    const { offline, queue } = await loadQueue();
    stubFetch({ heads: ["fail", "ok"] });
    offline.notifyOffline();

    const fetcher = vi.fn(() => Promise.resolve(new Response("prefetch")));
    const request = queue.scheduleAppPrefetchFetch(fetcher, "low");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(offline.getOffline()).toBeNull();
    await expect(request).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends a prefetch that lost the network again once it returns", async () => {
    vi.stubEnv("__NEXT_USE_OFFLINE", "true");
    const { offline, queue } = await loadQueue();
    stubFetch({ heads: ["fail", "ok"] });
    const response = new Response("prefetch");
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<Response>>()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(response);

    const request = queue.scheduleAppPrefetchFetch(fetcher, "low");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(offline.getOffline()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    await expect(request).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("drops a held prefetch that is no longer wanted when the connection returns", async () => {
    vi.stubEnv("__NEXT_USE_OFFLINE", "true");
    const { offline, queue } = await loadQueue();
    stubFetch({ heads: ["fail", "ok"] });
    offline.notifyOffline();
    let wanted = true;
    const fetcher = vi.fn(() => Promise.resolve(new Response("prefetch")));
    const request = queue.scheduleAppPrefetchFetch(fetcher, "low", () => wanted);
    const settled = request.catch((error: unknown) => error);
    wanted = false;

    await vi.advanceTimersByTimeAsync(500);
    expect(await settled).toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a prefetch that lost the network when useOffline is off", async () => {
    const { offline, queue } = await loadQueue();
    const error = networkError();
    const request = queue.scheduleAppPrefetchFetch(() => Promise.reject(error), "low");
    await expect(request).rejects.toBe(error);
    expect(offline.getOffline()).toBeNull();
  });
});
