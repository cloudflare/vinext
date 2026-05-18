import { describe, expect, it } from "vite-plus/test";
import {
  createAppRscRouteMatcher,
  matchAppRscRoutePattern,
} from "../packages/vinext/src/server/app-rsc-route-matching.js";

describe("App RSC route matching", () => {
  it("matches app routes through the shared route trie", () => {
    const matcher = createAppRscRouteMatcher([
      route("/", []),
      route("/blog/:slug", ["blog", ":slug"]),
      route("/docs/:path+", ["docs", ":path+"]),
      route("/shop/:path*", ["shop", ":path*"]),
    ]);

    expect(matcher.matchRoute("/blog/hello-world/")).toMatchObject({
      route: { pattern: "/blog/:slug" },
      params: { slug: "hello-world" },
    });
    expect(matcher.matchRoute("/docs")).toBeNull();
    expect(matcher.matchRoute("/docs/guides/rsc")).toMatchObject({
      route: { pattern: "/docs/:path+" },
      params: { path: ["guides", "rsc"] },
    });
    const result = matcher.matchRoute("/shop");
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/shop/:path*");
    expect(result!.params).toEqual({});
  });

  it("omits optional catch-all params when zero segments are matched", () => {
    // Next.js represents a missing optional catch-all param as absent at the
    // route-match boundary; app rendering later treats that as the `null`
    // tree segment for optional catch-all.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-matcher.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/get-dynamic-param.test.ts
    const matcher = createAppRscRouteMatcher([route("/shop/:path*", ["shop", ":path*"])]);

    const result = matcher.matchRoute("/shop");
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/shop/:path*");
    expect(result!.params).toEqual({});
  });

  it("omits optional catch-all params from standalone route pattern matches", () => {
    expect(matchAppRscRoutePattern(["shop"], ["shop", ":path*"])).toEqual({});
    expect(matchAppRscRoutePattern(["shop", "a", "b"], ["shop", ":path*"])).toEqual({
      path: ["a", "b"],
    });
  });

  // Ported from Next.js: route-matcher.ts decodeURIComponent behaviour
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/route-matcher.ts#L25-L27
  it("decodes matched params via decodeURIComponent (mirrors Next.js)", () => {
    const matcher = createAppRscRouteMatcher([route("/files/:name", ["files", ":name"])]);

    expect(matcher.matchRoute("/files/a%2Fb")).toMatchObject({
      params: { name: "a/b" },
    });
  });

  it("canonicalizes encoded URL parts before matching app routes", () => {
    // Next.js canonicalizes URL pathname parts before deriving dynamic segment
    // cache keys; vinext should apply the same decode-first discipline at the
    // App RSC route-match boundary so encoded static segments and params use
    // one normalized representation.
    // https://github.com/vercel/next.js/blob/47bcfa0956679c2a5fea0b941b76bb2d69878d9c/packages/next/src/client/route-params.ts
    const matcher = createAppRscRouteMatcher([
      route("/_sites/:subdomain", ["_sites", ":subdomain"]),
      route("/files/:name", ["files", ":name"]),
    ]);

    expect(matcher.matchRoute("/%5Fsites/demo")).toMatchObject({
      route: { pattern: "/_sites/:subdomain" },
      params: { subdomain: "demo" },
    });
    expect(matcher.matchRoute("/files/a%252Fb")).toMatchObject({
      params: { name: "a%2Fb" },
    });
  });

  it("matches standalone route patterns for dynamic metadata routes", () => {
    expect(
      matchAppRscRoutePattern(["blog", "hello", "sitemap.xml"], ["blog", ":slug", "sitemap.xml"]),
    ).toMatchObject({
      slug: "hello",
    });
  });

  it("treats static segments ending in plus or star as literals", () => {
    expect(matchAppRscRoutePattern(["c++", "intro"], ["c++", ":slug"])).toMatchObject({
      slug: "intro",
    });

    const starResult = matchAppRscRoutePattern(["file*"], ["file*"]);
    expect(starResult).not.toBeNull();
    expect(Object.keys(starResult ?? {})).toEqual([]);
  });

  it("finds intercepting routes and merges source and target params", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed/:id", ["feed", ":id"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/target-id", "/feed/source-id")).toMatchObject({
      sourceRouteIndex: 0,
      slotKey: "modal",
      targetPattern: "/photos/:id",
      page: "photo-page",
      matchedParams: { id: "target-id" },
    });
  });

  it("does not treat a target match as an intercept without a matching source route", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed", ["feed"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/42", null)).toBeNull();
    expect(matcher.findIntercept("/photos/42", "/gallery")).toBeNull();
  });

  it("canonicalizes encoded source path parts for interception params", () => {
    const matcher = createAppRscRouteMatcher([
      route("/_sites/:tenant", ["_sites", ":tenant"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/:id",
              interceptLayouts: ["modal-layout"],
              page: "photo-page",
              params: ["id"],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/a%2Fb", "/%5Fsites/acme")).toMatchObject({
      targetPattern: "/photos/:id",
      matchedParams: { tenant: "acme", id: "a/b" },
    });
  });

  it("preserves bracket-shaped literal segments in intercept target patterns", () => {
    const matcher = createAppRscRouteMatcher([
      route("/feed", ["feed"], {
        modal: {
          intercepts: [
            {
              targetPattern: "/photos/[literal]",
              interceptLayouts: ["modal-layout"],
              page: "literal-photo-page",
              params: [],
            },
          ],
        },
      }),
    ]);

    expect(matcher.findIntercept("/photos/[literal]", "/feed")).toMatchObject({
      targetPattern: "/photos/[literal]",
      page: "literal-photo-page",
      matchedParams: {},
    });
    expect(matcher.findIntercept("/photos/anything", "/feed")).toBeNull();
  });

  // Ported from Next.js: lib/generate-interception-routes-rewrites.test.ts
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.test.ts
  //
  // Interception is implemented in Next.js as a rewrite that only fires when
  // the Next-URL header matches the *intercepting route* regex (the path that
  // owns the slot, with route groups and @slot segments stripped).
  //
  // vinext must enforce the same constraint at the matcher boundary: an
  // intercept entry whose targetPattern matches the request URL is only valid
  // when the provided source pathname matches its declared sourceMatchPattern.
  // Otherwise the matcher must fall through to null so the direct route is
  // rendered.
  describe("source-pathname filtering (mirrors Next.js Next-URL header rewrite)", () => {
    it("returns null when the source pathname does not match the intercepting route", () => {
      // Slot lives at root (`/@modal`) and intercepts `/groups/[id]/new`.
      // Intercepting route = `/` so any source under `/` is allowed.
      // But for a slot at `/templates`, only `/templates(?:/.*)?` sources qualify.
      const matcher = createAppRscRouteMatcher([
        route("/templates/:catchAll+", ["templates", ":catchAll+"], {
          modal: {
            intercepts: [
              {
                // (..)showcase/[...catchAll] from `app/templates`
                sourceMatchPattern: "/templates",
                targetPattern: "/showcase/:catchAll+",
                interceptLayouts: ["layout"],
                page: "intercept-page",
                params: ["catchAll"],
              },
            ],
          },
        }),
      ]);

      // Source under /templates — should intercept.
      expect(matcher.findIntercept("/showcase/multi/slug", "/templates/multi/slug")).toMatchObject({
        targetPattern: "/showcase/:catchAll+",
      });

      // Source NOT under /templates — must not intercept.
      expect(matcher.findIntercept("/showcase/single", "/")).toBeNull();
      expect(matcher.findIntercept("/showcase/single", "/other")).toBeNull();
    });

    it("returns null when no source pathname is provided (no Next-URL header)", () => {
      // Without a Next-URL header the rewrite cannot fire in Next.js, so the
      // direct page must render. vinext should mirror that.
      const matcher = createAppRscRouteMatcher([
        route("/templates/:catchAll+", ["templates", ":catchAll+"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/templates",
                targetPattern: "/showcase/:catchAll+",
                interceptLayouts: ["layout"],
                page: "intercept-page",
                params: ["catchAll"],
              },
            ],
          },
        }),
      ]);

      expect(matcher.findIntercept("/showcase/multi/slug", null)).toBeNull();
      expect(matcher.findIntercept("/showcase/multi/slug")).toBeNull();
    });

    it("accepts descendants of the intercepting route as valid sources", () => {
      // Header regex appends `(?:/.*)?` to allow any descendant of the
      // intercepting route to trigger the rewrite.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
      const matcher = createAppRscRouteMatcher([
        route("/feed/:id", ["feed", ":id"], {
          modal: {
            intercepts: [
              {
                // (.)photos/[id] from `app/feed/[id]`
                sourceMatchPattern: "/feed/:id",
                targetPattern: "/feed/:id/photos/:photoId",
                interceptLayouts: ["layout"],
                page: "modal-photo",
                params: ["id", "photoId"],
              },
            ],
          },
        }),
      ]);

      // Exact match on intercepting route.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/feed/abc")).not.toBeNull();
      // Descendant of intercepting route.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/feed/abc/nested/deep")).not.toBeNull();
      // Parent of intercepting route — should NOT intercept.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/")).toBeNull();
      // Sibling — should NOT intercept.
      expect(matcher.findIntercept("/feed/abc/photos/1", "/other")).toBeNull();
    });

    it("treats a sourceMatchPattern of `/` as matching any source", () => {
      // Slot at root (`/@modal/(.)groups/[id]/new`) yields intercepting route `/`,
      // which Next.js implements as `^/.*$` — i.e. any source.
      const matcher = createAppRscRouteMatcher([
        route("/", [], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/",
                targetPattern: "/groups/:id/new",
                interceptLayouts: ["layout"],
                page: "modal-new",
                params: ["id"],
              },
            ],
          },
        }),
      ]);

      expect(matcher.findIntercept("/groups/123/new", "/")).not.toBeNull();
      expect(matcher.findIntercept("/groups/123/new", "/groups/123")).not.toBeNull();
      expect(matcher.findIntercept("/groups/123/new", "/anything/else/deep")).not.toBeNull();
      // But still must require a source pathname (Next-URL header) to fire.
      expect(matcher.findIntercept("/groups/123/new", null)).toBeNull();
    });

    it("matches dynamic segments in the intercepting route pattern", () => {
      // /[lang]/foo/(..)photos has interceptingRoute `/[lang]/foo`,
      // header regex `^/(?<lang>[^/]+)/foo(?:/.*)?$`.
      const matcher = createAppRscRouteMatcher([
        route("/:lang/foo", [":lang", "foo"], {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/:lang/foo",
                targetPattern: "/:lang/photos",
                interceptLayouts: ["layout"],
                page: "modal-photos",
                params: ["lang"],
              },
            ],
          },
        }),
      ]);

      expect(matcher.findIntercept("/en/photos", "/en/foo")).not.toBeNull();
      expect(matcher.findIntercept("/en/photos", "/en/foo/bar")).not.toBeNull();
      // Wrong dynamic value — still a descendant in URL terms but the
      // intercepting route requires `/<lang>/foo`, so `/en/bar` should fail.
      expect(matcher.findIntercept("/en/photos", "/en/bar")).toBeNull();
      expect(matcher.findIntercept("/en/photos", "/en")).toBeNull();
    });
  });
});

function route(
  pattern: string,
  patternParts: string[],
  slots?: Record<string, { intercepts?: TestIntercept[] }>,
): TestRoute {
  return {
    pattern,
    patternParts,
    slots,
  };
}

type TestRoute = {
  pattern: string;
  patternParts: string[];
  slots?: Record<string, { intercepts?: TestIntercept[] }>;
};

type TestIntercept = {
  targetPattern: string;
  /**
   * URL pattern of the intercepting route (the path that owns the slot,
   * with route groups and `@slot` segments stripped). Mirrors Next.js'
   * `interceptingRoute` from `extractInterceptionRouteInformation` and is
   * used to gate `findIntercept` against the Next-URL header.
   */
  sourceMatchPattern?: string;
  interceptLayouts: readonly unknown[];
  page: unknown;
  params: string[];
};
