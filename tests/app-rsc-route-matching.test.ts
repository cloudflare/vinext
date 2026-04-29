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
    expect(matcher.matchRoute("/shop")).toMatchObject({
      route: { pattern: "/shop/:path*" },
      params: { path: [] },
    });
  });

  it("does not decode path segments during route matching", () => {
    const matcher = createAppRscRouteMatcher([route("/files/:name", ["files", ":name"])]);

    expect(matcher.matchRoute("/files/a%2Fb")).toMatchObject({
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
  interceptLayouts: readonly unknown[];
  page: unknown;
  params: string[];
};
