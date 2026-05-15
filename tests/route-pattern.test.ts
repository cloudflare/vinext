import { describe, expect, it } from "vite-plus/test";
import {
  fillRoutePatternSegments,
  matchRoutePattern,
  normalizeStaticPathname,
  normalizeStaticPathsEntry,
  routePattern,
  routePatternParts,
} from "../packages/vinext/src/routing/route-pattern.js";

describe("route pattern helpers", () => {
  it("normalizes app route segments into vinext pattern parts", () => {
    expect(routePatternParts("/docs/[section]/[[...slug]]/icon")).toEqual([
      "docs",
      ":section",
      ":slug*",
      "icon",
    ]);
    expect(routePattern("/shop/[...slug]/opengraph-image")).toBe("/shop/:slug+/opengraph-image");
    expect(routePattern("/")).toBe("");
  });

  it("fills dynamic route segments from params and rejects incomplete paths", () => {
    expect(
      fillRoutePatternSegments("/docs/[section]/[[...slug]]/icon", {
        section: "api",
      }),
    ).toBe("/docs/api/icon");
    expect(
      fillRoutePatternSegments("/docs/[section]/[[...slug]]/icon", {
        section: "api",
        slug: ["routing", "metadata"],
      }),
    ).toBe("/docs/api/routing/metadata/icon");
    expect(fillRoutePatternSegments("/docs/[...slug]/icon", {})).toBeNull();
    expect(fillRoutePatternSegments("/docs/[section]/icon", { section: ["a", "b"] })).toBeNull();
  });

  it("matches dynamic pattern parts with catch-all segments before suffixes", () => {
    expect(
      matchRoutePattern(
        ["metadata-multi-catchall", "a", "b", "icon"],
        ["metadata-multi-catchall", ":slug+", "icon"],
      ),
    ).toEqual({ slug: ["a", "b"] });
    expect(matchRoutePattern(["shop"], ["shop", ":slug*"])).toEqual({});
    expect(
      matchRoutePattern(
        ["metadata-multi-catchall", "icon"],
        ["metadata-multi-catchall", ":slug+", "icon"],
      ),
    ).toBeNull();
  });

  it("stores prototype-named params as own values", () => {
    const singleParam = matchRoutePattern(["first"], [":__proto__"]);

    expect(Object.hasOwn(singleParam ?? {}, "__proto__")).toBe(true);
    expect(singleParam?.__proto__).toBe("first");

    const catchAllParam = matchRoutePattern(["first", "second", "icon"], [":__proto__+", "icon"]);

    expect(Object.hasOwn(catchAllParam ?? {}, "__proto__")).toBe(true);
    expect(catchAllParam?.__proto__).toEqual(["first", "second"]);
  });

  it("treats literal route segments ending in pattern markers as literals", () => {
    expect(matchRoutePattern(["docs+", "icon"], ["docs+", "icon"])).toEqual({});
    expect(matchRoutePattern(["docs", "icon"], ["docs+", "icon"])).toBeNull();
  });
});

// Ported from Next.js: route-matcher.ts decodeURIComponent behaviour
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-matcher.ts#L25-L27
describe("matchRoutePattern param decoding", () => {
  it("decodes %2F, %23, %3F in dynamic segment params without splitting segments", () => {
    expect(matchRoutePattern(["files", "a%2Fb"], ["files", ":name"])).toEqual({ name: "a/b" });
    expect(matchRoutePattern(["files", "a%23b"], ["files", ":name"])).toEqual({ name: "a#b" });
    expect(matchRoutePattern(["files", "a%3Fb"], ["files", ":name"])).toEqual({ name: "a?b" });
  });

  it("decodes each element of catch-all and optional catch-all arrays individually", () => {
    expect(matchRoutePattern(["docs", "a%2Fb", "c%23d"], ["docs", ":rest+"])).toEqual({
      rest: ["a/b", "c#d"],
    });

    expect(matchRoutePattern(["docs", "a%2Fb", "c%23d"], ["docs", ":rest*"])).toEqual({
      rest: ["a/b", "c#d"],
    });
  });

  it("preserves malformed percent escapes without throwing", () => {
    expect(matchRoutePattern(["files", "a%GGb"], ["files", ":name"])).toEqual({ name: "a%GGb" });
  });

  it("applies exactly one decodeURIComponent pass (double-encoded stays single-encoded)", () => {
    expect(matchRoutePattern(["files", "a%252Fb"], ["files", ":name"])).toEqual({ name: "a%2Fb" });
  });
});

// Helper extracted from packages/vinext/src/build/prerender.ts,
// packages/vinext/src/server/pages-page-data.ts, and
// packages/vinext/src/server/dev-server.ts (originally added in PR #1227).
// Mirrors .nextjs-ref/packages/next/src/build/static-paths/pages.ts.
describe("normalizeStaticPathname", () => {
  it("strips query string", () => {
    expect(normalizeStaticPathname("/blog/hello?utm=x")).toBe("/blog/hello");
  });

  it("strips a single trailing slash on non-root paths", () => {
    expect(normalizeStaticPathname("/blog/hello/")).toBe("/blog/hello");
  });

  it("preserves the root path", () => {
    expect(normalizeStaticPathname("/")).toBe("/");
  });

  it("leaves a path without a trailing slash unchanged", () => {
    expect(normalizeStaticPathname("/blog/hello")).toBe("/blog/hello");
  });
});

describe("normalizeStaticPathsEntry", () => {
  it("matches a string entry against a single-segment dynamic pattern", () => {
    expect(normalizeStaticPathsEntry("/blog/hello", "/blog/:slug")).toEqual({
      params: { slug: "hello" },
    });
  });

  it("strips query string and trailing slash from a string entry", () => {
    expect(normalizeStaticPathsEntry("/blog/hello/?ref=x", "/blog/:slug")).toEqual({
      params: { slug: "hello" },
    });
  });

  it("matches a string entry against a required catch-all pattern", () => {
    expect(normalizeStaticPathsEntry("/docs/a/b/c", "/docs/:slug+")).toEqual({
      params: { slug: ["a", "b", "c"] },
    });
  });

  it("matches a string entry against an optional catch-all pattern", () => {
    expect(normalizeStaticPathsEntry("/docs", "/docs/:slug*")).toEqual({
      params: {},
    });
    expect(normalizeStaticPathsEntry("/docs/a/b", "/docs/:slug*")).toEqual({
      params: { slug: ["a", "b"] },
    });
  });

  it("returns an error when a string entry does not match the route pattern", () => {
    const result = normalizeStaticPathsEntry("/posts/hello", "/blog/:slug");
    expect(result).toMatchObject({ error: expect.stringMatching(/does not match/) });
  });

  it("passes an object entry's params through unchanged", () => {
    const params = { slug: "hello" };
    expect(normalizeStaticPathsEntry({ params }, "/blog/:slug")).toEqual({ params });
  });

  it("passes a catch-all array params object through unchanged", () => {
    const params = { slug: ["a", "b"] };
    expect(normalizeStaticPathsEntry({ params }, "/docs/:slug+")).toEqual({ params });
  });

  it("returns an error when an object entry has no params key", () => {
    const result = normalizeStaticPathsEntry({}, "/blog/:slug");
    expect(result).toMatchObject({ error: expect.stringMatching(/missing the `params` key/) });
  });

  it("returns an error when an object entry has explicit null params", () => {
    const result = normalizeStaticPathsEntry(
      { params: null } as unknown as { params?: Record<string, string | string[]> },
      "/blog/:slug",
    );
    expect(result).toMatchObject({ error: expect.stringMatching(/missing the `params` key/) });
  });

  it("returns an error when the entry is null or undefined", () => {
    expect(normalizeStaticPathsEntry(null, "/blog/:slug")).toMatchObject({
      error: expect.stringMatching(/null entry/),
    });
    expect(normalizeStaticPathsEntry(undefined, "/blog/:slug")).toMatchObject({
      error: expect.stringMatching(/undefined entry/),
    });
  });

  it("returns an error for a non-string, non-object entry", () => {
    const result = normalizeStaticPathsEntry(42 as unknown as string, "/blog/:slug");
    expect(result).toMatchObject({ error: expect.stringMatching(/must be a string or an object/) });
  });

  it("decodes percent-encoded segments when matching a string entry", () => {
    // Mirrors matchRoutePattern's decodeURIComponent pass (see "matchRoutePattern param decoding" suite above).
    expect(normalizeStaticPathsEntry("/files/a%2Fb", "/files/:name")).toEqual({
      params: { name: "a/b" },
    });
  });
});
