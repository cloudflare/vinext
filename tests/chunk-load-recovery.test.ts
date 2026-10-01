import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

type Recovery = typeof import("../packages/vinext/src/client/chunk-load-recovery.js");
type Outcome = { onAbandoned(): void; onCanceled(): void };

const STORAGE_KEY = "__vinext_chunk_recovery__";
const STATE_KEY = Symbol.for("vinext.chunk-recovery");
const ENTRY = "https://app.test/assets/index-abc123.js";
const PAGE = "https://app.test/page?x=1";
const MINUTE = 60_000;

const WARN_REPLACED = "[vinext] This page's build was replaced. Reloading the page.";
const WARN_PINNED = "[vinext] A script failed to load and will not be retried. Reloading the page.";

class FakeStorage {
  readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

type FakeWindow = EventTarget & {
  location: { href: string; replace: Mock<(href: string) => void> };
  navigation: EventTarget;
  sessionStorage: unknown;
};

type Context = {
  fetch: Mock<(url: string, init: RequestInit) => Promise<unknown>>;
  mod: Recovery;
  navigate: (init?: { download?: string | null; sameDocument?: boolean }) => AbortController;
  navigation: EventTarget;
  navigator: Mock<(outcome: Outcome) => boolean>;
  outcome: () => Outcome;
  replace: Mock<(href: string) => void>;
  storage: FakeStorage;
  win: FakeWindow;
};

function response(status: number, contentType?: string): Response {
  return new Response(null, {
    headers: contentType === undefined ? {} : { "content-type": contentType },
    status,
  });
}

function track(promise: Promise<unknown>) {
  const result = { reason: undefined as unknown, status: "pending" as "pending" | "rejected" };
  promise.then(
    () => undefined,
    (reason: unknown) => {
      result.status = "rejected";
      result.reason = reason;
    },
  );
  return result;
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function readClaims(ctx: Context): unknown {
  const raw = ctx.storage.data.get(STORAGE_KEY);
  return raw === undefined ? {} : JSON.parse(raw);
}

function claimKey(verdict: "pinned" | "replaced", entryUrl: string = ENTRY): string {
  return `${verdict} ${entryUrl}`;
}

async function setup(
  options: { entryUrl?: string | null; navigator?: boolean; register?: boolean } = {},
) {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, STATE_KEY);

  const navigation = new EventTarget();
  const replace = vi.fn<(href: string) => void>();
  const storage = new FakeStorage();
  const win = Object.assign(new EventTarget(), {
    location: { href: PAGE, replace },
    navigation,
    sessionStorage: storage,
  });
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit): Promise<unknown> =>
    response(404),
  );
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchMock);

  const mod = await import("../packages/vinext/src/client/chunk-load-recovery.js");
  let current: Outcome | undefined;
  const navigator = vi.fn((outcome: Outcome) => {
    current = outcome;
    return true;
  });
  if (options.navigator !== false) mod.setChunkRecoveryNavigator(navigator);
  if (options.register !== false) {
    mod.registerChunkRecovery({
      entryUrl: options.entryUrl === undefined ? ENTRY : options.entryUrl,
    });
  }

  const ctx: Context = {
    fetch: fetchMock,
    mod,
    navigate(init = {}) {
      const controller = new AbortController();
      navigation.dispatchEvent(
        Object.assign(new Event("navigate"), {
          destination: { sameDocument: init.sameDocument ?? false },
          downloadRequest: init.download ?? null,
          signal: controller.signal,
        }),
      );
      return controller;
    },
    navigation,
    navigator,
    outcome() {
      if (!current) throw new Error("navigator was not called");
      return current;
    },
    replace,
    storage,
    win,
  };
  return ctx;
}

function pageshow(ctx: Context, persisted = false): void {
  ctx.win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
}

function pagehide(ctx: Context): void {
  ctx.win.dispatchEvent(new Event("pagehide"));
}

function preloadError(ctx: Context, payload: unknown): void {
  ctx.win.dispatchEvent(Object.assign(new Event("vite:preloadError"), { payload }));
}

function deployFailure(ctx: Context): Error {
  const error = new Error("deploy failure");
  preloadError(ctx, error);
  return error;
}

// A vinext loader that failed twice with different errors: registered as `retry`.
async function retryFailure(ctx: Context): Promise<Error> {
  const second = new Error("second attempt");
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("first attempt"))
    .mockRejectedValueOnce(second);
  const settled = ctx.mod.loadChunk(load).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(600);
  expect(await settled).toBe(second);
  return second;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, STATE_KEY);
});

describe("constants", () => {
  it("pins the documented values", async () => {
    const mod = await import("../packages/vinext/src/client/chunk-load-recovery.js");
    expect({
      BUILD_PROBE_TIMEOUT_MS: mod.BUILD_PROBE_TIMEOUT_MS,
      CHUNK_RECOVERY_MAX_LOADS: mod.CHUNK_RECOVERY_MAX_LOADS,
      CHUNK_RECOVERY_STORAGE_KEY: mod.CHUNK_RECOVERY_STORAGE_KEY,
      CHUNK_RECOVERY_WINDOW_MS: mod.CHUNK_RECOVERY_WINDOW_MS,
      CHUNK_RETRY_DELAY_MIN_MS: mod.CHUNK_RETRY_DELAY_MIN_MS,
      CHUNK_RETRY_DELAY_SPREAD_MS: mod.CHUNK_RETRY_DELAY_SPREAD_MS,
      DOCUMENT_UNLOAD_TIMEOUT_MS: mod.DOCUMENT_UNLOAD_TIMEOUT_MS,
    }).toEqual({
      BUILD_PROBE_TIMEOUT_MS: 5_000,
      CHUNK_RECOVERY_MAX_LOADS: 2,
      CHUNK_RECOVERY_STORAGE_KEY: STORAGE_KEY,
      CHUNK_RECOVERY_WINDOW_MS: 10 * MINUTE,
      CHUNK_RETRY_DELAY_MIN_MS: 200,
      CHUNK_RETRY_DELAY_SPREAD_MS: 400,
      DOCUMENT_UNLOAD_TIMEOUT_MS: 10_000,
    });
  });
});

describe("registration", () => {
  it("installs the four listeners in production", async () => {
    const ctx = await setup({ register: false });
    const windowListen = vi.spyOn(ctx.win, "addEventListener");
    const navigationListen = vi.spyOn(ctx.navigation, "addEventListener");

    ctx.mod.registerChunkRecovery({ entryUrl: ENTRY });
    ctx.mod.registerChunkRecovery({ entryUrl: ENTRY });

    expect(windowListen.mock.calls.map(([type]) => type)).toEqual([
      "pagehide",
      "pageshow",
      "vite:preloadError",
    ]);
    expect(navigationListen.mock.calls.map(([type]) => type)).toEqual(["navigate"]);
  });

  it("installs no listener and never probes without an entry URL (development)", async () => {
    const ctx = await setup({ register: false });
    const windowListen = vi.spyOn(ctx.win, "addEventListener");
    const navigationListen = vi.spyOn(ctx.navigation, "addEventListener");
    ctx.mod.registerChunkRecovery({ entryUrl: null });
    const error = new Error("user loader");
    const load = vi.fn().mockRejectedValue(error);
    const result = ctx.mod.loadChunk(load, { retry: false }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(600);
    await result;

    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);

    expect(windowListen).not.toHaveBeenCalled();
    expect(navigationListen).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ctx.navigator).not.toHaveBeenCalled();
  });

  it("reads the registration when a failure happens, not when a load starts", async () => {
    const ctx = await setup({ register: false });
    const error = new Error("failed before the entry registered");
    const load = vi.fn().mockRejectedValue(error);
    const result = ctx.mod.loadChunk(load, { retry: false }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(600);
    await result;
    ctx.mod.registerChunkRecovery({ entryUrl: ENTRY });

    void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
    await flush();

    expect(ctx.fetch.mock.calls.map(([url]) => url)).toEqual([ENTRY]);
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });
});

describe("loadChunk", () => {
  it("resolves the happy path with no probe, timer, storage access or registry write", async () => {
    const ctx = await setup();
    const getItem = vi.spyOn(ctx.storage, "getItem");
    const setItem = vi.spyOn(ctx.storage, "setItem");
    const value = { default: () => null };
    const load = vi.fn(async () => value);

    await expect(ctx.mod.loadChunk(load)).resolves.toBe(value);

    expect(load).toHaveBeenCalledTimes(1);
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    await expect(ctx.mod.recoverFromChunkFailure(value)).rejects.toBe(value);
  });

  it("turns a resolved undefined into a descriptive error that is not registered", async () => {
    const ctx = await setup();
    const load = vi.fn(async () => undefined);

    const caught = await ctx.mod.loadChunk(load).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "[vinext] A vite:preloadError listener handled this script failure, so vinext did not recover.",
    );
    expect(load).toHaveBeenCalledTimes(1);
    await expect(ctx.mod.recoverFromChunkFailure(caught)).rejects.toBe(caught);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("returns a resolved undefined unchanged when retry is off", async () => {
    const ctx = await setup();
    const load = vi.fn(async () => undefined);

    await expect(ctx.mod.loadChunk(load, { retry: false })).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [0, 200],
    [0.5, 400],
    [0.99, 596],
  ])("waits the jittered delay before retrying (random %s -> %s ms)", async (random, delay) => {
    const ctx = await setup();
    vi.spyOn(Math, "random").mockReturnValue(random);
    const load = vi.fn().mockRejectedValueOnce(new Error("first")).mockResolvedValueOnce("ok");

    const result = ctx.mod.loadChunk(load);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("pauses while the document is unloading and continues after pageshow", async () => {
    const ctx = await setup();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("aborted by navigation"))
      .mockResolvedValue("ok");

    const result = track(ctx.mod.loadChunk(load));
    pagehide(ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("pending");

    pageshow(ctx, true);
    await flush();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("waits for a recovery in flight, then rethrows unregistered without retrying", async () => {
    const ctx = await setup();
    const active = deployFailure(ctx);
    ctx.fetch.mockResolvedValue(response(404));
    const recovery = ctx.mod.recoverFromChunkFailure(active).catch(() => undefined);
    await flush();
    expect(ctx.navigator).toHaveBeenCalledTimes(1);

    const other = new Error("other");
    const load = vi.fn().mockRejectedValue(other);
    const result = track(ctx.mod.loadChunk(load));
    await vi.advanceTimersByTimeAsync(600);
    expect(result.status).toBe("pending");

    ctx.outcome().onCanceled();
    await recovery;
    await flush();

    expect(result).toEqual({ reason: other, status: "rejected" });
    expect(load).toHaveBeenCalledTimes(1);
    await expect(ctx.mod.recoverFromChunkFailure(other)).rejects.toBe(other);
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("returns the retry result when the second load succeeds", async () => {
    const ctx = await setup();
    const load = vi.fn().mockRejectedValueOnce(new Error("first")).mockResolvedValueOnce("second");

    const result = ctx.mod.loadChunk(load);
    await vi.advanceTimersByTimeAsync(600);

    await expect(result).resolves.toBe("second");
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("rethrows an evaluation error (same value twice) and removes it from the registry", async () => {
    const ctx = await setup();
    const evaluationError = new SyntaxError("module threw while evaluating");
    const load = vi.fn(async () => {
      preloadError(ctx, evaluationError);
      throw evaluationError;
    });

    const result = track(ctx.mod.loadChunk(load));
    await vi.advanceTimersByTimeAsync(600);

    expect(result).toEqual({ reason: evaluationError, status: "rejected" });
    expect(load).toHaveBeenCalledTimes(2);
    await expect(ctx.mod.recoverFromChunkFailure(evaluationError)).rejects.toBe(evaluationError);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("registers a new second error as `retry`", async () => {
    const ctx = await setup();
    const error = await retryFailure(ctx);
    ctx.fetch.mockResolvedValue(response(200, "text/javascript"));

    void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(WARN_PINNED);
  });

  it("registers the error as `deploy` when retry is off", async () => {
    const ctx = await setup();
    const error = new Error("user loader");
    const load = vi.fn().mockRejectedValue(error);

    const result = track(ctx.mod.loadChunk(load, { retry: false }));
    await vi.advanceTimersByTimeAsync(600);
    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(load).toHaveBeenCalledTimes(1);

    ctx.fetch.mockResolvedValue(response(200, "text/javascript"));
    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);
    expect(ctx.navigator).not.toHaveBeenCalled();

    ctx.fetch.mockResolvedValue(response(404));
    void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
    await flush();
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(WARN_REPLACED);
  });

  it("rethrows a thrown primitive unregistered", async () => {
    const ctx = await setup();
    const load = vi.fn().mockRejectedValue("boom");

    const result = track(ctx.mod.loadChunk(load));
    await vi.advanceTimersByTimeAsync(600);

    expect(result).toEqual({ reason: "boom", status: "rejected" });
    expect(load).toHaveBeenCalledTimes(2);
    await expect(ctx.mod.recoverFromChunkFailure("boom")).rejects.toBe("boom");
    expect(ctx.fetch).not.toHaveBeenCalled();
  });
});

describe("failure registry", () => {
  it("registers a vite:preloadError payload as `deploy`", async () => {
    const ctx = await setup();
    const error = deployFailure(ctx);

    ctx.fetch.mockResolvedValue(response(200, "text/javascript"));
    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);
    expect(ctx.navigator).not.toHaveBeenCalled();

    ctx.fetch.mockResolvedValue(response(410));
    void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
    await flush();
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it.each([["a string"], [undefined], [42], [null]])(
    "ignores a non-object payload (%s)",
    async (payload) => {
      const ctx = await setup();
      preloadError(ctx, payload);

      await expect(ctx.mod.recoverFromChunkFailure(payload)).rejects.toBe(payload);
      expect(ctx.fetch).not.toHaveBeenCalled();
    },
  );

  it("lets loadChunk override the listener's record", async () => {
    const ctx = await setup();
    const second = new Error("second");
    const load = vi.fn(async () => {
      const error = load.mock.calls.length === 1 ? new Error("first") : second;
      preloadError(ctx, error);
      throw error;
    });

    const result = ctx.mod.loadChunk(load).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toBe(second);

    ctx.fetch.mockResolvedValue(response(200, "text/javascript"));
    void ctx.mod.recoverFromChunkFailure(second).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(WARN_PINNED);
  });
});

describe("build probe", () => {
  const opaqueRedirect = { headers: new Headers(), status: 0, type: "opaqueredirect" };

  it.each<[string, () => unknown, "replaced" | "pinned" | "unavailable"]>([
    ["opaqueredirect", () => opaqueRedirect, "replaced"],
    ["200 text/javascript", () => response(200, "text/javascript"), "pinned"],
    ["200 application/javascript", () => response(200, "application/javascript"), "pinned"],
    ["200 with no content-type", () => response(200), "pinned"],
    ["200 text/html", () => response(200, "text/html; charset=utf-8"), "replaced"],
    ["401", () => response(401), "replaced"],
    ["403", () => response(403), "replaced"],
    ["404", () => response(404), "replaced"],
    ["410", () => response(410), "replaced"],
    ["405", () => response(405), "unavailable"],
    ["501", () => response(501), "unavailable"],
    ["429", () => response(429), "unavailable"],
    ["500", () => response(500), "unavailable"],
    ["502", () => response(502), "unavailable"],
    ["503", () => response(503), "unavailable"],
  ])("classifies a probe answer of %s for a `retry` failure", async (_name, reply, expected) => {
    const ctx = await setup();
    const error = await retryFailure(ctx);
    ctx.fetch.mockImplementation(async () => reply());

    const result = track(ctx.mod.recoverFromChunkFailure(error));
    await flush();

    if (expected === "unavailable") {
      expect(result).toEqual({ reason: error, status: "rejected" });
      expect(ctx.navigator).not.toHaveBeenCalled();
    } else {
      expect(result.status).toBe("pending");
      expect(ctx.navigator).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith(
        expected === "replaced" ? WARN_REPLACED : WARN_PINNED,
      );
    }
  });

  it("treats a thrown fetch as unavailable", async () => {
    const ctx = await setup();
    const error = await retryFailure(ctx);
    ctx.fetch.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);
    expect(ctx.navigator).not.toHaveBeenCalled();
  });

  it("treats the probe timeout as unavailable and sends the documented request", async () => {
    const ctx = await setup();
    const error = await retryFailure(ctx);
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    ctx.fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("", "TimeoutError")),
          );
        }),
    );

    const result = track(ctx.mod.recoverFromChunkFailure(error));
    await flush();
    expect(result.status).toBe("pending");
    timeout.abort();
    await flush();

    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(ctx.fetch.mock.calls).toEqual([
      [
        ENTRY,
        {
          cache: "no-store",
          credentials: "same-origin",
          method: "HEAD",
          redirect: "manual",
          signal: timeout.signal,
        },
      ],
    ]);
  });

  it("shares one probe between concurrent callers", async () => {
    const ctx = await setup();
    const first = deployFailure(ctx);
    const second = deployFailure(ctx);

    void ctx.mod.recoverFromChunkFailure(first).catch(() => undefined);
    void ctx.mod.recoverFromChunkFailure(second).catch(() => undefined);
    await flush();

    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("recovery decision", () => {
  it("rejects an unregistered error with that error and starts nothing", async () => {
    const ctx = await setup();
    const error = new Error("never seen");

    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);

    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ctx.navigator).not.toHaveBeenCalled();
  });

  it("rejects while offline, keeps the registration, and recovers once online", async () => {
    const ctx = await setup();
    const error = deployFailure(ctx);
    vi.stubGlobal("navigator", { onLine: false });

    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);
    expect(ctx.fetch).not.toHaveBeenCalled();

    vi.stubGlobal("navigator", { onLine: true });
    void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
    await flush();
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("does not count an undefined navigator.onLine as offline", async () => {
    const ctx = await setup();
    const error = deployFailure(ctx);
    vi.stubGlobal("navigator", {});

    void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("rejects a `deploy` failure when the build is still live", async () => {
    const ctx = await setup();
    const error = deployFailure(ctx);
    ctx.fetch.mockResolvedValue(response(200, "text/javascript"));

    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);
    expect(ctx.navigator).not.toHaveBeenCalled();
    expect(readClaims(ctx)).toEqual({});
  });

  it("suspends after the probe while the document is unloading, until pageshow", async () => {
    const ctx = await setup();
    const error = deployFailure(ctx);
    let answer: (value: Response) => void = () => undefined;
    ctx.fetch.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
    await flush();
    pagehide(ctx);
    answer(response(404));
    await flush();
    expect(ctx.navigator).not.toHaveBeenCalled();

    pageshow(ctx);
    await flush();
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("pins the verdict when any error joined before the live probe answered is `retry`", async () => {
    const ctx = await setup();
    const retry = await retryFailure(ctx);
    const deploy = deployFailure(ctx);
    let answer: (value: Response) => void = () => undefined;
    ctx.fetch.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    const first = track(ctx.mod.recoverFromChunkFailure(deploy));
    const second = track(ctx.mod.recoverFromChunkFailure(retry));
    await flush();
    answer(response(200, "text/javascript"));
    await flush();

    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(WARN_PINNED);
    expect([first.status, second.status]).toEqual(["pending", "pending"]);
  });

  it("keeps a rejecting decision pending while the document is unloading", async () => {
    const ctx = await setup();
    const error = deployFailure(ctx);
    let answer: (value: Response) => void = () => undefined;
    ctx.fetch.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    const result = track(ctx.mod.recoverFromChunkFailure(error));
    await flush();
    pagehide(ctx);
    answer(response(503));
    await flush();
    expect(result.status).toBe("pending");

    pageshow(ctx);
    await flush();
    expect(result).toEqual({ reason: error, status: "rejected" });
  });

  describe("pending document navigation", () => {
    async function recoverDuringNavigation(ctx: Context) {
      const error = deployFailure(ctx);
      void ctx.mod.recoverFromChunkFailure(error).catch(() => undefined);
      await flush();
    }

    it("waits until the navigation aborts", async () => {
      const ctx = await setup();
      const navigation = ctx.navigate();

      await recoverDuringNavigation(ctx);
      expect(ctx.fetch).toHaveBeenCalledTimes(1);
      expect(ctx.navigator).not.toHaveBeenCalled();

      navigation.abort();
      await flush();
      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("waits until the unload timeout passes", async () => {
      const ctx = await setup();
      ctx.navigate();

      await recoverDuringNavigation(ctx);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(ctx.navigator).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("waits until pageshow", async () => {
      const ctx = await setup();
      ctx.navigate();

      await recoverDuringNavigation(ctx);
      expect(ctx.navigator).not.toHaveBeenCalled();
      pageshow(ctx);
      await flush();

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("does not wait for an event with a download request", async () => {
      const ctx = await setup();
      ctx.navigate({ download: "" });
      ctx.navigate({ download: "report.csv" });

      await recoverDuringNavigation(ctx);

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("does not wait for a same-document event", async () => {
      const ctx = await setup();
      ctx.navigate({ sameDocument: true });

      await recoverDuringNavigation(ctx);

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("does not wait for an already aborted navigation", async () => {
      const ctx = await setup();
      const controller = new AbortController();
      controller.abort();
      ctx.navigation.dispatchEvent(
        Object.assign(new Event("navigate"), {
          destination: { sameDocument: false },
          downloadRequest: null,
          signal: controller.signal,
        }),
      );

      await recoverDuringNavigation(ctx);

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("stops waiting for a record older than the unload timeout", async () => {
      const ctx = await setup();
      ctx.navigate();
      await vi.advanceTimersByTimeAsync(10_000);

      await recoverDuringNavigation(ctx);

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("clears the record and the unloading flag on pageshow", async () => {
      const ctx = await setup();
      pagehide(ctx);
      ctx.navigate();
      pageshow(ctx, true);

      await recoverDuringNavigation(ctx);

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });

    it("ignores a download event that follows a real cross-document one", async () => {
      const ctx = await setup();
      const navigation = ctx.navigate();
      ctx.navigate({ download: "x.csv" });
      ctx.navigate({ sameDocument: true });

      await recoverDuringNavigation(ctx);
      expect(ctx.navigator).not.toHaveBeenCalled();
      navigation.abort();
      await flush();

      expect(ctx.navigator).toHaveBeenCalledTimes(1);
    });
  });
});

describe("claim", () => {
  it("records the claim on success", async () => {
    const ctx = await setup();
    const now = Date.now();

    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();

    expect(readClaims(ctx)).toEqual({ [claimKey("replaced")]: now });
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("refuses the same entry URL and verdict within the window, with one console.error", async () => {
    const ctx = await setup();
    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();
    ctx.outcome().onAbandoned();
    await flush();

    const second = deployFailure(ctx);
    await expect(ctx.mod.recoverFromChunkFailure(second)).rejects.toBe(second);

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toBe(
      "[vinext] A script failed to load. Reload the page by hand; if that fails, check the deploy for missing built assets.",
    );
  });

  it("allows the same entry URL and verdict again after the window, pruning the old record", async () => {
    const ctx = await setup();
    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();
    ctx.outcome().onAbandoned();
    await flush();

    await vi.advanceTimersByTimeAsync(10 * MINUTE + 1);
    const now = Date.now();
    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(2);
    expect(readClaims(ctx)).toEqual({ [claimKey("replaced")]: now });
  });

  it("refuses at the cap across alternating entry URLs", async () => {
    const ctx = await setup();
    for (const entry of ["https://app.test/a.js", "https://app.test/b.js"]) {
      ctx.mod.registerChunkRecovery({ entryUrl: entry });
      void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
      await flush();
      ctx.outcome().onAbandoned();
      await flush();
    }
    expect(ctx.navigator).toHaveBeenCalledTimes(2);

    ctx.mod.registerChunkRecovery({ entryUrl: "https://app.test/c.js" });
    const third = deployFailure(ctx);
    await expect(ctx.mod.recoverFromChunkFailure(third)).rejects.toBe(third);

    expect(ctx.navigator).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("claims `replaced` and `pinned` independently", async () => {
    const ctx = await setup();
    const replacedAt = Date.now();
    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();
    ctx.outcome().onAbandoned();
    await flush();

    const pinned = await retryFailure(ctx);
    const pinnedAt = Date.now();
    ctx.fetch.mockResolvedValue(response(200, "text/javascript"));
    void ctx.mod.recoverFromChunkFailure(pinned).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(2);
    expect(readClaims(ctx)).toEqual({
      [claimKey("replaced")]: replacedAt,
      [claimKey("pinned")]: pinnedAt,
    });
  });

  it("prunes records older than the window before counting", async () => {
    const ctx = await setup();
    const now = Date.now();
    const oldKey = claimKey("pinned", "https://app.test/old.js");
    const recentKey = claimKey("pinned", "https://app.test/recent.js");
    ctx.storage.data.set(
      STORAGE_KEY,
      JSON.stringify({ [oldKey]: now - 10 * MINUTE - 1, [recentKey]: now - MINUTE }),
    );

    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(readClaims(ctx)).toEqual({ [recentKey]: now - MINUTE, [claimKey("replaced")]: now });
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["JSON null", "null"],
    ["a JSON number", "5"],
    ["a JSON string", '"x"'],
    ["a list of records", JSON.stringify([{ at: Date.now(), entryUrl: ENTRY, verdict: "pinned" }])],
    [
      "values that are not timestamps",
      JSON.stringify({ [claimKey("pinned")]: "soon", other: null }),
    ],
  ])("treats stored claims of %s as empty", async (_name, stored) => {
    const ctx = await setup();
    ctx.storage.data.set(STORAGE_KEY, stored);
    const now = Date.now();

    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(readClaims(ctx)).toEqual({ [claimKey("replaced")]: now });
  });

  it.each<[string, (ctx: Context) => void]>([
    [
      "missing",
      (ctx) => {
        ctx.win.sessionStorage = undefined;
      },
    ],
    [
      "throwing",
      (ctx) => {
        Object.defineProperty(ctx.win, "sessionStorage", {
          get() {
            throw new DOMException("denied", "SecurityError");
          },
        });
      },
    ],
    [
      "not persisting",
      (ctx) => {
        ctx.storage.setItem = () => undefined;
      },
    ],
  ])("refuses when storage is %s", async (_name, break_) => {
    const ctx = await setup();
    break_(ctx);
    const error = deployFailure(ctx);

    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);

    expect(ctx.navigator).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe("settling", () => {
  it("releases the claim and rejects when the navigator refuses", async () => {
    const ctx = await setup();
    ctx.navigator.mockReturnValue(false);
    const error = deployFailure(ctx);

    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);

    expect(readClaims(ctx)).toEqual({});
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("on cancel rejects every caller with its own error, deregisters them, and releases the claim", async () => {
    const ctx = await setup();
    const first = deployFailure(ctx);
    const second = deployFailure(ctx);
    const one = track(ctx.mod.recoverFromChunkFailure(first));
    const two = track(ctx.mod.recoverFromChunkFailure(second));
    await flush();
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    expect([one.status, two.status]).toEqual(["pending", "pending"]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(WARN_REPLACED);

    ctx.outcome().onCanceled();
    await flush();

    expect(one).toEqual({ reason: first, status: "rejected" });
    expect(two).toEqual({ reason: second, status: "rejected" });
    expect(readClaims(ctx)).toEqual({});
    await expect(ctx.mod.recoverFromChunkFailure(first)).rejects.toBe(first);
    await expect(ctx.mod.recoverFromChunkFailure(second)).rejects.toBe(second);
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("on abandon rejects callers, deregisters them, and keeps the claim", async () => {
    const ctx = await setup();
    const first = deployFailure(ctx);
    const second = deployFailure(ctx);
    const one = track(ctx.mod.recoverFromChunkFailure(first));
    const two = track(ctx.mod.recoverFromChunkFailure(second));
    await flush();

    ctx.outcome().onAbandoned();
    await flush();

    expect(one).toEqual({ reason: first, status: "rejected" });
    expect(two).toEqual({ reason: second, status: "rejected" });
    expect(readClaims(ctx)).toEqual({ [claimKey("replaced")]: Date.now() });
    await expect(ctx.mod.recoverFromChunkFailure(first)).rejects.toBe(first);
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("treats a persisted pageshow like an abandon", async () => {
    const ctx = await setup();
    const error = deployFailure(ctx);
    const result = track(ctx.mod.recoverFromChunkFailure(error));
    await flush();

    pageshow(ctx, false);
    await flush();
    expect(result.status).toBe("pending");

    pageshow(ctx, true);
    await flush();

    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(readClaims(ctx)).toEqual({ [claimKey("replaced")]: Date.now() });
    await expect(ctx.mod.recoverFromChunkFailure(error)).rejects.toBe(error);
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("settles nothing once pagehide has been seen", async () => {
    const ctx = await setup();
    const result = track(ctx.mod.recoverFromChunkFailure(deployFailure(ctx)));
    await flush();

    pagehide(ctx);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.status).toBe("pending");
  });

  it("lets a later failure start a new recovery after a cancel", async () => {
    const ctx = await setup();
    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();
    ctx.outcome().onCanceled();
    await flush();

    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(2);
  });
});

describe("default navigator", () => {
  function causeNavigate(ctx: Context, controller: AbortController) {
    ctx.replace.mockImplementation(() => {
      ctx.navigation.dispatchEvent(
        Object.assign(new Event("navigate"), {
          destination: { sameDocument: false },
          downloadRequest: null,
          signal: controller.signal,
        }),
      );
    });
  }

  async function start(href = PAGE) {
    const ctx = await setup({ navigator: false });
    (ctx.win.location as { href: string }).href = href;
    const error = deployFailure(ctx);
    const controller = new AbortController();
    causeNavigate(ctx, controller);
    const result = track(ctx.mod.recoverFromChunkFailure(error));
    await flush();
    return { controller, ctx, error, result };
  }

  it("replaces the document with the current URL", async () => {
    const { ctx, result } = await start();

    expect(ctx.replace.mock.calls).toEqual([[PAGE]]);
    expect(result.status).toBe("pending");
    expect(console.warn).toHaveBeenCalledWith(WARN_REPLACED);
  });

  it("drops the fragment of the current URL", async () => {
    const { ctx } = await start("https://app.test/page?x=1#section");

    expect(ctx.replace.mock.calls).toEqual([["https://app.test/page?x=1"]]);
  });

  it("reports onCanceled when the navigate event it caused aborts", async () => {
    const { controller, ctx, error, result } = await start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.status).toBe("pending");

    controller.abort();
    await flush();

    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(readClaims(ctx)).toEqual({});
  });

  it("reports onAbandoned after the unload timeout", async () => {
    const { ctx, error, result } = await start();
    const claimedAt = Date.now();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(readClaims(ctx)).toEqual({ [claimKey("replaced")]: claimedAt });
  });

  it("stays pending once pagehide fires", async () => {
    const { ctx, result } = await start();
    pagehide(ctx);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.status).toBe("pending");
  });

  it("reports onAbandoned after the unload timeout when replace fired no navigate event", async () => {
    const ctx = await setup({ navigator: false });
    const error = deployFailure(ctx);
    const result = track(ctx.mod.recoverFromChunkFailure(error));
    await flush();
    const claimedAt = Date.now();
    expect(ctx.replace.mock.calls).toEqual([[PAGE]]);

    ctx.navigate().abort();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(readClaims(ctx)).toEqual({ [claimKey("replaced")]: claimedAt });
  });

  it("reports onCanceled at once when the navigate event it caused is already aborted", async () => {
    const ctx = await setup({ navigator: false });
    const controller = new AbortController();
    controller.abort();
    causeNavigate(ctx, controller);
    const error = deployFailure(ctx);

    const result = track(ctx.mod.recoverFromChunkFailure(error));
    await flush();

    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(readClaims(ctx)).toEqual({});
  });

  it("ignores a navigate event that fires after replace returned", async () => {
    const { controller, ctx, error, result } = await start();
    const unrelated = ctx.navigate();
    unrelated.abort();
    await flush();
    expect(result.status).toBe("pending");

    controller.abort();
    await flush();
    expect(result).toEqual({ reason: error, status: "rejected" });
  });

  it("is not used once setChunkRecoveryNavigator registered another", async () => {
    const ctx = await setup();

    void ctx.mod.recoverFromChunkFailure(deployFailure(ctx)).catch(() => undefined);
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(ctx.replace).not.toHaveBeenCalled();
  });
});

describe("shared state across module instances", () => {
  it("shares the registry, the navigator and the recovery", async () => {
    const ctx = await setup();
    vi.resetModules();
    const other = await import("../packages/vinext/src/client/chunk-load-recovery.js");
    expect(other.loadChunk).not.toBe(ctx.mod.loadChunk);

    const error = deployFailure(ctx);
    const result = track(other.recoverFromChunkFailure(error));
    await flush();

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(ctx.fetch.mock.calls[0][0]).toBe(ENTRY);

    const joined = new Error("joined");
    preloadError(ctx, joined);
    const joinedResult = track(ctx.mod.recoverFromChunkFailure(joined));
    ctx.outcome().onCanceled();
    await flush();

    expect(result).toEqual({ reason: error, status: "rejected" });
    expect(joinedResult).toEqual({ reason: joined, status: "rejected" });
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });
});

describe("loadClientReference", () => {
  it("recovers immediately before endImmediateClientReferenceRecovery", async () => {
    const ctx = await setup();
    ctx.fetch.mockResolvedValue(response(404));
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"));

    const result = track(ctx.mod.loadClientReference(load));
    await vi.advanceTimersByTimeAsync(600);

    expect(ctx.navigator).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("pending");
  });

  it("only records after endImmediateClientReferenceRecovery", async () => {
    const ctx = await setup();
    ctx.fetch.mockResolvedValue(response(404));
    ctx.mod.endImmediateClientReferenceRecovery();
    const second = new Error("second");
    const load = vi.fn().mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(second);

    const result = track(ctx.mod.loadClientReference(load));
    await vi.advanceTimersByTimeAsync(600);

    expect(result).toEqual({ reason: second, status: "rejected" });
    expect(ctx.navigator).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();

    void ctx.mod.recoverFromChunkFailure(second).catch(() => undefined);
    await flush();
    expect(ctx.navigator).toHaveBeenCalledTimes(1);
  });

  it("resolves the loaded module", async () => {
    const ctx = await setup();
    const value = { Component: () => null };

    await expect(ctx.mod.loadClientReference(async () => value)).resolves.toBe(value);
  });
});

describe("toDocumentLoadHref", () => {
  it.each([
    [
      "the same URL with a fragment",
      "https://app.test/page?x=1#section",
      "https://app.test/page?x=1",
    ],
    ["the same URL with a bare #", "https://app.test/page?x=1#", "https://app.test/page?x=1"],
    ["the same URL with no fragment", "https://app.test/page?x=1", "https://app.test/page?x=1"],
    ["a different path", "https://app.test/other#a", "https://app.test/other#a"],
    ["a different query", "https://app.test/page?x=2#a", "https://app.test/page?x=2#a"],
    ["a different path with no fragment", "https://app.test/other", "https://app.test/other"],
  ])("handles %s", async (_name, target, expected) => {
    const ctx = await setup();

    expect(ctx.mod.toDocumentLoadHref(target)).toBe(expected);
  });
});
