import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import {
  BUILT_IN_CACHE_LIFE_PROFILES,
  parseCacheLifeProfiles,
  resolveCacheLifeProfiles,
  serializeCacheLifeProfiles,
} from "../packages/vinext/src/utils/cache-life-profiles.js";

const EXPIRE_TIME = 31_536_000;

describe("resolveCacheLifeProfiles", () => {
  it("keeps the built-in profiles when cacheLife is not configured", () => {
    expect(resolveCacheLifeProfiles(undefined, EXPIRE_TIME, vi.fn())).toEqual(
      BUILT_IN_CACHE_LIFE_PROFILES,
    );
  });

  it("adds custom profiles next to the built-ins, keeping their gaps", () => {
    const profiles = resolveCacheLifeProfiles(
      { blog: { stale: 120, revalidate: 600 } },
      EXPIRE_TIME,
      vi.fn(),
    );
    expect(profiles.blog).toEqual({ stale: 120, revalidate: 600 });
    expect(profiles.hours).toEqual(BUILT_IN_CACHE_LIFE_PROFILES.hours);
  });

  it("replaces an overridden built-in whole, not field by field", () => {
    const profiles = resolveCacheLifeProfiles({ hours: { revalidate: 10 } }, EXPIRE_TIME, vi.fn());
    expect(profiles.hours).toEqual({ revalidate: 10 });
  });

  it("fills a configured default's missing revalidate and expire (expire from expireTime)", () => {
    expect(resolveCacheLifeProfiles({ default: {} }, 1234, vi.fn()).default).toEqual({
      revalidate: 900,
      expire: 1234,
    });
    expect(
      resolveCacheLifeProfiles({ default: { stale: 5, revalidate: 30 } }, 1234, vi.fn()).default,
    ).toEqual({ stale: 5, revalidate: 30, expire: 1234 });
  });

  it("warns about and drops values that are not numbers", () => {
    const warn = vi.fn();
    const profiles = resolveCacheLifeProfiles(
      { blog: { revalidate: "60", expire: 600 }, broken: 5 },
      EXPIRE_TIME,
      warn,
    );
    expect(profiles.blog).toEqual({ expire: 600 });
    expect(profiles).not.toHaveProperty("broken");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("`cacheLife.blog.revalidate`"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("`cacheLife.broken`"));
  });

  it("round-trips Infinity through the define", () => {
    const profiles = resolveCacheLifeProfiles(
      { forever: { stale: Infinity, revalidate: Infinity, expire: Infinity } },
      EXPIRE_TIME,
      vi.fn(),
    );
    expect(parseCacheLifeProfiles(serializeCacheLifeProfiles(profiles))).toEqual(profiles);
  });
});

describe("resolveNextConfig cacheLife", () => {
  it("reads top-level cacheLife", async () => {
    const resolved = await resolveNextConfig({ cacheLife: { blog: { revalidate: 60 } } });
    expect(resolved.cacheLife.blog).toEqual({ revalidate: 60 });
    expect(resolved.cacheLife.default).toEqual(BUILT_IN_CACHE_LIFE_PROFILES.default);
  });

  it("lets a legacy experimental.cacheLife replace the top-level key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveNextConfig({
      cacheLife: { top: { revalidate: 1 } },
      experimental: { cacheLife: { legacy: { revalidate: 2 } } },
    });
    expect(resolved.cacheLife.legacy).toEqual({ revalidate: 2 });
    expect(resolved.cacheLife).not.toHaveProperty("top");
    warn.mockRestore();
  });

  it("fills a configured default's expire from expireTime", async () => {
    const resolved = await resolveNextConfig({
      expireTime: 7200,
      cacheLife: { default: { revalidate: 60 } },
    });
    expect(resolved.cacheLife.default).toEqual({ revalidate: 60, expire: 7200 });
  });
});

describe("cacheLife() with configured profiles", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function importShimsWithProfiles(userProfiles: Record<string, unknown>) {
    vi.stubEnv(
      "__VINEXT_CACHE_LIFE_PROFILES",
      serializeCacheLifeProfiles(resolveCacheLifeProfiles(userProfiles, EXPIRE_TIME, vi.fn())),
    );
    vi.resetModules();
    const cache = await import("../packages/vinext/src/shims/cache.js");
    const runtime = await import("../packages/vinext/src/shims/cache-runtime.js");
    return { ...cache, ...runtime };
  }

  it("stores a custom profile's revalidate and expire on the use cache entry", async () => {
    const { MemoryCacheHandler, cacheLife, registerCachedFunction, setCacheHandler } =
      await importShimsWithProfiles({ blog: { stale: 45, revalidate: 120, expire: 3600 } });
    const handler = new MemoryCacheHandler();
    setCacheHandler(handler);
    const set = vi.spyOn(handler, "set");

    await registerCachedFunction(async () => {
      cacheLife("blog");
      return "post";
    }, "test:custom-profile")();

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1]).toMatchObject({ revalidate: 120 });
    expect(set.mock.calls[0][2]).toMatchObject({
      cacheControl: { stale: 45, revalidate: 120, expire: 3600 },
    });
  });

  it("fills a partial custom profile's stored lifetime from the default profile", async () => {
    const { MemoryCacheHandler, cacheLife, registerCachedFunction, setCacheHandler } =
      await importShimsWithProfiles({
        default: { stale: 20, revalidate: 300, expire: 7200 },
        blog: { revalidate: 60 },
      });
    const handler = new MemoryCacheHandler();
    setCacheHandler(handler);
    const set = vi.spyOn(handler, "set");

    await registerCachedFunction(async () => {
      cacheLife("blog");
      return "post";
    }, "test:partial-custom-profile")();

    expect(set.mock.calls[0][2]).toMatchObject({
      cacheControl: { stale: 20, revalidate: 60, expire: 7200 },
    });
  });

  it("uses an overridden built-in instead of the built-in values", async () => {
    const { cacheLife, _consumeRequestScopedCacheLife, _runWithCacheState } =
      await importShimsWithProfiles({ hours: { stale: 1, revalidate: 2, expire: 3 } });

    await _runWithCacheState(async () => {
      cacheLife("hours");
      expect(_consumeRequestScopedCacheLife()).toEqual({ stale: 1, revalidate: 2, expire: 3 });
    });
  });

  // Ported from Next.js: packages/next/src/server/use-cache/cache-life.ts
  it("throws for a profile that is not configured", async () => {
    const { cacheLife } = await importShimsWithProfiles({ blog: { revalidate: 60 } });

    expect(() => cacheLife("nonexistent-profile")).toThrow(
      'Unknown `cacheLife()` profile "nonexistent-profile" is not configured in next.config.js\n' +
        "module.exports = {\n" +
        "  cacheLife: {\n" +
        '    "nonexistent-profile": ...\n' +
        "  }\n" +
        "}",
    );
    expect(() => cacheLife(" blog ")).toThrow(
      'Unknown `cacheLife()` profile " blog " is not configured in next.config.js\n' +
        'Did you mean "blog" without the spaces?',
    );
    // Object prototype keys are not profiles.
    expect(() => cacheLife("toString")).toThrow("Unknown `cacheLife()` profile");
  });
});
