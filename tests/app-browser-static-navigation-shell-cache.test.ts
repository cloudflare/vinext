import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createStaticNavigationShellCache,
  restoreStaticNavigationShellResponse,
  type StaticNavigationShellFetchInit,
} from "../packages/vinext/src/server/app-browser-static-navigation-shell-cache.js";
import { VINEXT_RSC_COMPATIBILITY_ID_HEADER } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  RSC_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_PARAMS_HEADER,
  VINEXT_RSC_REDIRECT_HEADER,
  VINEXT_STATIC_NAVIGATION_SHELL_COMPLETE_HEADER,
  VINEXT_STATIC_NAVIGATION_SHELL_STALE_TIME_HEADER,
} from "../packages/vinext/src/server/headers.js";

type FetchCall = {
  init: StaticNavigationShellFetchInit;
  url: string;
};

type ShellResponseOptions = {
  body?: string;
  complete: boolean;
  compatibilityIdHeader?: string;
  mountedSlotsHeader?: string;
  params?: Record<string, string | string[]>;
  redirectTarget?: string;
  responseUrl?: string;
  staleTimeSeconds?: string;
  status?: number;
};

const DEFAULT_SHELL_RESPONSE_URL = "https://example.test/target.rsc?x=1&_rsc=shell";

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createShellResponse(options: ShellResponseOptions): Response {
  const headers = new Headers({ "content-type": "text/x-component" });
  headers.set(VINEXT_STATIC_NAVIGATION_SHELL_COMPLETE_HEADER, options.complete ? "1" : "0");
  if (options.compatibilityIdHeader !== undefined) {
    headers.set(VINEXT_RSC_COMPATIBILITY_ID_HEADER, options.compatibilityIdHeader);
  }
  if (options.staleTimeSeconds !== undefined) {
    headers.set(VINEXT_STATIC_NAVIGATION_SHELL_STALE_TIME_HEADER, options.staleTimeSeconds);
  }
  if (options.params !== undefined) {
    headers.set(VINEXT_PARAMS_HEADER, encodeURIComponent(JSON.stringify(options.params)));
  }
  if (options.mountedSlotsHeader !== undefined) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, options.mountedSlotsHeader);
  }
  if (options.redirectTarget !== undefined) {
    headers.set(VINEXT_RSC_REDIRECT_HEADER, options.redirectTarget);
  }
  const response = new Response(options.body ?? "shell", {
    headers,
    status: options.status ?? 200,
  });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: options.responseUrl ?? DEFAULT_SHELL_RESPONSE_URL,
  });
  return response;
}

function createTestCache(options: { maxEntries?: number; response: () => Response }): {
  calls: FetchCall[];
  cache: ReturnType<typeof createStaticNavigationShellCache>;
  setNow: (nextNow: number) => void;
} {
  let now = 1_000;
  const calls: FetchCall[] = [];
  return {
    calls,
    cache: createStaticNavigationShellCache({
      awaitSeedCompletion: true,
      fetchShell: async (url, init) => {
        const call = { init, url };
        calls.push(call);
        const response = options.response();
        if (response.url === DEFAULT_SHELL_RESPONSE_URL) {
          Object.defineProperty(response, "url", {
            configurable: true,
            value: `https://example.test${call.url}`,
          });
        }
        return response;
      },
      maxEntries: options.maxEntries ?? 3,
      now: () => now,
    }),
    setNow(nextNow) {
      now = nextNow;
    },
  };
}

function expectShellEntry<T>(entry: T | null): T {
  if (entry === null) {
    throw new Error("Expected static navigation shell cache entry");
  }
  return entry;
}

async function readFirstChunkText(response: Response): Promise<string> {
  if (response.body === null) {
    throw new Error("Expected response body");
  }
  const reader = response.body.getReader();
  try {
    const result = await reader.read();
    if (result.done) {
      throw new Error("Expected first response chunk");
    }
    return new TextDecoder().decode(result.value);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function waitOneTask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function storedSeedResult(stored: boolean) {
  return { kind: "stored", stored };
}

async function seed(cache: ReturnType<typeof createStaticNavigationShellCache>, rscUrl: string) {
  return cache.seed({
    href: "/target?x=1",
    interceptionContext: null,
    mountedSlotsHeader: null,
    origin: "https://example.test",
    rscUrl,
  });
}

describe("static navigation shell cache", () => {
  let previousCacheComponents: string | undefined;
  let previousCachedNavigations: string | undefined;
  let previousRscCompatibilityId: string | undefined;
  let previousStaticStaleTime: string | undefined;

  beforeEach(() => {
    previousCacheComponents = process.env.__NEXT_CACHE_COMPONENTS;
    previousCachedNavigations = process.env.__NEXT_CACHED_NAVIGATIONS;
    previousRscCompatibilityId = process.env.__VINEXT_RSC_COMPATIBILITY_ID;
    previousStaticStaleTime = process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME;

    process.env.__NEXT_CACHE_COMPONENTS = "true";
    process.env.__NEXT_CACHED_NAVIGATIONS = "true";
    delete process.env.__VINEXT_RSC_COMPATIBILITY_ID;
    delete process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME;
  });

  afterEach(() => {
    setEnv("__NEXT_CACHE_COMPONENTS", previousCacheComponents);
    setEnv("__NEXT_CACHED_NAVIGATIONS", previousCachedNavigations);
    setEnv("__VINEXT_RSC_COMPATIBILITY_ID", previousRscCompatibilityId);
    setEnv("__NEXT_CLIENT_ROUTER_STATIC_STALETIME", previousStaticStaleTime);
  });

  it("does not fetch or read shells when cached navigations are disabled", async () => {
    process.env.__NEXT_CACHED_NAVIGATIONS = "false";
    const { cache, calls } = createTestCache({
      response: () => createShellResponse({ complete: true }),
    });

    await expect(seed(cache, "/target?_rsc=disabled")).resolves.toEqual({ kind: "disabled" });

    expect(calls).toHaveLength(0);
    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=disabled",
      }),
    ).toBeNull();
  });

  it("stores a complete shell without an explicit stale header using the default stale time", async () => {
    process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME = "7";
    const { cache, calls, setNow } = createTestCache({
      response: () =>
        createShellResponse({
          body: "complete-shell",
          complete: true,
          params: { slug: "target" },
          responseUrl: "https://example.test/target.rsc?x=1&_rsc=shell",
        }),
    });

    await expect(seed(cache, "/target?_rsc=complete")).resolves.toEqual(storedSeedResult(true));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.startsWith("/target.rsc?x=1&")).toBe(true);
    expect(calls[0]?.init.credentials).toBe("include");
    expect(calls[0]?.init.headers.get(RSC_HEADER)).toBeNull();

    setNow(7_999);
    const fresh = expectShellEntry(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=complete",
      }),
    );
    expect(fresh.complete).toBe(true);
    expect(fresh.params).toEqual({ slug: "target" });
    await expect(restoreStaticNavigationShellResponse(fresh).text()).resolves.toBe(
      "complete-shell",
    );

    setNow(8_000);
    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=complete",
      }),
    ).toBeNull();
  });

  it("stores a partial shell only when the response provides an explicit stale header", async () => {
    const { cache, setNow } = createTestCache({
      response: () =>
        createShellResponse({
          body: "partial-shell",
          complete: false,
          mountedSlotsHeader: "children",
          params: { id: ["a", "b"] },
          staleTimeSeconds: "2",
        }),
    });

    await expect(seed(cache, "/target?_rsc=partial")).resolves.toEqual(storedSeedResult(true));

    setNow(2_999);
    const fresh = expectShellEntry(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=partial",
      }),
    );
    expect(fresh.complete).toBe(false);
    expect(fresh.params).toEqual({ id: ["a", "b"] });

    const restored = restoreStaticNavigationShellResponse(fresh);
    expect(restored.headers.get("content-type")).toBe("text/x-component");
    expect(restored.headers.get(VINEXT_MOUNTED_SLOTS_HEADER)).toBe("children");
    await expect(readFirstChunkText(restored)).resolves.toBe("partial-shell");

    setNow(3_000);
    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=partial",
      }),
    ).toBeNull();
  });

  it("does not store a partial shell without a valid stale header", async () => {
    const { cache } = createTestCache({
      response: () => createShellResponse({ complete: false, staleTimeSeconds: "not-a-number" }),
    });

    await expect(seed(cache, "/target?_rsc=invalid-stale")).resolves.toEqual(
      storedSeedResult(false),
    );

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=invalid-stale",
      }),
    ).toBeNull();
  });

  it("does not store an empty partial shell", async () => {
    const { cache } = createTestCache({
      response: () =>
        createShellResponse({
          body: "",
          complete: false,
          staleTimeSeconds: "5",
        }),
    });

    await expect(seed(cache, "/target?_rsc=empty-partial")).resolves.toEqual(
      storedSeedResult(false),
    );

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=empty-partial",
      }),
    ).toBeNull();
  });

  it("does not store a shell response that encodes a streamed redirect", async () => {
    const { cache } = createTestCache({
      response: () => createShellResponse({ complete: true, redirectTarget: "/redirected" }),
    });

    await expect(seed(cache, "/target?_rsc=redirect")).resolves.toEqual(storedSeedResult(false));

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=redirect",
      }),
    ).toBeNull();
  });

  it("does not store a shell response for a different canonical URL", async () => {
    const { cache } = createTestCache({
      response: () =>
        createShellResponse({
          complete: true,
          responseUrl: "https://example.test/redirected.rsc?x=1&_rsc=shell",
        }),
    });

    await expect(seed(cache, "/target?_rsc=canonical-mismatch")).resolves.toEqual(
      storedSeedResult(false),
    );

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=canonical-mismatch",
      }),
    ).toBeNull();
  });

  it("does not store a shell response without canonical URL information", async () => {
    const { cache } = createTestCache({
      response: () =>
        createShellResponse({
          complete: true,
          responseUrl: "",
        }),
    });

    await expect(seed(cache, "/target?_rsc=missing-canonical")).resolves.toEqual(
      storedSeedResult(false),
    );

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=missing-canonical",
      }),
    ).toBeNull();
  });

  it("evicts an entry when its compatibility id no longer matches the current client", async () => {
    process.env.__VINEXT_RSC_COMPATIBILITY_ID = "client-build-a";
    const { cache } = createTestCache({
      response: () =>
        createShellResponse({
          complete: true,
          compatibilityIdHeader: "client-build-b",
        }),
    });

    await expect(seed(cache, "/target?_rsc=incompatible")).resolves.toEqual(storedSeedResult(true));

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=incompatible",
      }),
    ).toBeNull();
  });

  it("does not wait for detached shell seed completion by default", async () => {
    let releaseResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const shellResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const cache = createStaticNavigationShellCache({
      fetchShell: async () => {
        markFetchStarted();
        return shellResponse;
      },
      maxEntries: 3,
      now: () => 1_000,
    });

    await expect(seed(cache, "/target?_rsc=detached")).resolves.toEqual({ kind: "scheduled" });
    await fetchStarted;
    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=detached",
      }),
    ).toBeNull();

    releaseResponse(createShellResponse({ body: "detached-shell", complete: true }));
    await waitOneTask();

    await expect(
      restoreStaticNavigationShellResponse(
        expectShellEntry(
          cache.read({
            interceptionContext: null,
            mountedSlotsHeader: null,
            rscUrl: "/target?_rsc=detached",
          }),
        ),
      ).text(),
    ).resolves.toBe("detached-shell");
  });

  it("deduplicates concurrent shell seeds for the same lookup", async () => {
    let releaseResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const shellResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const calls: FetchCall[] = [];
    const cache = createStaticNavigationShellCache({
      awaitSeedCompletion: true,
      fetchShell: async (url, init) => {
        calls.push({ init, url });
        markFetchStarted();
        return shellResponse;
      },
      maxEntries: 3,
      now: () => 1_000,
    });

    const firstSeed = seed(cache, "/target?_rsc=deduped");
    const secondSeed = seed(cache, "/target?_rsc=deduped");
    await fetchStarted;

    expect(calls).toHaveLength(1);

    releaseResponse(createShellResponse({ body: "deduped-shell", complete: true }));
    await expect(Promise.all([firstSeed, secondSeed])).resolves.toEqual([
      storedSeedResult(true),
      storedSeedResult(true),
    ]);
    await expect(
      restoreStaticNavigationShellResponse(
        expectShellEntry(
          cache.read({
            interceptionContext: null,
            mountedSlotsHeader: null,
            rscUrl: "/target?_rsc=deduped",
          }),
        ),
      ).text(),
    ).resolves.toBe("deduped-shell");
  });

  it("does not let a detached shell seed repopulate the cache after clear", async () => {
    let releaseResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const shellResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const cache = createStaticNavigationShellCache({
      fetchShell: async () => {
        markFetchStarted();
        return shellResponse;
      },
      maxEntries: 3,
      now: () => 1_000,
    });

    await expect(seed(cache, "/target?_rsc=stale-detached")).resolves.toEqual({
      kind: "scheduled",
    });
    await fetchStarted;
    cache.clear();

    releaseResponse(createShellResponse({ body: "stale-detached-shell", complete: true }));
    await waitOneTask();

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: null,
        rscUrl: "/target?_rsc=stale-detached",
      }),
    ).toBeNull();
  });

  it("evicts an entry when the mounted slot context no longer matches", async () => {
    const { cache } = createTestCache({
      response: () =>
        createShellResponse({
          complete: true,
        }),
    });

    await expect(
      cache.seed({
        href: "/target",
        interceptionContext: null,
        mountedSlotsHeader: "children",
        origin: "https://example.test",
        rscUrl: "/target?_rsc=slots",
      }),
    ).resolves.toEqual(storedSeedResult(true));

    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: "modal",
        rscUrl: "/target?_rsc=slots",
      }),
    ).toBeNull();
    expect(
      cache.read({
        interceptionContext: null,
        mountedSlotsHeader: "children",
        rscUrl: "/target?_rsc=slots",
      }),
    ).toBeNull();
  });

  it("keeps the most recently read entries when the cache reaches capacity", async () => {
    let responseId = "a";
    const { cache } = createTestCache({
      maxEntries: 2,
      response: () =>
        createShellResponse({
          body: responseId,
          complete: true,
        }),
    });

    await expect(seed(cache, "/a?_rsc=a")).resolves.toEqual(storedSeedResult(true));
    responseId = "b";
    await expect(seed(cache, "/b?_rsc=b")).resolves.toEqual(storedSeedResult(true));
    expect(
      cache.read({ interceptionContext: null, mountedSlotsHeader: null, rscUrl: "/a?_rsc=a" }),
    ).not.toBeNull();

    responseId = "c";
    await expect(seed(cache, "/c?_rsc=c")).resolves.toEqual(storedSeedResult(true));

    expect(
      cache.read({ interceptionContext: null, mountedSlotsHeader: null, rscUrl: "/b?_rsc=b" }),
    ).toBeNull();
    await expect(
      restoreStaticNavigationShellResponse(
        expectShellEntry(
          cache.read({ interceptionContext: null, mountedSlotsHeader: null, rscUrl: "/a?_rsc=a" }),
        ),
      ).text(),
    ).resolves.toBe("a");
    await expect(
      restoreStaticNavigationShellResponse(
        expectShellEntry(
          cache.read({ interceptionContext: null, mountedSlotsHeader: null, rscUrl: "/c?_rsc=c" }),
        ),
      ).text(),
    ).resolves.toBe("c");
  });
});
