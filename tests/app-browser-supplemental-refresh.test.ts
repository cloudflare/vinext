import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSupplementalRefreshCoordinator,
  mergeRefreshedParallelSlot,
  requireCompleteSupplementalRefresh,
  resolvePersistedRefreshInterceptions,
  resolvePersistedSourcePageRefreshes,
  resolveServerActionSupplementalRefresh,
  resolveSupplementalRefreshes,
  SupplementalRefreshError,
  supplyRetainedElements,
} from "../packages/vinext/src/server/app-browser-supplemental-refresh.js";
import { AppElementsWire, type AppElements } from "../packages/vinext/src/server/app-elements.js";
import { createNestedBfcacheSlotSegmentId } from "../packages/vinext/src/server/bfcache-identity.js";
import type {
  BrowserRouteManifest,
  BrowserRouteManifestInterception,
} from "../packages/vinext/src/routing/browser-route-manifest.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("parallel route supplemental refreshes", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-revalidation/parallel-routes-revalidation.test.ts
  it("retains the source query while refreshing an intercepted URL", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "",
        refreshUrl: new URL("https://example.com/refreshing/login?modal=new"),
        state: {
          previousNextUrl: "/refreshing?random=old",
          slotBindings: [],
        },
      }),
    ).toEqual(["/refreshing?random=old"]);
  });

  it("recovers the active children route when multiple parallel slots are active", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/nested-revalidate/modal?view=current"),
        state: {
          previousNextUrl: "/docs/nested-revalidate/drawer",
          slotBindings: [
            {
              activeRouteId: "route:/nested-revalidate/modal",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              activeRouteId: "route:/nested-revalidate",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:children:/nested-revalidate",
              state: "active",
            },
            {
              activeRouteId: "route:/nested-revalidate/drawer",
              ownerLayoutId: "layout:/nested-revalidate",
              slotId: "slot:drawer:/nested-revalidate",
              state: "active",
            },
          ],
        },
      }),
    ).toEqual(["/docs/nested-revalidate/drawer", "/docs/nested-revalidate?view=current"]);
  });

  it("keeps a route segment that repeats the basePath when adding it back", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        activeRoutePaths: ["/docs/guide"],
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/docs/guide/modal"),
        state: {
          previousNextUrl: null,
          slotBindings: [],
        },
      }),
    ).toEqual(["/docs/docs/guide"]);
  });

  it("keeps a route segment that repeats the basePath in a persisted interception target", () => {
    const interception: BrowserRouteManifestInterception = {
      id: "interception:slot:modal:/docs/feed->/docs/guide",
      ownerLayoutId: "layout:/",
      slotId: "slot:modal:/",
      sourcePatternParts: ["docs", "feed"],
      targetPatternParts: ["docs", "guide"],
      targetRouteId: "route:/docs/guide",
    };
    const routeManifest: BrowserRouteManifest = {
      graphVersion: "test",
      segmentGraph: {
        interceptions: new Map([[interception.id, interception]]),
        interceptionsBySlotId: new Map(),
        layouts: new Map(),
        rootBoundaries: new Map(),
        routes: new Map(),
        slotBindings: new Map(),
      },
    };

    expect(
      resolvePersistedRefreshInterceptions({
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/docs/feed?tab=new"),
        requestInterceptionContext: null,
        routeManifest,
        state: {
          interception: null,
          slotBindings: [
            {
              activeRouteId: "route:/docs/guide",
              interceptionId: interception.id,
              interceptionSourceMatchedUrl: "/docs/feed",
              ownerLayoutId: "layout:/",
              slotId: "slot:modal:/",
              state: "active",
            },
          ],
        },
      }),
    ).toEqual([
      {
        interception,
        interceptionContext: "/docs/feed",
        targetPathname: "/docs/docs/guide?tab=new",
      },
    ]);
  });

  it("uses the traversed-to history entry instead of routes from the page being left", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        activeRoutePaths: ["/detail-page"],
        basePath: "",
        refreshUrl: new URL("https://example.com/detail-page"),
        state: {
          previousNextUrl: null,
          // These bindings belong to the intercepted page being left. A
          // cache-miss traversal must use the target history entry's paths,
          // never this navigation-initiation tree.
          slotBindings: [
            {
              activeRouteId: "route:/refreshing",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              activeRouteId: "route:/refreshing/login",
              ownerLayoutId: "layout:/",
              slotId: "slot:modal:/",
              state: "active",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("does not refresh a retained descendant after navigating back to its ancestor", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "",
        refreshUrl: new URL("https://example.com/client-cache"),
        state: {
          previousNextUrl: null,
          slotBindings: [
            {
              activeRouteId: "route:/client-cache",
              ownerLayoutId: "layout:/client-cache",
              slotId: "slot:breadcrumbs:/client-cache",
              state: "active",
            },
            {
              activeRouteId: "route:/client-cache/2",
              ownerLayoutId: "layout:/client-cache",
              slotId: "slot:children:/client-cache",
              state: "active",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it.each([
    {
      name: "a trailing-slash route",
      activeRoutePaths: ["/foo/bar"],
      basePath: "",
      refreshUrl: "https://example.com/foo/",
    },
    {
      name: "a trailing-slash route under basePath",
      activeRoutePaths: ["/foo/bar"],
      basePath: "/docs",
      refreshUrl: "https://example.com/docs/foo/",
    },
    {
      name: "an encoded Unicode route",
      activeRoutePaths: ["/café/bar"],
      basePath: "",
      refreshUrl: "https://example.com/caf%C3%A9",
    },
  ])("does not refresh a retained descendant of $name", (testCase) => {
    expect(
      resolvePersistedSourcePageRefreshes({
        activeRoutePaths: testCase.activeRoutePaths,
        basePath: testCase.basePath,
        refreshUrl: new URL(testCase.refreshUrl),
        state: {
          previousNextUrl: null,
          slotBindings: [],
        },
      }),
    ).toEqual([]);
  });

  it("does not treat a shared pathname prefix as a descendant", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        activeRoutePaths: ["/foobar"],
        basePath: "",
        refreshUrl: new URL("https://example.com/foo"),
        state: {
          previousNextUrl: null,
          slotBindings: [],
        },
      }),
    ).toEqual(["/foobar"]);
  });

  it("merges every active slot from a supplemental route response", () => {
    const modalSegmentId = createNestedBfcacheSlotSegmentId("slot:modal:/nested", 1);
    const current: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          [modalSegmentId]: "modal segment mounted",
          "slot:children:/nested": "page stale",
          "slot:modal:/nested": "modal mounted",
        },
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/nested"],
        rootLayoutTreePath: "/",
        routeId: "route:/nested/modal",
        slotBindings: [
          {
            activeRouteId: "route:/nested/modal",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:modal:/nested",
            state: "active",
          },
        ],
      }),
      [modalSegmentId]: "mounted modal segment",
      "slot:children:/nested": "stale page",
      "slot:drawer:/nested": "stale drawer",
      "slot:modal:/nested": "fresh modal",
      "route:/nested": "stale page route",
      "route:/nested/drawer": "stale drawer route",
    };
    const refreshed: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        // The refreshed tree describes the modal slot by its default.
        bfcacheSegmentIdentities: {
          [modalSegmentId]: "modal segment default",
          "slot:children:/nested": "page fresh",
          "slot:drawer:/nested": "drawer fresh",
          "slot:modal:/nested": "modal default",
        },
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/nested"],
        rootLayoutTreePath: "/",
        routeId: "route:/nested/drawer",
        slotBindings: [
          {
            activeRouteId: "route:/nested",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:children:/nested",
            state: "active",
          },
          {
            activeRouteId: "route:/nested/drawer",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:drawer:/nested",
            state: "active",
          },
        ],
      }),
      [modalSegmentId]: "default modal segment",
      "slot:children:/nested": "fresh page",
      "slot:drawer:/nested": "fresh drawer",
      "route:/nested": "fresh page route",
      "route:/nested/drawer": "fresh drawer route",
    };

    const result = mergeRefreshedParallelSlot(current, refreshed);
    expect(result["slot:children:/nested"]).toBe("fresh page");
    expect(result["slot:drawer:/nested"]).toBe("fresh drawer");
    expect(result["slot:modal:/nested"]).toBe("fresh modal");
    expect(result[modalSegmentId]).toBe("mounted modal segment");
    // The retained modal keeps the identities it was mounted with.
    expect(AppElementsWire.readMetadata(result).bfcacheSegmentIdentities).toEqual({
      [modalSegmentId]: "modal segment mounted",
      "slot:children:/nested": "page fresh",
      "slot:drawer:/nested": "drawer fresh",
      "slot:modal:/nested": "modal mounted",
    });
    expect(result["route:/nested"]).toBe("fresh page route");
    expect(result["route:/nested/drawer"]).toBe("fresh drawer route");
    expect(AppElementsWire.readMetadata(result).routeId).toBe("route:/nested/drawer");
    expect(AppElementsWire.readMetadata(result).slotBindings).toEqual([
      expect.objectContaining({ slotId: "slot:children:/nested", state: "active" }),
      expect.objectContaining({ slotId: "slot:drawer:/nested", state: "active" }),
      expect.objectContaining({ slotId: "slot:modal:/nested", state: "active" }),
    ]);
  });

  it("takes each refreshed route's head with the route", () => {
    const metadata = (routeId: string, slotId: string, activeRouteId: string) =>
      AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId,
        slotBindings: [{ activeRouteId, ownerLayoutId: "layout:/", slotId, state: "active" }],
      });
    const current: AppElements = {
      ...metadata("route:/", "slot:drawer:/", "route:/drawer"),
      "slot:drawer:/": "stale drawer",
      "route:/": "page route",
      "route:/drawer": "stale drawer route",
      "__vinext_route_head:route:/": "page head",
      "__vinext_route_head:route:/drawer": "stale drawer head",
    };

    const drawerRefresh = mergeRefreshedParallelSlot(current, {
      ...metadata("route:/drawer", "slot:drawer:/", "route:/drawer"),
      "slot:drawer:/": "fresh drawer",
      "route:/drawer": "fresh drawer route",
      "__vinext_route_head:route:/drawer": "fresh drawer head",
    });
    expect(drawerRefresh["route:/drawer"]).toBe("fresh drawer route");
    expect(drawerRefresh["__vinext_route_head:route:/drawer"]).toBe("fresh drawer head");
    expect(drawerRefresh["__vinext_route_head:route:/"]).toBe("page head");

    // A source-tree refresh keeps the routes it does not carry, heads included.
    const sourceRefresh = mergeRefreshedParallelSlot(current, {
      ...metadata("route:/other", "slot:children:/", "route:/other"),
      "slot:children:/": "fresh page",
      "route:/other": "fresh other route",
      "__vinext_route_head:route:/other": "fresh other head",
    });
    expect(sourceRefresh["__vinext_route_head:route:/other"]).toBe("fresh other head");
    expect(sourceRefresh["route:/drawer"]).toBe("stale drawer route");
    expect(sourceRefresh["__vinext_route_head:route:/drawer"]).toBe("stale drawer head");
  });

  it("promotes a supplemental source page into the mounted nested children slot", () => {
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/nested"],
        rootLayoutTreePath: "/",
        routeId: "route:/nested/modal",
        slotBindings: [
          {
            ownerLayoutId: "layout:/nested",
            slotId: "slot:children:/nested",
            state: "unmatched",
          },
          {
            activeRouteId: "route:/nested/modal",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:modal:/nested",
            state: "active",
          },
        ],
      }),
      "slot:children:/nested": AppElementsWire.unmatchedSlotValue,
      "slot:modal:/nested": "fresh modal",
    };
    const sourcePage: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/nested"],
        rootLayoutTreePath: "/",
        routeId: "route:/nested",
        slotBindings: [
          {
            activeRouteId: "route:/nested",
            ownerLayoutId: "layout:/",
            slotId: "slot:children:/",
            state: "active",
          },
        ],
      }),
      "slot:children:/": "fresh parent tree",
    };
    const drawer: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/nested"],
        rootLayoutTreePath: "/",
        routeId: "route:/nested/drawer",
        slotBindings: [
          {
            ownerLayoutId: "layout:/nested",
            slotId: "slot:children:/nested",
            state: "unmatched",
          },
          {
            activeRouteId: "route:/nested/drawer",
            ownerLayoutId: "layout:/nested",
            slotId: "slot:drawer:/nested",
            state: "active",
          },
        ],
      }),
      "slot:children:/nested": AppElementsWire.unmatchedSlotValue,
      "slot:drawer:/nested": "fresh drawer",
    };

    const sourceResult = mergeRefreshedParallelSlot(primary, sourcePage);
    expect(sourceResult["slot:children:/nested"]).toBe("fresh parent tree");
    const result = mergeRefreshedParallelSlot(sourceResult, drawer);

    expect(result["slot:children:/nested"]).toBe("fresh parent tree");
    expect(result["slot:modal:/nested"]).toBe("fresh modal");
    expect(result["slot:drawer:/nested"]).toBe("fresh drawer");
    expect(AppElementsWire.readMetadata(result).slotBindings).toEqual([
      expect.objectContaining({ slotId: "slot:children:/", state: "active" }),
      expect.objectContaining({ slotId: "slot:children:/nested", state: "active" }),
      expect.objectContaining({ slotId: "slot:drawer:/nested", state: "active" }),
      expect.objectContaining({ slotId: "slot:modal:/nested", state: "active" }),
    ]);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts
  it("takes a refreshed slot's BFCache identities with its content", () => {
    const navbarSegmentId = createNestedBfcacheSlotSegmentId("slot:navbar:/dashboard", 1);
    const mainSegmentId = createNestedBfcacheSlotSegmentId("slot:main:/dashboard", 1);
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          [mainSegmentId]: "main analytics",
          [navbarSegmentId]: "navbar default",
          "slot:navbar:/dashboard": "navbar shell",
        },
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/dashboard"],
        rootLayoutTreePath: "/",
        routeId: "route:/dashboard/analytics",
        slotBindings: [
          {
            activeRouteId: "route:/dashboard/analytics",
            ownerLayoutId: "layout:/dashboard",
            slotId: "slot:main:/dashboard",
            state: "active",
          },
          {
            ownerLayoutId: "layout:/dashboard",
            slotId: "slot:navbar:/dashboard",
            state: "default",
          },
        ],
      }),
      [mainSegmentId]: null,
      [navbarSegmentId]: null,
      "slot:main:/dashboard": "fresh analytics",
    };
    const source: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          [mainSegmentId]: "main dashboard",
          [navbarSegmentId]: "navbar active",
          "slot:navbar:/dashboard": "navbar shell",
        },
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/dashboard"],
        rootLayoutTreePath: "/",
        routeId: "route:/dashboard",
        slotBindings: [
          {
            activeRouteId: "route:/dashboard",
            ownerLayoutId: "layout:/dashboard",
            slotId: "slot:navbar:/dashboard",
            state: "active",
          },
        ],
      }),
      [navbarSegmentId]: null,
      "slot:navbar:/dashboard": "fresh navbar",
    };

    const result = mergeRefreshedParallelSlot(primary, source);
    expect(result["slot:navbar:/dashboard"]).toBe("fresh navbar");
    expect(Object.hasOwn(result, navbarSegmentId)).toBe(true);
    // The kept navbar's identity matches the one mounted before the refresh,
    // so its BFCache id and client state survive.
    expect(AppElementsWire.readMetadata(result).bfcacheSegmentIdentities).toEqual({
      [mainSegmentId]: "main analytics",
      [navbarSegmentId]: "navbar active",
      "slot:navbar:/dashboard": "navbar shell",
    });
  });

  it("replaces only the refreshed slot and its binding", () => {
    const current: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interception: null,
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/other",
        slotBindings: [],
      }),
      "slot:children:/": "fresh other",
    };
    const refreshed: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interception: {
          sourceMatchedUrl: "/",
          sourceRouteId: "route:/",
          slotId: "slot:modal:/",
          targetMatchedUrl: "/login",
          targetRouteId: "route:/login",
        },
        interceptionContext: "/",
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/",
        slotBindings: [
          {
            activeRouteId: "route:/login",
            interceptionId: "interception:modal",
            interceptionSourceMatchedUrl: "/",
            ownerLayoutId: "layout:/",
            slotId: "slot:modal:/",
            state: "active",
          },
        ],
      }),
      "slot:modal:/": "fresh modal",
    };

    const result = mergeRefreshedParallelSlot(current, refreshed);
    expect(result["slot:children:/"]).toBe("fresh other");
    expect(result["slot:modal:/"]).toBe("fresh modal");
    expect(AppElementsWire.readMetadata(result).slotBindings).toEqual([
      expect.objectContaining({ slotId: "slot:modal:/", state: "active" }),
    ]);
  });

  it("takes an intercepted slot's BFCache identities with its content", () => {
    const modalSegmentId = createNestedBfcacheSlotSegmentId("slot:modal:/", 1);
    const staleModalSegmentId = createNestedBfcacheSlotSegmentId("slot:modal:/", 2);
    const childrenSegmentId = createNestedBfcacheSlotSegmentId("slot:children:/", 1);
    const current: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          [childrenSegmentId]: "children photo",
          [modalSegmentId]: "modal default",
          [staleModalSegmentId]: "modal default nested",
          "slot:modal:/": "modal shell",
        },
        interception: null,
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/photo",
        slotBindings: [
          {
            ownerLayoutId: "layout:/",
            slotId: "slot:modal:/",
            state: "default",
          },
        ],
      }),
      [childrenSegmentId]: null,
      [modalSegmentId]: null,
      [staleModalSegmentId]: null,
      "slot:children:/": "fresh photo",
    };
    const refreshed: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          [childrenSegmentId]: "children feed",
          [modalSegmentId]: "modal photo",
          "slot:modal:/": "modal shell",
        },
        interception: {
          sourceMatchedUrl: "/",
          sourceRouteId: "route:/",
          slotId: "slot:modal:/",
          targetMatchedUrl: "/photo",
          targetRouteId: "route:/photo",
        },
        interceptionContext: "/",
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/",
        slotBindings: [
          {
            activeRouteId: "route:/photo",
            interceptionId: "interception:modal",
            interceptionSourceMatchedUrl: "/",
            ownerLayoutId: "layout:/",
            slotId: "slot:modal:/",
            state: "active",
          },
        ],
      }),
      [modalSegmentId]: null,
      "slot:modal:/": "fresh modal",
    };

    const result = mergeRefreshedParallelSlot(current, refreshed);
    expect(result["slot:modal:/"]).toBe("fresh modal");
    expect(Object.hasOwn(result, modalSegmentId)).toBe(true);
    // The default slot's deeper marker belongs to the content the refresh
    // replaced, so it leaves with it.
    expect(Object.hasOwn(result, staleModalSegmentId)).toBe(false);
    expect(Object.hasOwn(result, childrenSegmentId)).toBe(true);
    expect(AppElementsWire.readMetadata(result).bfcacheSegmentIdentities).toEqual({
      [childrenSegmentId]: "children photo",
      [modalSegmentId]: "modal photo",
      "slot:modal:/": "modal shell",
    });
  });

  it("supplies the elements an intercepted payload left for the client to keep", () => {
    const interception = {
      sourceMatchedUrl: "/members/7",
      sourceRouteId: "route:/members/7",
      slotId: "slot:modal:/members",
      targetMatchedUrl: "/photos/1",
      targetRouteId: "route:/photos/1",
    };
    const retainedElementIds = [
      "page:/members/7",
      "slot:sidebar:/members",
      "__vinext_route_head:route:/members/7",
    ];
    const sidebarSegmentId = createNestedBfcacheSlotSegmentId("slot:sidebar:/members", 1);
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          "layout:/members": "members layout",
          "page:/members/7": "member 7",
          "slot:sidebar:/members": "sidebar shell",
        },
        interception,
        interceptionContext: "/members/7",
        layoutIds: ["layout:/", "layout:/members"],
        rootLayoutTreePath: "/",
        routeId: "route:/members/7",
        slotBindings: [
          {
            activeRouteId: "route:/photos/1",
            interceptionId: "interception:modal",
            interceptionSourceMatchedUrl: "/members/7",
            ownerLayoutId: "layout:/members",
            slotId: "slot:modal:/members",
            state: "active",
          },
          { ownerLayoutId: "layout:/members", slotId: "slot:sidebar:/members", state: "default" },
        ],
      }),
      [AppElementsWire.keys.retainedElementIds]: retainedElementIds,
      "layout:/members": "members layout",
      "route:/members/7": "route",
      "slot:modal:/members": "photo modal",
    };
    const source: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          [sidebarSegmentId]: "sidebar members",
          "layout:/members": "members layout",
          "page:/members/7": "member 7",
          "slot:sidebar:/members": "sidebar shell",
        },
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/members"],
        rootLayoutTreePath: "/",
        routeId: "route:/members/7",
        slotBindings: [
          { ownerLayoutId: "layout:/members", slotId: "slot:modal:/members", state: "default" },
          {
            activeRouteId: "route:/members/7",
            ownerLayoutId: "layout:/members",
            slotId: "slot:sidebar:/members",
            state: "active",
          },
        ],
      }),
      [sidebarSegmentId]: null,
      "__vinext_route_head:route:/members/7": "member head",
      "layout:/members": "source layout",
      "page:/members/7": "member page",
      "route:/members/7": "source route",
      "slot:modal:/members": "modal default",
      "slot:sidebar:/members": "member sidebar",
    };

    const result = mergeRefreshedParallelSlot(primary, source);
    expect(result["page:/members/7"]).toBe("member page");
    expect(result["__vinext_route_head:route:/members/7"]).toBe("member head");
    expect(result["slot:sidebar:/members"]).toBe("member sidebar");
    expect(Object.hasOwn(result, sidebarSegmentId)).toBe(true);
    // The intercepted payload's own render wins over the source's.
    expect(result["slot:modal:/members"]).toBe("photo modal");
    expect(result["layout:/members"]).toBe("members layout");
    const metadata = AppElementsWire.readMetadata(result);
    expect(metadata.interception).toEqual(interception);
    expect(metadata.slotBindings).toEqual([
      expect.objectContaining({ slotId: "slot:modal:/members", state: "active" }),
      expect.objectContaining({ slotId: "slot:sidebar:/members", state: "active" }),
    ]);
    expect(metadata.bfcacheSegmentIdentities[sidebarSegmentId]).toBe("sidebar members");
  });

  // A source render that refreshes the source's slots fills in only what the
  // intercepted payload left out, whichever slot it refreshes, even where it
  // matches the intercepted slot from its own URL.
  it.each(["slot:sidebar:/members", "slot:children:/members"])(
    "keeps the intercepted payload's own head and modal when a source render refreshes %s",
    (refreshedSlotId) => {
      const interception = {
        sourceMatchedUrl: "/members/7",
        sourceRouteId: "route:/members/7",
        slotId: "slot:modal:/members",
        targetMatchedUrl: "/photos/1",
        targetRouteId: "route:/photos/1",
      };
      const primary: AppElements = {
        ...AppElementsWire.createMetadataEntries({
          interception,
          interceptionContext: "/members/7",
          layoutIds: ["layout:/", "layout:/members"],
          rootLayoutTreePath: "/",
          routeId: "route:/members/7",
          slotBindings: [
            {
              activeRouteId: "route:/photos/1",
              interceptionId: "interception:modal",
              interceptionSourceMatchedUrl: "/members/7",
              ownerLayoutId: "layout:/members",
              slotId: "slot:modal:/members",
              state: "active",
            },
          ],
        }),
        [AppElementsWire.keys.retainedElementIds]: ["page:/members/7"],
        "__vinext_route_head:route:/members/7": "photo head",
        "route:/members/7": "intercepted route",
        "slot:modal:/members": "photo modal",
      };
      const source: AppElements = {
        ...AppElementsWire.createMetadataEntries({
          interceptionContext: null,
          layoutIds: ["layout:/", "layout:/members"],
          rootLayoutTreePath: "/",
          routeId: "route:/members/7",
          slotBindings: [
            {
              activeRouteId: "route:/members/7",
              ownerLayoutId: "layout:/members",
              slotId: "slot:modal:/members",
              state: "active",
            },
            {
              activeRouteId: "route:/members/7",
              ownerLayoutId: "layout:/members",
              slotId: refreshedSlotId,
              state: "active",
            },
          ],
        }),
        "__vinext_route_head:route:/members/7": "member head",
        "__vinext_streaming_metadata_body:route:/members/7": "member body",
        "page:/members/7": "member page",
        "route:/members/7": "source route",
        "slot:modal:/members": "modal catch-all",
        [refreshedSlotId]: "member slot",
      };

      const result = mergeRefreshedParallelSlot(primary, source);
      expect(result["page:/members/7"]).toBe("member page");
      expect(result["slot:modal:/members"]).toBe("photo modal");
      expect(result["__vinext_route_head:route:/members/7"]).toBe("photo head");
      expect(Object.hasOwn(result, "__vinext_streaming_metadata_body:route:/members/7")).toBe(
        false,
      );
      expect(result["route:/members/7"]).toBe("intercepted route");
      const metadata = AppElementsWire.readMetadata(result);
      expect(metadata.slotBindings).toContainEqual(
        expect.objectContaining({
          activeRouteId: "route:/photos/1",
          slotId: "slot:modal:/members",
        }),
      );
      expect(metadata.retainedElementIds).toEqual(["page:/members/7"]);
    },
  );

  // A source whose @modal matches a catch-all renders it active from its own
  // URL, and an intercepted payload carries its own head when its metadata
  // differs. Neither may replace the intercepted payload's own render.
  it("supplies only the retained elements from a source render", () => {
    const interception = {
      sourceMatchedUrl: "/members/7",
      sourceRouteId: "route:/members/7",
      slotId: "slot:modal:/members",
      targetMatchedUrl: "/photos/1",
      targetRouteId: "route:/photos/1",
    };
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: { "slot:modal:/members": "photo modal" },
        interception,
        interceptionContext: "/members/7",
        layoutIds: ["layout:/", "layout:/members"],
        rootLayoutTreePath: "/",
        routeId: "route:/members/7",
        slotBindings: [
          {
            activeRouteId: "route:/photos/1",
            interceptionId: "interception:modal",
            interceptionSourceMatchedUrl: "/members/7",
            ownerLayoutId: "layout:/members",
            slotId: "slot:modal:/members",
            state: "active",
          },
        ],
      }),
      [AppElementsWire.keys.retainedElementIds]: ["page:/members/7"],
      "__vinext_route_head:route:/members/7": "photo head",
      "route:/members/7": "intercepted route",
      "slot:modal:/members": "photo modal",
    };
    const source: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          "page:/members/7": "member 7",
          "slot:modal:/members": "modal catch-all",
        },
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/members"],
        rootLayoutTreePath: "/",
        routeId: "route:/members/7",
        slotBindings: [
          {
            activeRouteId: "route:/members/7",
            ownerLayoutId: "layout:/members",
            slotId: "slot:modal:/members",
            state: "active",
          },
        ],
      }),
      "__vinext_route_head:route:/members/7": "member head",
      "page:/members/7": "member page",
      "route:/members/7": "source route",
      "slot:modal:/members": "modal catch-all",
    };

    const result = supplyRetainedElements(primary, source);
    expect(result["page:/members/7"]).toBe("member page");
    expect(result["slot:modal:/members"]).toBe("photo modal");
    expect(result["__vinext_route_head:route:/members/7"]).toBe("photo head");
    expect(result["route:/members/7"]).toBe("intercepted route");
    const metadata = AppElementsWire.readMetadata(result);
    expect(metadata.interception).toEqual(interception);
    expect(metadata.slotBindings).toEqual([
      expect.objectContaining({ activeRouteId: "route:/photos/1", slotId: "slot:modal:/members" }),
    ]);
    expect(metadata.bfcacheSegmentIdentities).toEqual({
      "page:/members/7": "member 7",
      "slot:modal:/members": "photo modal",
    });
  });

  it("supplies no streamed body beside a head the intercepted payload carries", () => {
    const metadata = (interception: boolean) =>
      AppElementsWire.createMetadataEntries({
        interception: interception
          ? {
              sourceMatchedUrl: "/members/7",
              sourceRouteId: "route:/members/7",
              slotId: "slot:modal:/members",
              targetMatchedUrl: "/photos/1",
              targetRouteId: "route:/photos/1",
            }
          : null,
        interceptionContext: interception ? "/members/7" : null,
        layoutIds: ["layout:/", "layout:/members"],
        rootLayoutTreePath: "/",
        routeId: "route:/members/7",
        slotBindings: [],
      });
    const bodyId = "__vinext_streaming_metadata_body:route:/members/7";
    const source: AppElements = {
      ...metadata(false),
      "__vinext_route_head:route:/members/7": "member head",
      [bodyId]: "member tags",
      "page:/members/7": "member page",
    };

    const withHead = supplyRetainedElements(
      {
        ...metadata(true),
        [AppElementsWire.keys.retainedElementIds]: ["page:/members/7", bodyId],
        "__vinext_route_head:route:/members/7": "photo head",
      },
      source,
    );
    expect(withHead["page:/members/7"]).toBe("member page");
    expect(withHead["__vinext_route_head:route:/members/7"]).toBe("photo head");
    expect(Object.hasOwn(withHead, bodyId)).toBe(false);

    // A payload that leaves the head to the client takes the pair together.
    const withoutHead = supplyRetainedElements(
      {
        ...metadata(true),
        [AppElementsWire.keys.retainedElementIds]: [
          "page:/members/7",
          "__vinext_route_head:route:/members/7",
          bodyId,
        ],
      },
      source,
    );
    expect(withoutHead["__vinext_route_head:route:/members/7"]).toBe("member head");
    expect(withoutHead[bodyId]).toBe("member tags");
  });

  it("supplies retained elements only from a render of the same route", () => {
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interception: {
          sourceMatchedUrl: "/members/7",
          sourceRouteId: "route:/members/7",
          slotId: "slot:modal:/members",
          targetMatchedUrl: "/photos/1",
          targetRouteId: "route:/photos/1",
        },
        interceptionContext: "/members/7",
        layoutIds: ["layout:/", "layout:/members"],
        rootLayoutTreePath: "/",
        routeId: "route:/members/7",
        slotBindings: [],
      }),
      [AppElementsWire.keys.retainedElementIds]: ["page:/members/7"],
    };
    const other: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/members"],
        rootLayoutTreePath: "/",
        routeId: "route:/members/8",
        slotBindings: [],
      }),
      "page:/members/7": "stale member page",
    };

    expect(mergeRefreshedParallelSlot(primary, other)).toBe(primary);
  });

  it("merges all successful active branches", async () => {
    await expect(
      resolveSupplementalRefreshes({
        merge: (current, supplemental) => [...current, ...supplemental],
        primary: Promise.resolve(["children"]),
        signal: new AbortController().signal,
        supplemental: [async () => ["modal"], async () => ["drawer"]],
      }),
    ).resolves.toEqual({
      degraded: false,
      value: ["children", "modal", "drawer"],
    });
  });

  it("keeps the primary payload atomically when one branch fails", async () => {
    await expect(
      resolveSupplementalRefreshes({
        merge: (current, supplemental) => [...current, ...supplemental],
        primary: Promise.resolve(["children"]),
        signal: new AbortController().signal,
        supplemental: [
          async () => ["modal"],
          async () => {
            throw new Error("drawer failed");
          },
        ],
      }),
    ).resolves.toEqual({ degraded: true, reason: "failed", value: ["children"] });
  });

  it("times out supplemental work without exposing a partial merge", async () => {
    vi.useFakeTimers();
    const result = resolveSupplementalRefreshes({
      merge: (current, supplemental) => [...current, ...supplemental],
      primary: Promise.resolve(["children"]),
      signal: new AbortController().signal,
      supplemental: [
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ],
      timeoutMs: 5,
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toEqual({
      degraded: true,
      reason: "timeout",
      value: ["children"],
    });
  });

  it("aborts supplemental work when a newer navigation wins", async () => {
    const coordinator = createSupplementalRefreshCoordinator();
    const refresh = coordinator.begin({ activeNavigationId: 4, startedNavigationId: 4 });
    const result = resolveSupplementalRefreshes({
      merge: (current, supplemental) => current + supplemental,
      primary: Promise.resolve("children"),
      signal: refresh.signal,
      supplemental: [
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ],
    });

    coordinator.abortAll();
    await expect(result).resolves.toEqual({
      degraded: true,
      reason: "aborted",
      value: "children",
    });
    refresh.finish();
  });

  it("rejects degraded router refreshes so recovery stays atomic", () => {
    for (const reason of ["failed", "timeout"] as const) {
      expect(() =>
        requireCompleteSupplementalRefresh({ degraded: true, reason, value: "children" }),
      ).toThrow(expect.objectContaining<Partial<SupplementalRefreshError>>({ reason }));
    }

    expect(requireCompleteSupplementalRefresh({ degraded: false, value: "children+modal" })).toBe(
      "children+modal",
    );
  });

  it("keeps the complete current tree and retries failed server-action fan-out", () => {
    expect(
      resolveServerActionSupplementalRefresh(
        { degraded: true, reason: "failed", value: "partial-primary" },
        "complete-current-tree",
      ),
    ).toEqual({ retry: true, value: "complete-current-tree" });
    expect(
      resolveServerActionSupplementalRefresh(
        { degraded: true, reason: "timeout", value: "partial-primary" },
        "complete-current-tree",
      ),
    ).toEqual({ retry: true, value: "complete-current-tree" });
  });

  it("does not retry a server-action fan-out cancelled by newer navigation", () => {
    expect(
      resolveServerActionSupplementalRefresh(
        { degraded: true, reason: "aborted", value: "partial-primary" },
        "complete-current-tree",
      ),
    ).toEqual({ retry: false, value: "complete-current-tree" });
    expect(
      resolveServerActionSupplementalRefresh(
        { degraded: false, value: "complete-refreshed-tree" },
        "complete-current-tree",
      ),
    ).toEqual({ retry: false, value: "complete-refreshed-tree" });
  });
});
