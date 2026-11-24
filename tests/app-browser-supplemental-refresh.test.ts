import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createInterceptionSourceRefreshMerge,
  createSupplementalRefreshCoordinator,
  mergeInterceptionSourceRefresh,
  mergeRefreshedParallelSlot,
  requireCompleteSupplementalRefresh,
  resolvePersistedRefreshInterceptions,
  resolvePersistedSourcePageRefreshes,
  resolveServerActionSupplementalRefresh,
  resolveSupplementalRefreshes,
  SupplementalRefreshError,
  supplyRetainedElements,
  takesSupplementalRefreshes,
} from "../packages/vinext/src/server/app-browser-supplemental-refresh.js";
import {
  AppElementsWire,
  bindAppElementsSlotRefreshPathname,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import { holdsInterceptionSourceTree } from "../packages/vinext/src/server/app-retained-elements.js";
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

  // An intercept opened from an unmatched URL's not-found page names
  // /_not-found as its source, and renders the intercepting route whole: it
  // keeps no page of that source to fetch.
  it("fetches no source page for an intercept opened from a not-found page", () => {
    for (const basePath of ["", "/docs"]) {
      expect(
        resolvePersistedSourcePageRefreshes({
          basePath,
          refreshUrl: new URL(`https://example.com${basePath}/photos/1`),
          state: { previousNextUrl: `${basePath}/_not-found`, slotBindings: [] },
        }),
      ).toEqual([]);
    }
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/photos/1"),
        state: { previousNextUrl: "/docs/feed", slotBindings: [] },
      }),
    ).toEqual(["/docs/feed"]);
  });

  // The whole intercepting route renders for a source that shares none of its
  // tree. A refresh of its entry asks for that source's page too, as for an
  // intercepted entry, but none of it merges into the whole route, whose
  // pathname-keyed entries the source page would otherwise overwrite.
  it("merges nothing into a payload of the whole intercepting route", async () => {
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: "/club/static",
        layoutIds: ["layout:/", "layout:/club/[slug]"],
        rootLayoutTreePath: "/",
        routeId: "route:/club/static/pics/1",
        slotBindings: [
          {
            activeRouteId: "route:/club/static/pics/1",
            ownerLayoutId: "layout:/club/[slug]",
            slotId: "slot:modal:/club/[slug]",
            state: "active",
          },
        ],
        wholeInterceptionSource: "/club/static",
      }),
      "page:/club/static/pics/1": "club default",
      "route:/club/static/pics/1": "club layout",
      "slot:modal:/club/[slug]": "pic modal",
    };
    const sourcePage: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/club/static",
        slotBindings: [
          {
            activeRouteId: "route:/club/static",
            ownerLayoutId: "layout:/",
            refreshPathname: "/club/static",
            slotId: "slot:children:/",
            state: "active",
          },
        ],
      }),
      "page:/club/static": "static club",
      "route:/club/static": "static route",
      "slot:children:/": "static tree",
    };

    expect(mergeRefreshedParallelSlot(primary, sourcePage)).toBe(primary);
    // A mark naming a source other than the payload's context counts for nothing.
    expect(
      AppElementsWire.readMetadata({
        ...primary,
        [AppElementsWire.keys.wholeInterceptionSource]: "/club/other",
      }).wholeInterceptionSource,
    ).toBeNull();

    // A refresh of a state showing it fetches no source page, while an
    // ordinary intercept's state still fetches its own.
    const refreshUrl = new URL("https://example.com/club/static/pics/1");
    const refreshState = { previousNextUrl: "/club/static", slotBindings: [] };
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "",
        refreshUrl,
        state: { ...refreshState, elements: primary },
      }),
    ).toEqual([]);
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "",
        refreshUrl,
        state: {
          ...refreshState,
          elements: { ...primary, [AppElementsWire.keys.wholeInterceptionSource]: "/club/other" },
        },
      }),
    ).toEqual(["/club/static"]);

    // A traversal learns it from the payload: a source page it fetched can
    // neither fail it nor merge into it.
    let sourceSignal: AbortSignal | undefined;
    const sourceRefresh = (signal: AbortSignal) => {
      sourceSignal = signal;
      return new Promise<AppElements>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    await expect(
      resolveSupplementalRefreshes({
        merge: mergeRefreshedParallelSlot,
        mergesInto: takesSupplementalRefreshes,
        primary: Promise.resolve(primary),
        signal: new AbortController().signal,
        supplemental: [sourceRefresh],
      }),
    ).resolves.toEqual({ degraded: false, value: primary });
    expect(sourceSignal?.aborted).toBe(true);
    await expect(
      resolveSupplementalRefreshes({
        merge: mergeRefreshedParallelSlot,
        mergesInto: takesSupplementalRefreshes,
        primary: Promise.resolve(primary),
        signal: new AbortController().signal,
        supplemental: [() => Promise.reject(new Error("source refresh failed"))],
      }),
    ).resolves.toEqual({ degraded: false, value: primary });
  });

  // A slot of a layout the whole intercepting route shares with the client's
  // tree, with only a default there, is left for the client to keep. A
  // refresh fetches it from the URL it was rendered at, as Next.js refetches
  // a reused segment, and merges that slot alone: none of the source's own
  // tree goes into the whole route.
  it("takes only the slots the whole intercepting route left for the client", async () => {
    const sidebarSegmentId = createNestedBfcacheSlotSegmentId("slot:sidebar:/", 1);
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: { [sidebarSegmentId]: "sidebar default" },
        interceptionContext: "/club/static",
        layoutIds: ["layout:/", "layout:/club/[slug]"],
        rootLayoutTreePath: "/",
        routeId: "route:/club/static/pics/1",
        slotBindings: [
          {
            activeRouteId: "route:/club/static/pics/1",
            ownerLayoutId: "layout:/club/[slug]",
            slotId: "slot:modal:/club/[slug]",
            state: "active",
          },
          { ownerLayoutId: "layout:/", slotId: "slot:sidebar:/", state: "default" },
        ],
        wholeInterceptionSource: "/club/static",
      }),
      [sidebarSegmentId]: "sidebar default segment",
      "page:/club/static/pics/1": "club default",
      "slot:children:/": "club layout",
      "slot:modal:/club/[slug]": "pic modal",
    };
    const renderOf = (pathname: string, sidebar: string): AppElements =>
      bindAppElementsSlotRefreshPathname(
        {
          ...AppElementsWire.createMetadataEntries({
            bfcacheSegmentIdentities: { [sidebarSegmentId]: `${sidebar} identity` },
            interceptionContext: null,
            layoutIds: ["layout:/"],
            rootLayoutTreePath: "/",
            routeId: `route:${pathname}`,
            slotBindings: [
              {
                activeRouteId: `route:${pathname}`,
                ownerLayoutId: "layout:/",
                slotId: "slot:children:/",
                state: "active",
              },
              {
                activeRouteId: `route:${pathname}`,
                ownerLayoutId: "layout:/",
                slotId: "slot:sidebar:/",
                state: "active",
              },
            ],
          }),
          [sidebarSegmentId]: `${sidebar} segment`,
          [`page:${pathname}`]: "source's page",
          "slot:children:/": "source tree",
          "slot:sidebar:/": sidebar,
        },
        pathname,
      );
    const staticRender = renderOf("/club/static", "sidebar static");
    const alphaRender = renderOf("/club/alpha", "sidebar alpha");
    const keptSlotPathnames = new Map([
      ["slot:children:/", "/club/static/pics/1"],
      ["slot:sidebar:/", "/club/static"],
    ]);

    const merged = mergeRefreshedParallelSlot(primary, staticRender, keptSlotPathnames);
    expect(merged["slot:sidebar:/"]).toBe("sidebar static");
    expect(merged[sidebarSegmentId]).toBe("sidebar static segment");
    expect(merged["slot:children:/"]).toBe("club layout");
    expect(merged["page:/club/static/pics/1"]).toBe("club default");
    expect(merged["slot:modal:/club/[slug]"]).toBe("pic modal");
    expect(Object.hasOwn(merged, "page:/club/static")).toBe(false);
    const metadata = AppElementsWire.readMetadata(merged);
    expect(metadata.wholeInterceptionSource).toBe("/club/static");
    expect(metadata.bfcacheSegmentIdentities[sidebarSegmentId]).toBe("sidebar static identity");
    expect(metadata.slotBindings.find((binding) => binding.slotId === "slot:sidebar:/")).toEqual(
      expect.objectContaining({ refreshPathname: "/club/static", state: "active" }),
    );
    expect(
      metadata.slotBindings.find((binding) => binding.slotId === "slot:children:/"),
    ).toBeUndefined();

    // Another URL's render of the same slot, for other params, never fills it,
    // whichever render merges first.
    expect(mergeRefreshedParallelSlot(primary, alphaRender, keptSlotPathnames)).toBe(primary);
    for (const renders of [
      [alphaRender, staticRender],
      [staticRender, alphaRender],
    ]) {
      const result = renders.reduce(
        (current, render) => mergeRefreshedParallelSlot(current, render, keptSlotPathnames),
        primary,
      );
      expect(result["slot:sidebar:/"]).toBe("sidebar static");
    }
    // A render that leaves the slot out too supplies nothing.
    const { ["slot:sidebar:/"]: _omitted, ...withoutSidebar } = staticRender;
    expect(mergeRefreshedParallelSlot(primary, withoutSidebar, keptSlotPathnames)).toBe(primary);
    // An intercepted render supplies only the slot it intercepts.
    const interceptedRender: AppElements = {
      ...staticRender,
      ...AppElementsWire.createMetadataEntries({
        interception: {
          slotId: "slot:modal:/",
          sourceMatchedUrl: "/club/static",
          sourceRouteId: "route:/club/static",
          targetMatchedUrl: "/club/static/pics/2",
          targetRouteId: "route:/club/static/pics/2",
        },
        interceptionContext: "/club/static",
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId: "route:/club/static/pics/2",
        slotBindings: AppElementsWire.readMetadata(staticRender).slotBindings,
      }),
    };
    expect(mergeRefreshedParallelSlot(primary, interceptedRender, keptSlotPathnames)).toBe(primary);

    // The fan-out's render of the source's URL goes in through the source merge.
    const sourceMerge = createInterceptionSourceRefreshMerge({
      keptSlotPathnames,
      previousNextUrl: "/club/static",
      refreshUrl: new URL("https://example.com/club/static/pics/1"),
    });
    expect(takesSupplementalRefreshes(primary)).toBe(true);
    expect(sourceMerge.takes("/club/static", primary)).toBe(true);
    await expect(
      resolveSupplementalRefreshes({
        merge: sourceMerge.merge,
        mergesInto: takesSupplementalRefreshes,
        primary: Promise.resolve(primary),
        signal: new AbortController().signal,
        supplemental: [
          async () => alphaRender,
          async () => sourceMerge.track("/club/static", staticRender),
        ],
      }).then((result) => result.value["slot:sidebar:/"]),
    ).resolves.toBe("sidebar static");
    // A failed render degrades the refresh, as for any payload that takes one.
    await expect(
      resolveSupplementalRefreshes({
        merge: sourceMerge.merge,
        mergesInto: takesSupplementalRefreshes,
        primary: Promise.resolve(primary),
        signal: new AbortController().signal,
        supplemental: [() => Promise.reject(new Error("source refresh failed"))],
      }),
    ).resolves.toEqual(expect.objectContaining({ degraded: true, value: primary }));

    // Only a render that can fill a left slot is waited for: another URL's
    // or an intercept's request is cancelled, so it can't fail the refresh.
    expect(sourceMerge.takes("/club/alpha", primary)).toBe(false);
    const signals: AbortSignal[] = [];
    const failing = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<AppElements>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const primaryPromise = Promise.resolve(primary);
    const gated = await resolveSupplementalRefreshes({
      merge: sourceMerge.merge,
      mergesInto: takesSupplementalRefreshes,
      primary: primaryPromise,
      signal: new AbortController().signal,
      supplemental: [
        sourceMerge.load("/club/alpha", primaryPromise, failing),
        sourceMerge.loadIntercepted(primaryPromise, failing),
        sourceMerge.load("/club/static", primaryPromise, async () => staticRender),
      ],
    });
    expect(gated.degraded).toBe(false);
    expect(gated.value["slot:sidebar:/"]).toBe("sidebar static");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);

    // A traversal starts from another entry, which names no URL a slot was
    // kept from: only the render of the source fills a left slot.
    const traversalMerge = createInterceptionSourceRefreshMerge({
      keptSlotPathnames: null,
      previousNextUrl: "/club/static",
      refreshUrl: new URL("https://example.com/club/static/pics/1"),
    });
    expect(traversalMerge.takes("/club/alpha", primary)).toBe(false);
    expect(traversalMerge.takes("/club/static", primary)).toBe(true);
    expect(traversalMerge.merge(primary, traversalMerge.track("/club/alpha", alphaRender))).toBe(
      primary,
    );
    expect(
      traversalMerge.merge(primary, traversalMerge.track("/club/static", staticRender))[
        "slot:sidebar:/"
      ],
    ).toBe("sidebar static");

    // A base path is left out of the URL a slot was kept from.
    const basePathMerge = createInterceptionSourceRefreshMerge({
      basePath: "/docs",
      keptSlotPathnames,
      previousNextUrl: "/docs/club/static",
      refreshUrl: new URL("https://example.com/docs/club/static/pics/1"),
    });
    expect(basePathMerge.takes("/docs/club/static", primary)).toBe(true);
    expect(basePathMerge.takes("/docs/club/alpha", primary)).toBe(false);

    // Once it holds the slot, the whole route takes nothing more.
    expect(takesSupplementalRefreshes(merged)).toBe(false);
    expect(sourceMerge.takes("/club/static", merged)).toBe(false);
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

  // A caller drops a source-page refresh that names an interception target,
  // so both resolvers must name a retained modal by the same URL: the one it
  // was intercepted at, never its decoded route path.
  it("refreshes a retained intercepted slot at the URL it was intercepted at", () => {
    const interception: BrowserRouteManifestInterception = {
      id: "interception:slot:modal:/feed->/p/[slug]",
      ownerLayoutId: "layout:/",
      slotId: "slot:modal:/",
      sourcePatternParts: ["feed"],
      targetPatternParts: ["p", ":slug"],
      targetRouteId: "route:/p/:slug",
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
    const slotBindings = [
      {
        activeRouteId: "route:/about",
        ownerLayoutId: "layout:/",
        refreshPathname: "/about",
        slotId: "slot:children:/",
        state: "active" as const,
      },
      {
        // A slug requested as %25C3%25A9: its route id is decoded once.
        activeRouteId: "route:/p/%C3%A9",
        interceptionId: interception.id,
        interceptionSourceMatchedUrl: "/feed",
        ownerLayoutId: "layout:/",
        refreshPathname: "/p/%25C3%25A9",
        slotId: "slot:modal:/",
        state: "active" as const,
      },
    ];
    const refreshUrl = new URL("https://example.com/docs/about?tab=new");

    expect(
      resolvePersistedRefreshInterceptions({
        basePath: "/docs",
        refreshUrl,
        requestInterceptionContext: null,
        routeManifest,
        state: { interception: null, slotBindings },
      }),
    ).toEqual([
      {
        interception,
        interceptionContext: "/feed",
        targetPathname: "/docs/p/%25C3%25A9?tab=new",
      },
    ]);
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "/docs",
        refreshUrl,
        state: { previousNextUrl: null, slotBindings },
      }),
    ).toEqual(["/docs/p/%25C3%25A9?tab=new"]);
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

  // A slot records the browser URL of the navigation that rendered it. Next.js
  // refetches a reused segment at that URL, and none whose URL is the current
  // one: packages/next/src/client/components/router-reducer/ppr-navigations.ts
  // (reuseActiveSegmentInDefaultSlot, accumulateRefreshUrl).
  it.each([
    { pathname: "/p/shoe", routeId: "route:/v1/p/shoe" },
    { pathname: "/p/caf%C3%A9", routeId: "route:/v1/p/café" },
    { pathname: "/p/%25C3%25A9", routeId: "route:/v1/p/%C3%A9" },
  ])(
    "does not refresh the slots of the page that middleware rewrote from $pathname",
    ({ pathname, routeId }) => {
      expect(
        resolvePersistedSourcePageRefreshes({
          basePath: "/docs",
          refreshUrl: new URL(`https://example.com/docs${pathname}`),
          state: {
            previousNextUrl: null,
            slotBindings: [
              {
                activeRouteId: routeId,
                ownerLayoutId: "layout:/",
                refreshPathname: pathname,
                slotId: "slot:children:/",
                state: "active",
              },
              {
                // A named slot's id holds the matched path as it came.
                activeRouteId: `route:/v1${pathname}`,
                ownerLayoutId: "layout:/",
                refreshPathname: pathname,
                slotId: "slot:info:/",
                state: "active",
              },
            ],
          },
        }),
      ).toEqual([]);
    },
  );

  it("refreshes a retained slot at the URL of the page that rendered it", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        basePath: "/docs",
        refreshUrl: new URL("https://example.com/docs/blog/new?tab=1"),
        state: {
          previousNextUrl: null,
          slotBindings: [
            {
              activeRouteId: "route:/blog/new",
              ownerLayoutId: "layout:/",
              refreshPathname: "/blog/new",
              slotId: "slot:children:/",
              state: "active",
            },
            {
              // /blog/%6Eew rendered the dynamic sibling of /blog/new. Its
              // route path names the static page, its URL the dynamic one.
              activeRouteId: "route:/blog/%6Eew",
              ownerLayoutId: "layout:/",
              refreshPathname: "/blog/%6Eew",
              slotId: "slot:info:/",
              state: "active",
            },
            {
              // A literal percent sign stays as the URL spelled it.
              activeRouteId: "route:/v1/p/%25C3%25A9",
              ownerLayoutId: "layout:/",
              refreshPathname: "/p/%25C3%25A9",
              slotId: "slot:aside:/",
              state: "active",
            },
            {
              // The visible URL, so middleware rewrites it again, never the
              // rewritten path.
              activeRouteId: "route:/v1/feed",
              ownerLayoutId: "layout:/",
              refreshPathname: "/feed",
              slotId: "slot:feed:/",
              state: "active",
            },
          ],
        },
      }),
    ).toEqual(["/docs/blog/%6Eew?tab=1", "/docs/p/%25C3%25A9?tab=1", "/docs/feed?tab=1"]);
  });

  it("never refreshes a retained path on another origin", () => {
    expect(
      resolvePersistedSourcePageRefreshes({
        activeRoutePaths: ["//other-origin.example/feed", "/feed"],
        basePath: "",
        refreshUrl: new URL("https://example.com/p/shoe"),
        state: { previousNextUrl: null, slotBindings: [] },
      }),
    ).toEqual(["/feed"]);
  });

  it("records a refresh pathname only on active slots that have none", () => {
    const elements: AppElements = AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds: ["layout:/"],
      rootLayoutTreePath: "/",
      routeId: "route:/p/shoe",
      slotBindings: [
        {
          activeRouteId: "route:/feed",
          ownerLayoutId: "layout:/",
          refreshPathname: "/feed",
          slotId: "slot:aside:/",
          state: "active",
        },
        {
          activeRouteId: "route:/p/shoe",
          ownerLayoutId: "layout:/",
          slotId: "slot:info:/",
          state: "active",
        },
        { ownerLayoutId: "layout:/", slotId: "slot:modal:/", state: "default" },
      ],
    });

    const bound = bindAppElementsSlotRefreshPathname(elements, "/p/shoe");
    expect(AppElementsWire.readMetadata(bound).slotBindings).toEqual([
      expect.objectContaining({ slotId: "slot:aside:/", refreshPathname: "/feed" }),
      expect.objectContaining({ slotId: "slot:info:/", refreshPathname: "/p/shoe" }),
      expect.not.objectContaining({ refreshPathname: expect.anything() }),
    ]);
    expect(AppElementsWire.readMetadata(elements).slotBindings[1]).not.toHaveProperty(
      "refreshPathname",
    );
    for (const pathname of ["//other-origin.example/x", "/\t/x", "/a\\b", "p/shoe"]) {
      expect(bindAppElementsSlotRefreshPathname(elements, pathname)).toBe(elements);
    }
    expect(() =>
      AppElementsWire.readMetadata({
        ...elements,
        [AppElementsWire.keys.slotBindings]: [
          {
            activeRouteId: "route:/feed",
            ownerLayoutId: "layout:/",
            refreshPathname: "//other-origin.example/feed",
            slotId: "slot:aside:/",
            state: "active",
          },
        ],
      }),
    ).toThrow("expected refresh pathnames");
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
      "__vinext_route_fallback:404:0:route:/drawer": "stale drawer not-found",
    };

    const drawerRefresh = mergeRefreshedParallelSlot(current, {
      ...metadata("route:/drawer", "slot:drawer:/", "route:/drawer"),
      "slot:drawer:/": "fresh drawer",
      "route:/drawer": "fresh drawer route",
      "__vinext_route_head:route:/drawer": "fresh drawer head",
      "__vinext_route_fallback:404:0:route:/drawer": "fresh drawer not-found",
    });
    expect(drawerRefresh["route:/drawer"]).toBe("fresh drawer route");
    expect(drawerRefresh["__vinext_route_head:route:/drawer"]).toBe("fresh drawer head");
    expect(drawerRefresh["__vinext_route_head:route:/"]).toBe("page head");
    // So do its boundary fallbacks.
    expect(drawerRefresh["__vinext_route_fallback:404:0:route:/drawer"]).toBe(
      "fresh drawer not-found",
    );

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
            refreshPathname: "/nested",
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
      // The promoted carrier is refetched where the source page came from.
      expect.objectContaining({
        refreshPathname: "/nested",
        slotId: "slot:children:/nested",
        state: "active",
      }),
      expect.objectContaining({ slotId: "slot:drawer:/nested", state: "active" }),
      expect.objectContaining({ slotId: "slot:modal:/nested", state: "active" }),
    ]);
  });

  // A payload the server did not intercept keeps its own layouts too, and a
  // layout it rendered without a segment identity takes none from the source.
  it("keeps the primary payload's own layouts when it promotes a source page", () => {
    const primary: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: { "layout:/": "primary root layout" },
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
        ],
      }),
      "layout:/": "primary root layout",
      "layout:/nested": "primary nested layout",
      "slot:children:/nested": AppElementsWire.unmatchedSlotValue,
    };
    const sourcePage: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: {
          "layout:/": "source root layout",
          "layout:/nested": "source nested layout",
        },
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
      "layout:/": "source root layout",
      "layout:/nested": "source nested layout",
      "slot:children:/": "fresh parent tree",
    };

    const result = mergeRefreshedParallelSlot(primary, sourcePage);

    expect(result["slot:children:/nested"]).toBe("fresh parent tree");
    expect(result["layout:/"]).toBe("primary root layout");
    expect(result["layout:/nested"]).toBe("primary nested layout");
    expect(AppElementsWire.readMetadata(result).bfcacheSegmentIdentities).toEqual({
      "layout:/": "primary root layout",
    });
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
    "keeps the intercepted payload's own head, layouts and modal when a source render refreshes %s",
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
          bfcacheSegmentIdentities: {
            "layout:/members": "members layout",
            "template:/": "root template",
          },
          interception,
          interceptionContext: "/members/7",
          layoutIds: ["layout:/", "layout:/members", "layout:/members/7"],
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
        // The segments below the slot's owner, the owner's own template
        // included, are the source's to keep.
        [AppElementsWire.keys.retainedElementIds]: [
          "page:/members/7",
          "layout:/members/7",
          "template:/members",
        ],
        "__vinext_route_head:route:/members/7": "photo head",
        "layout:/members": "members layout",
        "route:/members/7": "intercepted route",
        "slot:modal:/members": "photo modal",
        "template:/": "root template",
      };
      const source: AppElements = {
        ...AppElementsWire.createMetadataEntries({
          bfcacheSegmentIdentities: {
            "layout:/members": "source layout",
            "layout:/members/7": "member layout",
            "template:/": "source root template",
            "template:/members": "source template",
          },
          interceptionContext: null,
          layoutIds: ["layout:/", "layout:/members", "layout:/members/7"],
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
        "layout:/members": "source layout",
        "layout:/members/7": "member layout",
        "page:/members/7": "member page",
        "route:/members/7": "source route",
        "slot:modal:/members": "modal catch-all",
        "template:/": "source root template",
        "template:/members": "source template",
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
      // The layouts and templates the intercepted payload rendered from its own
      // request stay its own, as Next.js keeps each segment the refresh
      // rendered. The ones it left for the client to keep are the source's.
      expect(result["layout:/members"]).toBe("members layout");
      expect(result["template:/"]).toBe("root template");
      expect(result["layout:/members/7"]).toBe("member layout");
      expect(result["template:/members"]).toBe("source template");
      const metadata = AppElementsWire.readMetadata(result);
      expect(metadata.bfcacheSegmentIdentities).toMatchObject({
        "layout:/members": "members layout",
        "layout:/members/7": "member layout",
        "template:/": "root template",
        "template:/members": "source template",
      });
      expect(metadata.slotBindings).toContainEqual(
        expect.objectContaining({
          activeRouteId: "route:/photos/1",
          slotId: "slot:modal:/members",
        }),
      );
      expect(metadata.retainedElementIds).toEqual([
        "page:/members/7",
        "layout:/members/7",
        "template:/members",
      ]);
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

  describe("a traversal's render of its intercepted source page", () => {
    const interception = {
      sourceMatchedUrl: "/members/7",
      sourceRouteId: "route:/members/7",
      slotId: "slot:modal:/members",
      targetMatchedUrl: "/photos/1",
      targetRouteId: "route:/photos/1",
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
            ownerLayoutId: "layout:/",
            slotId: "slot:children:/",
            state: "active",
          },
          { ownerLayoutId: "layout:/members", slotId: "slot:modal:/members", state: "default" },
        ],
      }),
      "layout:/members": "members layout",
      "page:/members/7": "member page",
      "route:/members/7": "source route",
      "slot:children:/": "members children",
      "slot:modal:/members": "modal default",
    };

    function createIntercepted(overrides: Partial<typeof interception> = {}): AppElements {
      return {
        ...AppElementsWire.createMetadataEntries({
          interception: { ...interception, ...overrides },
          interceptionContext: "/members/7",
          layoutIds: ["layout:/", "layout:/members"],
          rootLayoutTreePath: "/",
          routeId: overrides.sourceRouteId ?? interception.sourceRouteId,
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
        [AppElementsWire.keys.retainedElementIds]: ["page:/members/7", "slot:children:/"],
        "route:/members/7": "intercepted route",
        "slot:modal:/members": "photo modal",
      };
    }

    it("goes beneath the intercept the server rendered for that source", () => {
      const result = mergeInterceptionSourceRefresh(createIntercepted(), source);

      expect(result["page:/members/7"]).toBe("member page");
      expect(result["slot:children:/"]).toBe("members children");
      expect(result["slot:modal:/members"]).toBe("photo modal");
      expect(AppElementsWire.readMetadata(result).interception).toEqual(interception);
    });

    // The server renders the target whole when it doesn't intercept it from
    // the entry's source, as when the history entry names another source.
    it("leaves a payload the server rendered without the intercept as it was", () => {
      const primary: AppElements = {
        ...AppElementsWire.createMetadataEntries({
          interceptionContext: null,
          layoutIds: ["layout:/"],
          rootLayoutTreePath: "/",
          routeId: "route:/photos/1",
          slotBindings: [
            {
              activeRouteId: "route:/photos/1",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
          ],
        }),
        "page:/photos/1": "photo page",
        "route:/photos/1": "photo route",
        "slot:children:/": "photo children",
      };

      expect(mergeInterceptionSourceRefresh(primary, source)).toBe(primary);
    });

    it("leaves an intercept proved for another source as it was", () => {
      const primary = createIntercepted({
        sourceMatchedUrl: "/members/8",
        sourceRouteId: "route:/members/8",
      });

      expect(mergeInterceptionSourceRefresh(primary, source)).toBe(primary);
    });

    // A refresh, a server action's re-render and a traversal each fan out to
    // the source page an intercepted state names, its previousNextUrl.
    describe("in a refresh fan-out", () => {
      const refreshUrl = new URL("https://example.com/photos/1");
      const photoPage: AppElements = {
        ...AppElementsWire.createMetadataEntries({
          interceptionContext: null,
          layoutIds: ["layout:/"],
          rootLayoutTreePath: "/",
          routeId: "route:/photos/1",
          slotBindings: [
            {
              activeRouteId: "route:/photos/1",
              ownerLayoutId: "layout:/",
              slotId: "slot:children:/",
              state: "active",
            },
          ],
        }),
        "page:/photos/1": "photo page",
        "route:/photos/1": "photo route",
        "slot:children:/": "photo children",
      };

      it("puts the source page beneath the intercept the server rendered for it", () => {
        const fanOut = createInterceptionSourceRefreshMerge({
          previousNextUrl: "/members/7",
          refreshUrl,
        });

        const result = fanOut.merge(createIntercepted(), fanOut.track("/members/7", source));

        expect(result["page:/members/7"]).toBe("member page");
        expect(result["slot:modal:/members"]).toBe("photo modal");
      });

      it.each([
        ["the server didn't intercept", () => photoPage],
        [
          "the server intercepted from another source",
          () =>
            createIntercepted({
              sourceMatchedUrl: "/members/8",
              sourceRouteId: "route:/members/8",
            }),
        ],
      ])("leaves the payload as it was when %s", (_case, createPrimary) => {
        const fanOut = createInterceptionSourceRefreshMerge({
          previousNextUrl: "/members/7",
          refreshUrl,
        });
        const primary = createPrimary();

        expect(fanOut.merge(primary, fanOut.track("/members/7", source))).toBe(primary);
      });

      it("merges the other branches it keeps as before", () => {
        const fanOut = createInterceptionSourceRefreshMerge({
          previousNextUrl: "/members/7",
          refreshUrl,
        });
        const branch = fanOut.track("/members/7/sidebar", source);

        expect(fanOut.merge(photoPage, branch)).toEqual(
          mergeRefreshedParallelSlot(photoPage, branch),
        );
      });

      // A sibling intercept renders the intercepting route's own page, with no
      // interception proof, so its entry's source page is never fetched for a
      // refresh, and a traversal back to it neither waits for nor fails with
      // one it started.
      it("takes no source page for a sibling intercept's payload", () => {
        const sibling: AppElements = {
          ...AppElementsWire.createMetadataEntries({
            interceptionContext: "/members/7",
            layoutIds: ["layout:/"],
            rootLayoutTreePath: "/",
            routeId: "route:/photos/1",
            sourcePage: "/members/(..)photos/[id]/page",
          }),
          "page:/photos/1": "photo modal page",
        };
        const state = { previousNextUrl: "/members/7", slotBindings: [] };
        expect(
          resolvePersistedSourcePageRefreshes({
            basePath: "",
            refreshUrl,
            state: { ...state, elements: sibling },
          }),
        ).toEqual([]);
        expect(
          resolvePersistedSourcePageRefreshes({
            basePath: "",
            refreshUrl,
            state: { ...state, elements: createIntercepted() },
          }),
        ).toEqual(["/members/7"]);

        const fanOut = createInterceptionSourceRefreshMerge({
          previousNextUrl: "/members/7",
          refreshUrl,
        });
        expect(fanOut.takes("/members/7", sibling)).toBe(false);
        expect(fanOut.takes("/members/7", createIntercepted())).toBe(true);
        expect(fanOut.takes("/members/7/sidebar", sibling)).toBe(true);
        expect(fanOut.merge(sibling, fanOut.track("/members/7", sibling))).toBe(sibling);
      });

      // The source page is fetched beside the payload. A payload that doesn't
      // take it, as a sibling intercept's, cancels that request rather than
      // leaving it running past the navigation.
      it("cancels the source page's request for a payload that doesn't take it", async () => {
        const sibling: AppElements = {
          ...AppElementsWire.createMetadataEntries({
            interceptionContext: "/members/7",
            layoutIds: ["layout:/"],
            rootLayoutTreePath: "/",
            routeId: "route:/photos/1",
            sourcePage: "/members/(..)photos/[id]/page",
          }),
        };
        const fanOut = createInterceptionSourceRefreshMerge({
          previousNextUrl: "/members/7",
          refreshUrl,
        });
        const start = (primary: Promise<AppElements>, response: Promise<AppElements>) => {
          const signals: AbortSignal[] = [];
          const navigation = new AbortController();
          const loaded = fanOut.load("/members/7", primary, (signal) => {
            signals.push(signal);
            return response;
          })(navigation.signal);
          return { loaded, navigation, signals };
        };

        // Fetched at once, before the payload arrives.
        let resolvePrimary!: (elements: AppElements) => void;
        const hanging = new Promise<AppElements>(() => {});
        const skipped = start(
          new Promise((resolve) => {
            resolvePrimary = resolve;
          }),
          hanging,
        );
        expect(skipped.signals).toHaveLength(1);
        resolvePrimary(sibling);
        const skippedRender = await skipped.loaded;
        expect(skipped.signals[0].aborted).toBe(true);
        expect(fanOut.merge(sibling, skippedRender)).toBe(sibling);

        // A payload with the intercept waits for it, and a later navigation
        // still cancels it.
        const intercepted = start(Promise.resolve(createIntercepted()), Promise.resolve(source));
        expect(fanOut.merge(createIntercepted(), await intercepted.loaded)["page:/members/7"]).toBe(
          "member page",
        );
        expect(intercepted.signals[0].aborted).toBe(false);
        const pending = start(Promise.resolve(createIntercepted()), hanging);
        pending.navigation.abort();
        expect(pending.signals[0].aborted).toBe(true);

        // A payload that fails cancels it too.
        const failed = start(Promise.reject(new Error("payload failed")), hanging);
        await expect(failed.loaded).rejects.toThrow("payload failed");
        expect(failed.signals[0].aborted).toBe(true);
      });
    });
  });

  describe("an intercepted payload's own source tree", () => {
    function createPayload(options: {
      elements?: AppElements;
      skippedLayoutIds?: readonly string[];
    }): AppElements {
      return {
        ...AppElementsWire.createMetadataEntries({
          interception: {
            sourceMatchedUrl: "/feed",
            sourceRouteId: "route:/feed",
            slotId: "slot:modal:/feed",
            targetMatchedUrl: "/photos/42",
            targetRouteId: "route:/photos/42",
          },
          interceptionContext: "/feed",
          layoutIds: ["layout:/", "layout:/feed"],
          rootLayoutTreePath: "/",
          routeId: "route:/feed",
          slotBindings: [
            {
              activeRouteId: "route:/photos/42",
              ownerLayoutId: "layout:/feed",
              slotId: "slot:modal:/feed",
              state: "active",
            },
          ],
        }),
        [AppElementsWire.keys.retainedElementIds]: ["page:/feed"],
        [AppElementsWire.keys.skippedLayoutIds]: options.skippedLayoutIds ?? [],
        "route:/feed": "intercepted route",
        "slot:modal:/feed": "photo modal",
        ...options.elements,
      };
    }

    it("is held once the payload carries the slot's layout and every retained element", () => {
      expect(
        holdsInterceptionSourceTree(
          createPayload({ elements: { "layout:/feed": "feed layout", "page:/feed": "feed" } }),
        ),
      ).toBe(true);
    });

    it.each([
      ["a retained element", { elements: { "layout:/feed": "feed layout" } }],
      ["the slot's layout", { elements: { "page:/feed": "feed" } }],
      [
        "a skipped layout",
        {
          elements: { "layout:/feed": "feed layout", "page:/feed": "feed" },
          skippedLayoutIds: ["layout:/"],
        },
      ],
    ])("is not held without %s", (_missing, options) => {
      expect(holdsInterceptionSourceTree(createPayload(options))).toBe(false);
    });
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
