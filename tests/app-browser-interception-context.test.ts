import { describe, expect, it } from "vite-plus/test";
import {
  resolveManifestNavigationInterceptionContext,
  resolveMiddlewareRewriteNavigationInterceptionContext,
} from "../packages/vinext/src/server/app-browser-interception-context.js";
import type {
  RouteManifest,
  RouteManifestInterception,
} from "../packages/vinext/src/routing/app-route-graph.js";

function createRouteManifest(interceptions: readonly RouteManifestInterception[]): RouteManifest {
  return {
    graphVersion: "test",
    segmentGraph: {
      boundaries: new Map(),
      defaults: new Map(),
      interceptions: new Map(interceptions.map((interception) => [interception.id, interception])),
      interceptionsBySlotId: new Map(),
      layouts: new Map(),
      pages: new Map(),
      rootBoundaries: new Map(),
      routeHandlers: new Map(),
      routes: new Map(),
      slotBindings: new Map(),
      slots: new Map(),
      templates: new Map(),
    },
  };
}

const feedPhotoInterception: RouteManifestInterception = {
  id: "interception:slot:modal:/feed->/photos/:id",
  interceptingRouteId: "route:/feed",
  ownerLayoutId: "layout:/feed",
  slotId: "slot:modal:/feed",
  sourcePattern: "/feed",
  sourcePatternParts: ["feed"],
  targetPattern: "/photos/:id",
  targetPatternParts: ["photos", ":id"],
  targetRouteId: "route:/photos/:id",
};

const localePhotoInterception: RouteManifestInterception = {
  id: "interception:slot:modal:/interception-mw/:locale->/interception-mw/:locale/:username/p/:id",
  interceptingRouteId: "route:/interception-mw/:locale",
  ownerLayoutId: "layout:/interception-mw/:locale",
  slotId: "slot:modal:/interception-mw/:locale",
  sourcePattern: "/interception-mw/:locale",
  sourcePatternParts: ["interception-mw", ":locale"],
  targetPattern: "/interception-mw/:locale/:username/p/:id",
  targetPatternParts: ["interception-mw", ":locale", ":username", "p", ":id"],
  targetRouteId: "route:/interception-mw/:locale/:username/p/:id",
};

describe("resolveManifestNavigationInterceptionContext", () => {
  it("uses manifest-declared interception rules for first-hop browser navigations", () => {
    expect(
      resolveManifestNavigationInterceptionContext({
        basePath: "",
        currentPathname: "/feed",
        routeManifest: createRouteManifest([feedPhotoInterception]),
        targetPathname: "/photos/42",
      }),
    ).toBe("/feed");
  });

  it("strips basePath before matching and returning the interception context", () => {
    expect(
      resolveManifestNavigationInterceptionContext({
        basePath: "/app",
        currentPathname: "/app/feed",
        routeManifest: createRouteManifest([feedPhotoInterception]),
        targetPathname: "/app/photos/42",
      }),
    ).toBe("/feed");
  });

  it("does not infer interception context without a matching manifest rule", () => {
    expect(
      resolveManifestNavigationInterceptionContext({
        basePath: "",
        currentPathname: "/about",
        routeManifest: createRouteManifest([feedPhotoInterception]),
        targetPathname: "/photos/42",
      }),
    ).toBeNull();

    expect(
      resolveManifestNavigationInterceptionContext({
        basePath: "",
        currentPathname: "/feed",
        routeManifest: createRouteManifest([feedPhotoInterception]),
        targetPathname: "/about",
      }),
    ).toBeNull();
  });
});

describe("resolveMiddlewareRewriteNavigationInterceptionContext", () => {
  it("uses manifest source and target prefix rules for middleware-rewritten first-hop navigations", () => {
    expect(
      resolveMiddlewareRewriteNavigationInterceptionContext({
        basePath: "",
        currentPathname: "/interception-mw/en",
        routeManifest: createRouteManifest([localePhotoInterception]),
        targetPathname: "/interception-mw/foo/p/1",
      }),
    ).toBe("/interception-mw/en");
  });

  it("uses the middleware-matched source pathname from the current route state", () => {
    expect(
      resolveMiddlewareRewriteNavigationInterceptionContext({
        basePath: "",
        currentMatchedPathname: "/interception-mw/en",
        currentPathname: "/interception-mw",
        routeManifest: createRouteManifest([localePhotoInterception]),
        targetPathname: "/interception-mw/foo/p/1",
      }),
    ).toBe("/interception-mw/en");
  });

  // The matched pathname is decoded, while the server matches the context on
  // its raw segments, so it is sent encoded the way the URL parser encodes it.
  // Next.js sends `Next-Url: /en/tags/a` from `/tags/%61` too: params are
  // canonical, so `%61` and `a` name the same source.
  it.each([
    [
      "/interception-mw/tags/caf%C3%A9",
      "/interception-mw/en/tags/café",
      "/interception-mw/en/tags/caf%C3%A9",
    ],
    ["/interception-mw/tags/%61", "/interception-mw/en/tags/a", "/interception-mw/en/tags/a"],
    ["/interception-mw/tags/%7e", "/interception-mw/en/tags/~", "/interception-mw/en/tags/~"],
  ])(
    "encodes the matched pathname of %s that only matches after the rewrite",
    (currentPathname, currentMatchedPathname, expected) => {
      const tagPhotoInterception: RouteManifestInterception = {
        ...localePhotoInterception,
        id: "interception:slot:modal:/interception-mw/:locale/tags/:tag->/interception-mw/:locale/:username/p/:id",
        sourcePattern: "/interception-mw/:locale/tags/:tag",
        sourcePatternParts: ["interception-mw", ":locale", "tags", ":tag"],
      };

      expect(
        resolveMiddlewareRewriteNavigationInterceptionContext({
          basePath: "",
          currentMatchedPathname,
          currentPathname,
          routeManifest: createRouteManifest([tagPhotoInterception]),
          targetPathname: "/interception-mw/foo/p/1",
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ["/interception-mw/100%", "/interception-mw/100%25"],
    ["/interception-mw/%61", "/interception-mw/%2561"],
    ["/interception-mw/%2561", "/interception-mw/%252561"],
    ["/interception-mw/a%2Fb", "/interception-mw/a%2Fb"],
    ["/interception-mw/a%5Cb", "/interception-mw/a%5Cb"],
    ["/interception-mw/a b", "/interception-mw/a%20b"],
  ])("re-encodes the decoded matched pathname %s as %s", (currentMatchedPathname, expected) => {
    expect(
      resolveMiddlewareRewriteNavigationInterceptionContext({
        basePath: "",
        currentMatchedPathname,
        currentPathname: "/interception-mw",
        routeManifest: createRouteManifest([localePhotoInterception]),
        targetPathname: "/interception-mw/foo/p/1",
      }),
    ).toBe(expected);
  });

  // The URL parser strips TAB, LF and CR and trailing spaces, so these would
  // name a different source; `%252F` stands for both `%252F` and `%25252F`.
  it.each([
    "/interception-mw/a\tb",
    "/interception-mw/a\nb",
    "/interception-mw/a\rb",
    "/interception-mw/a ",
    "/interception-mw/%252F",
    "/interception-mw/%2523",
    "/interception-mw/%253f",
    "/interception-mw/%255C",
  ])(
    "does not send an ambiguous or URL-parser-changed matched pathname (%j)",
    (currentMatchedPathname) => {
      expect(
        resolveMiddlewareRewriteNavigationInterceptionContext({
          basePath: "",
          currentMatchedPathname,
          currentPathname: "/interception-mw",
          routeManifest: createRouteManifest([localePhotoInterception]),
          targetPathname: "/interception-mw/foo/p/1",
        }),
      ).toBeNull();
    },
  );

  it("does not infer fallback context when the target cannot be an intercepted route", () => {
    expect(
      resolveMiddlewareRewriteNavigationInterceptionContext({
        basePath: "",
        currentPathname: "/feed",
        routeManifest: createRouteManifest([feedPhotoInterception]),
        targetPathname: "/about",
      }),
    ).toBeNull();

    expect(
      resolveMiddlewareRewriteNavigationInterceptionContext({
        basePath: "",
        currentPathname: "/interception-mw/en",
        routeManifest: createRouteManifest([localePhotoInterception]),
        targetPathname: "/x/interception-mw/foo/p/1",
      }),
    ).toBeNull();
  });
});
