import { describe, expect, it } from "vite-plus/test";
import { buildPageCacheTags } from "../packages/vinext/src/server/implicit-tags.js";

describe("App Router page cache tags", () => {
  // Covers cloudflare/vinext#921: route-scoped soft tags include pattern-derived layout tags.
  it("uses route pattern segments for dynamic layout and page tags", () => {
    expect(buildPageCacheTags("/blog/hello", [], ["blog", "[slug]"], "page")).toEqual([
      "/blog/hello",
      "_N_T_/blog/hello",
      "_N_T_/layout",
      "_N_T_/blog/layout",
      "_N_T_/blog/[slug]/layout",
      "_N_T_/blog/[slug]/page",
    ]);
  });

  it("adds root and index exact-path aliases", () => {
    expect(buildPageCacheTags("/", [], [], "page")).toEqual([
      "/",
      "_N_T_/",
      "_N_T_/index",
      "_N_T_/layout",
      "_N_T_/page",
    ]);
    expect(buildPageCacheTags("/index", [], ["index"], "page")).toContain("_N_T_/");
  });

  it("keeps route groups in derived pattern tags while preserving the resolved path tag", () => {
    expect(buildPageCacheTags("/blog/hello", [], ["(main)", "blog", "[slug]"], "page")).toEqual([
      "/blog/hello",
      "_N_T_/blog/hello",
      "_N_T_/layout",
      "_N_T_/(main)/layout",
      "_N_T_/(main)/blog/layout",
      "_N_T_/(main)/blog/[slug]/layout",
      "_N_T_/(main)/blog/[slug]/page",
    ]);
  });

  it("uses route handler leaf tags for route handlers", () => {
    expect(buildPageCacheTags("/api/posts", ["posts"], ["api", "posts"], "route")).toEqual([
      "/api/posts",
      "_N_T_/api/posts",
      "_N_T_/layout",
      "_N_T_/api/layout",
      "_N_T_/api/posts/layout",
      "_N_T_/api/posts/route",
      "posts",
    ]);
  });

  it("treats literal page and route path segments as intermediate layouts", () => {
    expect(buildPageCacheTags("/docs/page/intro", [], ["docs", "page", "[slug]"], "page")).toEqual([
      "/docs/page/intro",
      "_N_T_/docs/page/intro",
      "_N_T_/layout",
      "_N_T_/docs/layout",
      "_N_T_/docs/page/layout",
      "_N_T_/docs/page/[slug]/layout",
      "_N_T_/docs/page/[slug]/page",
    ]);

    expect(buildPageCacheTags("/api/route/posts", [], ["api", "route", "posts"], "route")).toEqual([
      "/api/route/posts",
      "_N_T_/api/route/posts",
      "_N_T_/layout",
      "_N_T_/api/layout",
      "_N_T_/api/route/layout",
      "_N_T_/api/route/posts/layout",
      "_N_T_/api/route/posts/route",
    ]);
  });

  it("keeps catch-all route segments in derived pattern tags", () => {
    expect(buildPageCacheTags("/docs/a/b", [], ["docs", "[...slug]"], "page")).toEqual([
      "/docs/a/b",
      "_N_T_/docs/a/b",
      "_N_T_/layout",
      "_N_T_/docs/layout",
      "_N_T_/docs/[...slug]/layout",
      "_N_T_/docs/[...slug]/page",
    ]);

    expect(buildPageCacheTags("/optional/a", [], ["optional", "[[...id]]"], "page")).toEqual([
      "/optional/a",
      "_N_T_/optional/a",
      "_N_T_/layout",
      "_N_T_/optional/layout",
      "_N_T_/optional/[[...id]]/layout",
      "_N_T_/optional/[[...id]]/page",
    ]);
  });
});
