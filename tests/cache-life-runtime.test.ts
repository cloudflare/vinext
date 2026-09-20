import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  _consumeRequestScopedCacheLife,
  _drainPendingRevalidations,
  _peekRequestScopedCacheLife,
  _runWithCacheState,
  cacheLife,
  cacheLifeProfiles,
  MemoryCacheHandler,
  revalidateTag,
  setCacheHandler,
  unstable_cacheLife,
} from "../packages/vinext/src/shims/cache.js";
import {
  getCacheContext,
  registerCachedFunction,
  runWithPrivateCache,
} from "../packages/vinext/src/shims/cache-runtime.js";

// Supply the resolved table at module initialization. Actual Vite injection is
// covered separately in cache-life-config.test.ts; no profile setter is used.
vi.mock("../packages/vinext/src/utils/cache-life-profiles.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../packages/vinext/src/utils/cache-life-profiles.js")>();
  return {
    ...original,
    createDefaultCacheLifeProfiles: () =>
      original.resolveCacheLifeProfiles({
        default: { stale: 90, revalidate: 30, expire: 7200 },
        blog: { stale: 60, revalidate: 300, expire: 3600 },
        seconds: { stale: 5, revalidate: 10, expire: 60 },
        hours: { expire: 120 },
        revalidateOnly: { revalidate: 300 },
        staleOnly: { stale: 15 },
        expireOnly: { expire: 600 },
        empty: {},
        undefinedFields: { stale: undefined, revalidate: undefined, expire: 600 },
        expireNow: { expire: 0 },
        frozen: { stale: Infinity, revalidate: Infinity, expire: Infinity },
        ["__proto__"]: { expire: 900 },
      }),
  };
});

describe("configured cacheLife consumers", () => {
  let handler: MemoryCacheHandler;

  beforeEach(() => {
    handler = new MemoryCacheHandler();
    setCacheHandler(handler);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setCacheHandler(new MemoryCacheHandler());
  });

  // Adapted from Next.js's custom profile metadata assertions:
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache/use-cache.test.ts
  it.each(["", "remote"])("writes all three custom durations for variant %j", async (variant) => {
    const write = vi.spyOn(handler, "set");
    const cached = registerCachedFunction(
      async () => {
        cacheLife("blog");
        return "blog";
      },
      `configured:${variant}`,
      variant,
    );

    await _runWithCacheState(async () => {
      expect(await cached()).toBe("blog");
      expect(_peekRequestScopedCacheLife()).toEqual(cacheLifeProfiles.blog);
    });
    expect(write).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "FETCH", revalidate: 300 }),
      expect.objectContaining({ cacheControl: cacheLifeProfiles.blog }),
    );
  });

  it.each([
    ["seconds", { stale: 5, revalidate: 10, expire: 60 }],
    ["hours", { stale: 90, revalidate: 30, expire: 120 }],
    ["revalidateOnly", { stale: 90, revalidate: 300, expire: 7200 }],
    ["staleOnly", { stale: 15, revalidate: 30, expire: 7200 }],
    ["empty", { stale: 90, revalidate: 30, expire: 7200 }],
    ["undefinedFields", { stale: 90, revalidate: 30, expire: 600 }],
    ["__proto__", { stale: 90, revalidate: 30, expire: 900 }],
    ["expireNow", { stale: 90, revalidate: 30, expire: 0 }],
    ["frozen", { stale: 4294967294, revalidate: 4294967294, expire: 4294967294 }],
  ] as const)(
    "consumes %s using the configured default for omitted fields",
    async (profile, expected) => {
      const write = vi.spyOn(handler, "set");
      const cached = registerCachedFunction(async () => {
        cacheLife(profile);
        return profile;
      }, `configured:${profile}`);
      await _runWithCacheState(async () => {
        await cached();
        expect(_peekRequestScopedCacheLife()).toEqual(expected);
      });
      expect(write.mock.calls[0][2]).toEqual(expect.objectContaining({ cacheControl: expected }));
    },
  );

  it("uses the configured default without a cacheLife call", async () => {
    const write = vi.spyOn(handler, "set");
    const cached = registerCachedFunction(async () => "default", "configured:default");
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual(cacheLifeProfiles.default);
    });
    expect(write.mock.calls[0][2]).toEqual(
      expect.objectContaining({ cacheControl: cacheLifeProfiles.default }),
    );
  });

  it("retains inline object inheritance from the configured default", async () => {
    const cached = registerCachedFunction(async () => {
      cacheLife({ expire: 600 });
      return "inline";
    }, "configured:inline");
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual({ stale: 90, revalidate: 30, expire: 600 });
    });
  });

  it("resolves configured profiles through the deprecated alias", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const cached = registerCachedFunction(async () => {
      unstable_cacheLife("blog");
      return "alias";
    }, "configured:alias");
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual(cacheLifeProfiles.blog);
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("unstable_cacheLife"),
      }),
    );
  });

  it("takes the minimum across repeated calls before inheriting omitted fields", async () => {
    const write = vi.spyOn(handler, "set");
    const cached = registerCachedFunction(async () => {
      cacheLife("expireOnly");
      expect(getCacheContext()?.hasExplicitRevalidate).toBe(false);
      expect(getCacheContext()?.hasExplicitExpire).toBe(true);
      cacheLife("revalidateOnly");
      cacheLife("staleOnly");
      return "combined";
    }, "configured:combined");
    const expected = { stale: 15, revalidate: 300, expire: 600 };
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual(expected);
    });
    expect(write.mock.calls[0][2]).toEqual(expect.objectContaining({ cacheControl: expected }));
    expect(cacheLifeProfiles.expireOnly).toEqual({ expire: 600 });
  });

  it("takes the shortest value in each field across full profiles", async () => {
    const cached = registerCachedFunction(async () => {
      cacheLife("blog");
      cacheLife("seconds");
      return "minimum";
    }, "configured:minimum");
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual(cacheLifeProfiles.seconds);
    });
  });

  it("inherits the configured default for named calls outside a runtime wrapper", async () => {
    await _runWithCacheState(() => {
      cacheLife("hours");
      expect(_peekRequestScopedCacheLife()).toEqual({ stale: 90, revalidate: 30, expire: 120 });
    });
  });

  it("replays inherited durations on a partial profile's shared hit", async () => {
    const fn = vi.fn(async () => {
      cacheLife("hours");
      return "partial";
    });
    const cached = registerCachedFunction(fn, "configured:partial-hit");
    const expected = { stale: 90, revalidate: 30, expire: 120 };
    await _runWithCacheState(async () => {
      await cached();
      expect(_consumeRequestScopedCacheLife()).toEqual(expected);
    });
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual(expected);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("replays all custom durations on a shared hit and a nested shared hit", async () => {
    const fn = vi.fn(async () => {
      cacheLife("blog");
      return "warm";
    });
    const inner = registerCachedFunction(fn, "configured:warm");
    await _runWithCacheState(() => inner());
    await _runWithCacheState(async () => {
      await inner();
      expect(_peekRequestScopedCacheLife()).toEqual(cacheLifeProfiles.blog);
    });
    const write = vi.spyOn(handler, "set");
    const outer = registerCachedFunction(async () => inner(), "configured:outer");
    await _runWithCacheState(async () => {
      await outer();
      expect(_peekRequestScopedCacheLife()).toEqual(cacheLifeProfiles.blog);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][2]).toEqual(
      expect.objectContaining({ cacheControl: cacheLifeProfiles.blog }),
    );
  });

  // Related Next.js private cache coverage:
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache-private/use-cache-private.test.ts
  it("replays a private hit's durations into the request and enclosing private cache", async () => {
    const write = vi.spyOn(handler, "set");
    const fn = vi.fn(async () => {
      cacheLife("blog");
      return "private";
    });
    const inner = registerCachedFunction(fn, "configured:private-inner", "private");
    const outer = registerCachedFunction(
      async () => inner(),
      "configured:private-outer",
      "private",
    );
    await runWithPrivateCache(() =>
      _runWithCacheState(async () => {
        await inner();
        expect(_consumeRequestScopedCacheLife()).toEqual(cacheLifeProfiles.blog);
        await inner();
        expect(_consumeRequestScopedCacheLife()).toEqual(cacheLifeProfiles.blog);
        await outer();
        expect(_consumeRequestScopedCacheLife()).toEqual(cacheLifeProfiles.blog);
      }),
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    await runWithPrivateCache(() => _runWithCacheState(() => inner()));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fills partial profiles during development execution", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const write = vi.spyOn(handler, "set");
    const cached = registerCachedFunction(async () => {
      cacheLife("hours");
      return "dev";
    }, "configured:dev");
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual({ stale: 90, revalidate: 30, expire: 120 });
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not mark inherited revalidate as explicit for a partial named profile", async () => {
    vi.stubEnv("VINEXT_PRERENDER", "1");
    const inner = registerCachedFunction(async () => {
      cacheLife({ revalidate: 0 });
      return "dynamic";
    }, "configured:dynamic");
    const outer = registerCachedFunction(async () => {
      cacheLife("expireOnly");
      return inner();
    }, "configured:partial-outer");
    await expect(_runWithCacheState(() => outer())).rejects.toThrow(/zero `revalidate`/);
  });

  it("does not mark inherited expire as explicit for a partial named profile", async () => {
    vi.stubEnv("VINEXT_PRERENDER", "1");
    const inner = registerCachedFunction(async () => {
      cacheLife("hours");
      return "short-lived";
    }, "configured:short-lived");
    const outer = registerCachedFunction(async () => {
      cacheLife("revalidateOnly");
      expect(getCacheContext()?.hasExplicitRevalidate).toBe(true);
      expect(getCacheContext()?.hasExplicitExpire).toBe(false);
      return inner();
    }, "configured:no-explicit-expire");
    await expect(_runWithCacheState(() => outer())).rejects.toThrow(/short `expire`/);
  });

  it("keeps unknown named profile warnings and uses the configured default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cached = registerCachedFunction(async () => {
      cacheLife("not-configured");
      return "unknown";
    }, "configured:unknown");
    await _runWithCacheState(async () => {
      await cached();
      expect(_peekRequestScopedCacheLife()).toEqual(cacheLifeProfiles.default);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown profile "not-configured"'));
  });

  it.each([
    ["blog", 3600],
    ["seconds", 60],
    ["hours", 120],
    ["revalidateOnly", 7200],
    ["expireNow", 0],
    ["__proto__", 900],
  ] as const)("passes %s's expiration to tag revalidation", async (profile, expire) => {
    const revalidate = vi.spyOn(handler, "revalidateTag");
    await _runWithCacheState(async () => {
      revalidateTag("blog-tag", profile);
      await _drainPendingRevalidations();
    });
    expect(revalidate).toHaveBeenCalledWith("blog-tag", { expire });
  });
});
