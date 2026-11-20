import { describe, expect, it } from "vite-plus/test";
import {
  ROUTE_MISS_DOCUMENT_NAVIGATION,
  resolveManifestNavigationInterceptionContext,
  resolveMiddlewareRewriteNavigationInterceptionContext,
} from "../packages/vinext/src/server/app-browser-interception-context.js";
import {
  getRouteMissInterceptionSourceHref,
  isRouteMissInterceptionSource,
} from "../packages/vinext/src/server/app-interception-context-header.js";
import type {
  RouteManifest,
  RouteManifestInterception,
  RouteManifestSlotBinding,
} from "../packages/vinext/src/routing/app-route-graph.js";

function createRouteManifest(
  interceptions: readonly RouteManifestInterception[],
  slotBindings: readonly RouteManifestSlotBinding[] = [],
): RouteManifest {
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
      slotBindings: new Map(slotBindings.map((binding) => [binding.id, binding])),
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

const rootPhotoInterception: RouteManifestInterception = {
  id: "interception:slot:modal:/->/photos/:id",
  interceptingRouteId: "route:/",
  ownerLayoutId: "layout:/",
  slotId: "slot:modal:/",
  sourcePattern: "/",
  sourcePatternParts: [],
  targetPattern: "/photos/:id",
  targetPatternParts: ["photos", ":id"],
  targetRouteId: "route:/photos/:id",
};

const slugPhotoInterception: RouteManifestInterception = {
  id: "interception:slot:modal:/:slug->/photos/:id",
  interceptingRouteId: "route:/:slug",
  ownerLayoutId: "layout:/:slug",
  slotId: "slot:modal:/:slug",
  sourcePattern: "/:slug",
  sourcePatternParts: [":slug"],
  targetPattern: "/photos/:id",
  targetPatternParts: ["photos", ":id"],
  targetRouteId: "route:/photos/:id",
};

const catchAllPhotoInterception: RouteManifestInterception = {
  id: "interception:slot:modal:/:rest+->/photos/:id",
  interceptingRouteId: "route:/:rest+",
  ownerLayoutId: "layout:/:rest+",
  slotId: "slot:modal:/:rest+",
  sourcePattern: "/:rest+",
  sourcePatternParts: [":rest+"],
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

// A parallel slot of the root layout besides `children`.
const rootModalBinding: RouteManifestSlotBinding = {
  defaultId: "default:slot:modal:/",
  id: "route:/photos/:id::slot:modal:/",
  ownerLayoutId: "layout:/",
  routeId: "route:/photos/:id",
  routeSegments: null,
  slotId: "slot:modal:/",
  state: "default",
};

// A parallel slot of a layout beneath the root.
const slugModalBinding: RouteManifestSlotBinding = {
  defaultId: "default:slot:modal:/:slug",
  id: "route:/:slug::slot:modal:/:slug",
  ownerLayoutId: "layout:/:slug",
  routeId: "route:/:slug",
  routeSegments: null,
  slotId: "slot:modal:/:slug",
  state: "default",
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

  it("sends no interception context from an unmatched URL's not-found page", () => {
    const options = {
      basePath: "",
      currentPathname: "/feed/missing",
      routeManifest: createRouteManifest([feedPhotoInterception]),
      targetPathname: "/photos/42",
    };

    expect(resolveManifestNavigationInterceptionContext(options)).toBe("/feed/missing");
    expect(
      resolveManifestNavigationInterceptionContext({ ...options, currentRenderIsRouteMiss: true }),
    ).toBeNull();
  });

  // Next.js's client keeps the not-found page in place of a root-owned
  // intercept's tree, so only an intercept owned beneath the root applies.
  it("sends /_not-found from a not-found page for sources beneath the root that match it", () => {
    for (const [interception, context] of [
      [rootPhotoInterception, null],
      [slugPhotoInterception, "/_not-found"],
      [catchAllPhotoInterception, "/_not-found"],
    ] as const) {
      for (const [basePath, currentPathname] of [
        ["", "/feed/missing"],
        ["", "/"],
        ["/docs", "/docs/feed/missing"],
      ]) {
        expect(
          resolveManifestNavigationInterceptionContext({
            basePath,
            currentPathname,
            currentRenderIsRouteMiss: true,
            routeManifest: createRouteManifest([feedPhotoInterception, interception]),
            targetPathname: `${basePath}/photos/42`,
          }),
        ).toBe(context);
      }
    }
  });

  // The not-found page's tree has only `children` at the root, so Next.js
  // loads the document of a target whose root layout has another slot.
  it("loads the document of an intercept target from a not-found page when the root layout has a slot", () => {
    for (const [slotBindings, context] of [
      [[], "/_not-found"],
      [[slugModalBinding], "/_not-found"],
      [[slugModalBinding, rootModalBinding], ROUTE_MISS_DOCUMENT_NAVIGATION],
    ] as const) {
      expect(
        resolveManifestNavigationInterceptionContext({
          basePath: "",
          currentPathname: "/feed/missing",
          currentRenderIsRouteMiss: true,
          routeManifest: createRouteManifest([slugPhotoInterception], slotBindings),
          targetPathname: "/photos/42",
        }),
      ).toBe(context);
    }

    // A root-owned intercept's source matches /_not-found too; one whose
    // source doesn't match it, and a target nothing intercepts, keep no context.
    for (const [interception, targetPathname, context] of [
      [rootPhotoInterception, "/photos/42", ROUTE_MISS_DOCUMENT_NAVIGATION],
      [feedPhotoInterception, "/photos/42", null],
      [slugPhotoInterception, "/about", null],
    ] as const) {
      expect(
        resolveManifestNavigationInterceptionContext({
          basePath: "/docs",
          currentPathname: "/docs/feed/missing",
          currentRenderIsRouteMiss: true,
          routeManifest: createRouteManifest([interception], [rootModalBinding]),
          targetPathname: `/docs${targetPathname}`,
        }),
      ).toBe(context);
    }

    expect(
      resolveManifestNavigationInterceptionContext({
        basePath: "",
        currentPathname: "/feed",
        routeManifest: createRouteManifest([feedPhotoInterception], [rootModalBinding]),
        targetPathname: "/photos/42",
      }),
    ).toBe("/feed");
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

  it("sends no interception context from an unmatched URL's not-found page", () => {
    const options = {
      basePath: "",
      currentMatchedPathname: "/interception-mw/en/missing",
      currentPathname: "/interception-mw/en/missing",
      routeManifest: createRouteManifest([localePhotoInterception]),
      targetPathname: "/interception-mw/foo/p/1",
    };

    expect(resolveMiddlewareRewriteNavigationInterceptionContext(options)).toBe(
      "/interception-mw/en/missing",
    );
    expect(
      resolveMiddlewareRewriteNavigationInterceptionContext({
        ...options,
        currentRenderIsRouteMiss: true,
      }),
    ).toBeNull();
  });

  it("sends /_not-found from a not-found page for sources beneath the root that match it", () => {
    for (const [interception, context] of [
      [rootPhotoInterception, null],
      [slugPhotoInterception, "/_not-found"],
      [catchAllPhotoInterception, "/_not-found"],
    ] as const) {
      for (const currentPathname of ["/feed/missing", "/"]) {
        expect(
          resolveMiddlewareRewriteNavigationInterceptionContext({
            basePath: "",
            currentMatchedPathname: currentPathname,
            currentPathname,
            currentRenderIsRouteMiss: true,
            routeManifest: createRouteManifest([feedPhotoInterception, interception]),
            targetPathname: "/photos/42",
          }),
        ).toBe(context);
      }
    }
  });

  it("loads the document of an intercept target from a not-found page when the root layout has a slot", () => {
    for (const [interceptions, slotBindings, context] of [
      [[slugPhotoInterception], [slugModalBinding], "/_not-found"],
      [
        [slugPhotoInterception],
        [slugModalBinding, rootModalBinding],
        ROUTE_MISS_DOCUMENT_NAVIGATION,
      ],
      [[rootPhotoInterception], [rootModalBinding], ROUTE_MISS_DOCUMENT_NAVIGATION],
      [[feedPhotoInterception], [rootModalBinding], null],
    ] as const) {
      expect(
        resolveMiddlewareRewriteNavigationInterceptionContext({
          basePath: "",
          currentMatchedPathname: "/feed/missing",
          currentPathname: "/feed/missing",
          currentRenderIsRouteMiss: true,
          routeManifest: createRouteManifest(interceptions, slotBindings),
          targetPathname: "/photos/42",
        }),
      ).toBe(context);
    }
  });
});

describe("isRouteMissInterceptionSource", () => {
  it("matches the not-found source under the basePath only", () => {
    expect(getRouteMissInterceptionSourceHref("")).toBe("/_not-found");
    expect(getRouteMissInterceptionSourceHref("/docs")).toBe("/docs/_not-found");
    expect(isRouteMissInterceptionSource("/_not-found", "")).toBe(true);
    expect(isRouteMissInterceptionSource("/docs/_not-found", "/docs")).toBe(true);

    expect(isRouteMissInterceptionSource(null, "")).toBe(false);
    expect(isRouteMissInterceptionSource("/_not-found", "/docs")).toBe(false);
    expect(isRouteMissInterceptionSource("/docs/_not-found", "")).toBe(false);
    expect(isRouteMissInterceptionSource("/_not-found/", "")).toBe(false);
    expect(isRouteMissInterceptionSource("/_not-found?a=1", "")).toBe(false);
    expect(isRouteMissInterceptionSource("/feed", "")).toBe(false);
  });
});
