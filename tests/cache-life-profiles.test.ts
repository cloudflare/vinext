import { describe, expect, it } from "vite-plus/test";
import {
  createDefaultCacheLifeProfiles,
  resolveCacheLifeProfiles,
} from "../packages/vinext/src/utils/cache-life-profiles.js";

describe("cache life profiles", () => {
  it("preserves the existing built-in durations when no profiles are configured", () => {
    const expected = {
      default: { revalidate: 900, expire: 4294967294 },
      seconds: { stale: 30, revalidate: 1, expire: 60 },
      minutes: { stale: 300, revalidate: 60, expire: 3600 },
      hours: { stale: 300, revalidate: 3600, expire: 86400 },
      days: { stale: 300, revalidate: 86400, expire: 604800 },
      weeks: { stale: 300, revalidate: 604800, expire: 2592000 },
      max: { stale: 300, revalidate: 2592000, expire: 31536000 },
    };

    expect(createDefaultCacheLifeProfiles()).toStrictEqual(expected);
    expect(resolveCacheLifeProfiles()).toStrictEqual(expected);
    expect(resolveCacheLifeProfiles({})).toStrictEqual(expected);
  });

  it("adds custom profiles without changing the built-in profiles", () => {
    const blog = { stale: 60, revalidate: 300, expire: 3600 };

    expect(resolveCacheLifeProfiles({ blog })).toStrictEqual({
      ...createDefaultCacheLifeProfiles(),
      blog,
    });
  });

  it("replaces a named built-in profile without inheriting its old fields", () => {
    expect(resolveCacheLifeProfiles({ hours: { expire: 60 } }).hours).toStrictEqual({
      expire: 60,
    });
  });

  it("leaves omitted custom profile fields for the cache scope to inherit", () => {
    expect(resolveCacheLifeProfiles({ blog: { expire: 60 }, empty: {} }).blog).toStrictEqual({
      expire: 60,
    });
    expect(resolveCacheLifeProfiles({ empty: {} }).empty).toStrictEqual({});
  });

  // Next.js config resolves default-profile fields after validating user input:
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/packages/next/src/server/config.ts#L1441
  it("fills omitted fields when the default profile is overridden", () => {
    expect(resolveCacheLifeProfiles({ default: {} }).default).toStrictEqual({
      stale: 300,
      revalidate: 900,
      expire: 4294967294,
    });
    expect(
      resolveCacheLifeProfiles(
        { default: { revalidate: 10 } },
        { defaultStale: 120, defaultExpire: 31536000 },
      ).default,
    ).toStrictEqual({ stale: 120, revalidate: 10, expire: 31536000 });
  });

  it("preserves explicitly configured zero values when filling the default profile", () => {
    expect(
      resolveCacheLifeProfiles(
        { default: { stale: 0, revalidate: 0, expire: 0 } },
        { defaultStale: 120, defaultExpire: 3600 },
      ).default,
    ).toStrictEqual({ stale: 0, revalidate: 0, expire: 0 });
  });

  // Configuration case from Next.js: test/e2e/app-dir/use-cache-default-profile-expire-zero
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache-default-profile-expire-zero/use-cache-default-profile-expire-zero.test.ts
  it("validates only user-supplied fields before backfilling the default profile", () => {
    expect(resolveCacheLifeProfiles({ default: { expire: 0 } }).default).toStrictEqual({
      stale: 300,
      revalidate: 900,
      expire: 0,
    });
  });

  it("fills explicitly undefined default-profile fields", () => {
    expect(
      resolveCacheLifeProfiles({ default: { stale: undefined, expire: undefined } }).default,
    ).toStrictEqual({ stale: 300, revalidate: 900, expire: 4294967294 });
  });

  it("does not apply fallback options to unconfigured default profiles", () => {
    const profiles = resolveCacheLifeProfiles(
      { blog: { expire: 60 } },
      { defaultStale: 120, defaultExpire: 3600 },
    );
    expect(profiles.default).toStrictEqual(createDefaultCacheLifeProfiles().default);
  });

  it("does not mutate configured profiles or share them between resolutions", () => {
    const blog = Object.freeze({ stale: Infinity, revalidate: 300, expire: Infinity });
    const defaultProfile = Object.freeze({ expire: 60 });
    const input = Object.freeze({ blog, default: defaultProfile });
    const first = resolveCacheLifeProfiles(input);
    const second = resolveCacheLifeProfiles(input);

    first.blog.expire = 1;
    first.default.revalidate = 1;
    first.hours.expire = 1;

    expect(input.blog).toStrictEqual({ stale: Infinity, revalidate: 300, expire: Infinity });
    expect(input.default).toStrictEqual({ expire: 60 });
    expect(second.blog).toStrictEqual({ stale: 4294967294, revalidate: 300, expire: 4294967294 });
    expect(second.default).toStrictEqual({ stale: 300, revalidate: 900, expire: 60 });
    expect(second.hours.expire).toBe(86400);
    expect(createDefaultCacheLifeProfiles().hours.expire).toBe(86400);
  });

  it("creates independent copies of the built-in profiles", () => {
    const first = createDefaultCacheLifeProfiles();
    const second = createDefaultCacheLifeProfiles();
    first.default.expire = 0;

    expect(second.default.expire).toBe(4294967294);
    expect(createDefaultCacheLifeProfiles().default.expire).toBe(4294967294);
  });

  // Ported from Next.js: test/e2e/app-dir/use-cache/use-cache.test.ts
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache/use-cache.test.ts
  it("preserves the custom frequent and expireNow profiles from the Next.js fixture", () => {
    const input = {
      frequent: { stale: 30, revalidate: 100, expire: 300 },
      expireNow: { stale: 0, revalidate: 0, expire: 0 },
    };
    const profiles = resolveCacheLifeProfiles(input);

    expect(profiles.frequent).toStrictEqual(input.frequent);
    expect(profiles.expireNow).toStrictEqual(input.expireNow);
  });

  // The following validation cases follow Next.js's profile normalizer:
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/packages/next/src/server/use-cache/cache-life-profile.ts
  // JSON serialization case from Next.js: test/e2e/app-dir/use-cache-infinity-profile
  // https://github.com/vercel/next.js/blob/f464e32ec092c5a00c967e64cba40121a2992224/test/e2e/app-dir/use-cache-infinity-profile/use-cache-infinity-profile.test.ts
  it("normalizes Infinity before profiles are serialized", () => {
    const profiles = resolveCacheLifeProfiles({
      forever: { stale: Infinity, revalidate: Infinity, expire: Infinity },
    });

    expect(profiles.forever).toStrictEqual({
      stale: 4294967294,
      revalidate: 4294967294,
      expire: 4294967294,
    });
    expect(JSON.parse(JSON.stringify(profiles)).forever).toStrictEqual(profiles.forever);
  });

  it("accepts equal revalidation and expiration times", () => {
    expect(resolveCacheLifeProfiles({ blog: { revalidate: 60, expire: 60 } }).blog).toStrictEqual({
      revalidate: 60,
      expire: 60,
    });
  });

  it("accepts finite negative and fractional values like the upstream normalizer", () => {
    const blog = { stale: -2.5, revalidate: -2, expire: -1 };
    expect(resolveCacheLifeProfiles({ blog }).blog).toStrictEqual(blog);
  });

  it("rejects revalidation times greater than expiration times", () => {
    expect(() => resolveCacheLifeProfiles({ blog: { revalidate: 61, expire: 60 } })).toThrow(
      "expire option must be greater than the revalidate option",
    );
    expect(() => resolveCacheLifeProfiles({ blog: { revalidate: Infinity, expire: 60 } })).toThrow(
      "expire option must be greater than the revalidate option",
    );
  });

  it.each([null, [], true, 60, "blog"])("rejects an invalid profile map: %j", (input) => {
    expect(() => resolveCacheLifeProfiles(input)).toThrow('Invalid "cacheLife"');
  });

  it.each([null, [], true, 60, "blog", undefined])(
    "rejects an invalid named profile: %j",
    (blog) => {
      expect(() => resolveCacheLifeProfiles({ blog })).toThrow('Invalid "cacheLife.blog"');
    },
  );

  describe.each(["stale", "revalidate", "expire"])("%s", (field) => {
    it.each([null, true, "60", {}, [], NaN, -Infinity])("rejects an invalid value: %j", (value) => {
      expect(() => resolveCacheLifeProfiles({ blog: { [field]: value } })).toThrow();
    });

    it("rejects false and recommends Infinity", () => {
      expect(() => resolveCacheLifeProfiles({ blog: { [field]: false } })).toThrow(
        "Pass `Infinity` instead of `false`",
      );
    });
  });

  it("includes the configured field in non-finite value errors", () => {
    expect(() => resolveCacheLifeProfiles({ blog: { revalidate: NaN } })).toThrow(
      'Invalid "cacheLife.blog.revalidate"',
    );
  });

  it("preserves profile names that also occur on Object.prototype", () => {
    const input = JSON.parse('{"__proto__":{"expire":60},"constructor":{"expire":120}}');
    const profiles = resolveCacheLifeProfiles(input);

    expect(Object.hasOwn(profiles, "__proto__")).toBe(true);
    expect(profiles["__proto__"]).toStrictEqual({ expire: 60 });
    expect(profiles["constructor"]).toStrictEqual({ expire: 120 });
    expect(Object.getPrototypeOf(profiles)).toBe(Object.prototype);
  });
});
