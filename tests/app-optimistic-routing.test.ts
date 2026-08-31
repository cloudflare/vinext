import { describe, expect, it } from "vite-plus/test";
import { createElement, Suspense } from "react";
import {
  AppElementsWire,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import {
  canCommitOptimisticRouteTemplate,
  createOptimisticRouteElements,
  createOptimisticRouteTemplate,
  getOptimisticPrefetchSourceKey,
  getOptimisticRouteTemplateKey,
  matchOptimisticRouteManifestRoute,
  resolveOptimisticNavigationParamsForHref,
  resolveOptimisticNavigationPayload,
  type OptimisticRouteTemplate,
} from "../packages/vinext/src/server/app-optimistic-routing.js";
import type {
  GraphVersion,
  RouteManifest,
  RouteManifestRoute,
  RouteManifestSlotBinding,
} from "../packages/vinext/src/routing/app-route-graph.js";
import {
  createNestedBfcacheSlotSegmentId,
  deriveBfcacheSegmentIdentity,
} from "../packages/vinext/src/server/bfcache-identity.js";

function route(input: {
  id: string;
  isDynamic: boolean;
  paramNames?: readonly string[];
  pattern: string;
  patternParts: readonly string[];
  slotIds?: readonly string[];
}): RouteManifestRoute {
  return {
    id: input.id,
    isDynamic: input.isDynamic,
    layoutIds: ["layout:/"],
    pageId: `page:${input.pattern}`,
    paramNames: [...(input.paramNames ?? [])],
    pattern: input.pattern,
    patternParts: [...input.patternParts],
    rootBoundaryId: null,
    rootParamNames: [],
    routeHandlerId: null,
    slotIds: [...(input.slotIds ?? [])],
    templateIds: [],
  };
}

function manifest(
  routes: readonly RouteManifestRoute[],
  slotBindings: readonly RouteManifestSlotBinding[] = [],
  layouts: readonly {
    id: string;
    paramNames: readonly string[];
    patternParts: readonly string[];
    rootBoundaryId: null;
    treePath: string;
  }[] = [],
): RouteManifest {
  return {
    graphVersion: "graph:test" as GraphVersion,
    segmentGraph: {
      boundaries: new Map(),
      defaults: new Map(),
      interceptions: new Map(),
      interceptionsBySlotId: new Map(),
      layouts: new Map(layouts.map((entry) => [entry.id, entry])),
      pages: new Map(),
      rootBoundaries: new Map(),
      routeHandlers: new Map(),
      routes: new Map(routes.map((entry) => [entry.id, entry])),
      slotBindings: new Map(slotBindings.map((entry) => [entry.id, entry])),
      slots: new Map(),
      templates: new Map(),
    },
  };
}

function blogManifest(): RouteManifest {
  return manifest([
    route({
      id: "route:/blog/featured",
      isDynamic: false,
      pattern: "/blog/featured",
      patternParts: ["blog", "featured"],
    }),
    route({
      id: "route:/blog/:slug",
      isDynamic: true,
      paramNames: ["slug"],
      pattern: "/blog/:slug",
      patternParts: ["blog", ":slug"],
    }),
  ]);
}

function dashboardManifestWithoutProfile(): RouteManifest {
  return manifest([
    route({
      id: "route:/dashboard/settings",
      isDynamic: false,
      pattern: "/dashboard/settings",
      patternParts: ["dashboard", "settings"],
    }),
    route({
      id: "route:/dashboard/:catchall+",
      isDynamic: true,
      paramNames: ["catchall"],
      pattern: "/dashboard/:catchall+",
      patternParts: ["dashboard", ":catchall+"],
    }),
  ]);
}

function createBlogElements(): AppElements {
  const routeId = AppElementsWire.encodeRouteId("/blog/post-1", null);
  const pageId = AppElementsWire.encodePageId("/blog/post-1", null);
  return {
    ...AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds: ["layout:/"],
      rootLayoutTreePath: "/",
      routeId,
    }),
    [pageId]: createElement("article", null, "Post 1"),
    [routeId]: createElement(
      Suspense,
      { fallback: createElement("p", { id: "loading-message" }, "Loading...") },
      createElement("main", null, "Page slot"),
    ),
  };
}

function createBlogLoadingShellElements(): AppElements {
  const routeId = AppElementsWire.encodeRouteId("/blog/post-1", null);
  const pageId = AppElementsWire.encodePageId("/blog/post-1", null);
  return {
    ...AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds: ["layout:/"],
      rootLayoutTreePath: "/",
      routeId,
    }),
    [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
    [pageId]: null,
    [routeId]: createElement("p", { id: "loading-message" }, "Loading post-1..."),
  };
}

function staticSettingsManifest(): RouteManifest {
  return manifest([
    route({
      id: "route:/settings",
      isDynamic: false,
      pattern: "/settings",
      patternParts: ["settings"],
    }),
  ]);
}

function createSettingsLoadingShellElements(): AppElements {
  const routeId = AppElementsWire.encodeRouteId("/settings", null);
  const pageId = AppElementsWire.encodePageId("/settings", null);
  return {
    ...AppElementsWire.createMetadataEntries({
      interceptionContext: null,
      layoutIds: ["layout:/"],
      rootLayoutTreePath: "/",
      routeId,
    }),
    [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
    [pageId]: null,
    [routeId]: createElement("p", { id: "loading-message" }, "Loading settings..."),
  };
}

describe("App Router optimistic routing", () => {
  it("matches dynamic route params while keeping static siblings authoritative", () => {
    const routes = blogManifest();

    expect(
      matchOptimisticRouteManifestRoute({
        basePath: "",
        href: "/blog/post-1.rsc?_rsc=abc",
        routeManifest: routes,
      }),
    ).toMatchObject({
      params: { slug: "post-1" },
      route: { id: "route:/blog/:slug" },
    });

    expect(
      matchOptimisticRouteManifestRoute({
        basePath: "",
        href: "/blog/featured",
        routeManifest: routes,
      })?.route.id,
    ).toBe("route:/blog/featured");
  });

  it("preserves dynamic route param key order", () => {
    const twoSegment = manifest([
      route({
        id: "route:/:category/:id",
        isDynamic: true,
        paramNames: ["category", "id"],
        pattern: "/:category/:id",
        patternParts: [":category", ":id"],
      }),
    ]);

    const twoMatch = matchOptimisticRouteManifestRoute({
      basePath: "",
      href: "/electronics/123",
      routeManifest: twoSegment,
    });
    expect(twoMatch).not.toBeNull();
    expect(Object.keys(twoMatch!.params)).toEqual(["category", "id"]);

    const threeSegment = manifest([
      route({
        id: "route:/:a/:b/:c",
        isDynamic: true,
        paramNames: ["a", "b", "c"],
        pattern: "/:a/:b/:c",
        patternParts: [":a", ":b", ":c"],
      }),
    ]);

    const threeMatch = matchOptimisticRouteManifestRoute({
      basePath: "",
      href: "/x/y/z",
      routeManifest: threeSegment,
    });
    expect(threeMatch).not.toBeNull();
    expect(Object.keys(threeMatch!.params)).toEqual(["a", "b", "c"]);
  });

  it("does not fall through from a known static subtree to a catch-all sibling", () => {
    expect(
      matchOptimisticRouteManifestRoute({
        basePath: "",
        href: "/dashboard/settings/profile",
        routeManifest: dashboardManifestWithoutProfile(),
      }),
    ).toBeNull();
  });

  it("creates loading-only optimistic elements from a learned dynamic route template", () => {
    const routeManifest = blogManifest();
    const elements = createBlogElements();
    const template = createOptimisticRouteTemplate({
      basePath: "",
      elements,
      href: "/blog/post-1.rsc?_rsc=abc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    expect(template).toMatchObject<Partial<OptimisticRouteTemplate>>({
      routeId: "route:/blog/:slug",
    });
    if (template === null) {
      throw new Error("Expected optimistic route template");
    }

    const pageId = AppElementsWire.encodePageId("/blog/post-1", null);
    const optimisticElements = createOptimisticRouteElements(template);
    expect(optimisticElements[pageId]).not.toBe(elements[pageId]);

    const navigationPayload = resolveOptimisticNavigationPayload({
      basePath: "",
      href: "/blog/post-2",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
      templates: new Map([
        [
          getOptimisticRouteTemplateKey({
            interceptionContext: null,
            mountedSlotsHeader: null,
            routeId: template.routeId,
          }),
          template,
        ],
      ]),
    });

    expect(navigationPayload?.params).toEqual({ slug: "post-2" });
    expect(navigationPayload?.elements[pageId]).not.toBe(elements[pageId]);
  });

  it("includes active parallel slot params in optimistic navigation payloads", () => {
    // Mirrors the immediate pre-dynamic-render assertion in Next.js:
    // test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts
    const slotId = "slot:/[teamID]/@slot";
    const routeManifest = manifest(
      [
        route({
          id: "route:/:teamID/sub/:folder",
          isDynamic: true,
          paramNames: ["teamID", "folder"],
          pattern: "/:teamID/sub/:folder",
          patternParts: [":teamID", "sub", ":folder"],
          slotIds: [slotId],
        }),
      ],
      [
        {
          defaultId: null,
          id: "route:/:teamID/sub/:folder::slot:/[teamID]/@slot",
          ownerLayoutId: "layout:/[teamID]",
          routeId: "route:/:teamID/sub/:folder",
          routeSegments: ["[...catchAll]"],
          slotId,
          slotParamNames: ["teamID", "catchAll"],
          slotPatternParts: [":teamID", ":catchAll+"],
          state: "active",
        },
      ],
    );
    const elements = createBlogLoadingShellElements();
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements,
      href: "/vercel/sub/folder.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) {
      throw new Error("Expected optimistic route template");
    }

    const navigationPayload = resolveOptimisticNavigationPayload({
      basePath: "",
      href: "/vercel/sub/other-folder",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
      templates: new Map([
        [
          getOptimisticRouteTemplateKey({
            interceptionContext: null,
            mountedSlotsHeader: null,
            routeId: template.routeId,
          }),
          template,
        ],
      ]),
    });

    expect(navigationPayload?.params).toEqual({
      teamID: "vercel",
      folder: "other-folder",
      catchAll: ["sub", "other-folder"],
    });
    expect(
      resolveOptimisticNavigationParamsForHref({
        basePath: "",
        href: "/vercel/sub/other-folder",
        routeManifest,
      }),
    ).toEqual({
      teamID: "vercel",
      folder: "other-folder",
      catchAll: ["sub", "other-folder"],
    });
  });

  it("learns optimistic templates from an implicit children slot", () => {
    const childrenSlotId = "slot:children:/blog";
    const routeManifest = manifest([
      route({
        id: "route:/blog/:slug",
        isDynamic: true,
        paramNames: ["slug"],
        pattern: "/blog/:slug",
        patternParts: ["blog", ":slug"],
        slotIds: [childrenSlotId],
      }),
    ]);
    const routeId = AppElementsWire.encodeRouteId("/blog/post-1", null);
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/blog"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [childrenSlotId]: createElement("article", null, "Post 1"),
      [routeId]: createElement(
        Suspense,
        { fallback: createElement("p", null, "Loading") },
        createElement("main", null, "Route"),
      ),
    };

    const template = createOptimisticRouteTemplate({
      basePath: "",
      elements,
      href: "/blog/post-1.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    expect(template?.pageElementIds).toEqual([childrenSlotId]);
    expect(createOptimisticRouteElements(template!)[childrenSlotId]).not.toBe(
      elements[childrenSlotId],
    );
  });

  it("does not learn routes without a loading boundary", () => {
    const routeManifest = blogManifest();
    const routeId = AppElementsWire.encodeRouteId("/blog/post-1", null);
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [routeId]: createElement("main", null, "No loading boundary"),
    };

    expect(
      createOptimisticRouteTemplate({
        basePath: "",
        elements,
        href: "/blog/post-1.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
      }),
    ).toBeNull();

    expect(
      createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: { ...elements, [routeId]: null },
        href: "/blog/post-1.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
      }),
    ).toBeNull();

    expect(
      createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: { ...elements, [AppElementsWire.encodePageId("/blog/post-1", null)]: null },
        href: "/blog/post-1.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
      }),
    ).toBeNull();
  });

  it("learns dynamic route templates from loading-shell prefetch payloads only when allowed", () => {
    const routeManifest = blogManifest();
    const elements = createBlogLoadingShellElements();

    expect(
      createOptimisticRouteTemplate({
        basePath: "",
        elements,
        href: "/blog/post-1.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
      }),
    ).toBeNull();

    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements,
      href: "/blog/post-1.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    expect(template).toMatchObject<Partial<OptimisticRouteTemplate>>({
      pageElementIds: [AppElementsWire.encodePageId("/blog/post-1", null)],
      routeId: "route:/blog/:slug",
    });
  });

  it("learns static route templates from loading-shell prefetch payloads", () => {
    const routeManifest = staticSettingsManifest();
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements: createSettingsLoadingShellElements(),
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    expect(template).toMatchObject<Partial<OptimisticRouteTemplate>>({
      pageElementIds: [AppElementsWire.encodePageId("/settings", null)],
      routeId: "route:/settings",
    });
    if (template === null) {
      throw new Error("Expected optimistic route template");
    }

    const navigationPayload = resolveOptimisticNavigationPayload({
      basePath: "",
      href: "/settings?tab=billing",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
      templates: new Map([
        [
          getOptimisticRouteTemplateKey({
            interceptionContext: null,
            mountedSlotsHeader: null,
            routeId: template.routeId,
          }),
          template,
        ],
      ]),
    });

    expect(navigationPayload?.params).toEqual({});
    expect(navigationPayload?.template).toBe(template);
  });

  // Ported from Next.js: test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
  it("does not commit an ancestor loading shell over a retained layout", () => {
    const rootLayoutId = AppElementsWire.encodeLayoutId("/");
    const sharedLayoutId = AppElementsWire.encodeLayoutId("/projects/[projectId]");
    const currentElements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: [rootLayoutId, sharedLayoutId],
        rootLayoutTreePath: "/",
        routeId: "route:/projects/alpha",
      }),
      [rootLayoutId]: createElement("div", null, "root"),
      [sharedLayoutId]: createElement("section", null, "shared layout"),
    };
    const loadingShellElements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: [rootLayoutId, sharedLayoutId],
        rootLayoutTreePath: "/",
        routeId: "route:/projects/alpha/activity",
      }),
      [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
      [rootLayoutId]: createElement("div", null, "root"),
      "page:/projects/:projectId/activity": null,
      "route:/projects/alpha/activity": createElement("p", null, "Loading"),
    };
    const routeManifest = manifest(
      [
        route({
          id: "route:/projects/:projectId/activity",
          isDynamic: true,
          paramNames: ["projectId"],
          pattern: "/projects/:projectId/activity",
          patternParts: ["projects", ":projectId", "activity"],
        }),
      ],
      [],
      [
        {
          id: sharedLayoutId,
          paramNames: ["projectId"],
          patternParts: ["projects", ":projectId"],
          rootBoundaryId: null,
          treePath: "/projects/[projectId]",
        },
      ],
    );
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements: loadingShellElements,
      href: "/projects/alpha/activity",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });
    if (template === null) {
      throw new Error("Expected optimistic route template");
    }

    expect(template.omittedLayoutIds).toEqual([sharedLayoutId]);
    expect(
      canCommitOptimisticRouteTemplate({
        currentElements,
        currentLayoutIds: [rootLayoutId, sharedLayoutId],
        currentParams: { projectId: "alpha" },
        routeManifest,
        targetRouteParams: { projectId: "alpha" },
        targetUrlParts: ["projects", "alpha", "activity"],
        template,
      }),
    ).toBe(false);
    expect(
      canCommitOptimisticRouteTemplate({
        currentElements,
        currentLayoutIds: [rootLayoutId, sharedLayoutId],
        currentParams: { projectId: "alpha" },
        routeManifest,
        targetRouteParams: { projectId: "beta" },
        targetUrlParts: ["projects", "beta", "activity"],
        template,
      }),
    ).toBe(true);

    const templates = new Map([
      [
        getOptimisticRouteTemplateKey({
          interceptionContext: null,
          mountedSlotsHeader: null,
          routeId: template.routeId,
        }),
        template,
      ],
    ]);
    for (const [href, projectId] of [
      ["/projects/a%2Fb/activity", "a%2Fb"],
      ["/projects/caf%C3%A9/activity", "caf%C3%A9"],
      ["/projects/a%252Fb/activity", "a%252Fb"],
      ["/projects/a%2561/activity", "a%2561"],
      ["/projects/a%25b/activity", "a%25b"],
    ]) {
      const encodedPayload = resolveOptimisticNavigationPayload({
        basePath: "",
        href,
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
        templates,
      });
      expect(encodedPayload?.params).toEqual({ projectId });
      expect(
        encodedPayload &&
          canCommitOptimisticRouteTemplate({
            currentElements,
            currentLayoutIds: [rootLayoutId, sharedLayoutId],
            currentParams: { projectId },
            routeManifest,
            targetRouteParams: encodedPayload.routeParams,
            targetUrlParts: encodedPayload.urlParts,
            template: encodedPayload.template,
          }),
      ).toBe(false);
    }
  });

  it("preserves raw encoded catch-all params in optimistic payloads", () => {
    const rootLayoutId = AppElementsWire.encodeLayoutId("/");
    const routeManifest = manifest([
      route({
        id: "route:/docs/:parts+",
        isDynamic: true,
        paramNames: ["parts"],
        pattern: "/docs/:parts+",
        patternParts: ["docs", ":parts+"],
      }),
    ]);
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: [rootLayoutId],
        rootLayoutTreePath: "/",
        routeId: "route:/docs/source",
      }),
      [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
      [rootLayoutId]: createElement("div", null, "root"),
      "page:/docs/:parts+": null,
      "route:/docs/source": createElement("p", null, "Loading"),
    };
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements,
      href: "/docs/source",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });
    if (template === null) throw new Error("Expected optimistic route template");

    const payload = resolveOptimisticNavigationPayload({
      basePath: "",
      href: "/docs/a%2561/b%252Fc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
      templates: new Map([
        [
          getOptimisticRouteTemplateKey({
            interceptionContext: null,
            mountedSlotsHeader: null,
            routeId: template.routeId,
          }),
          template,
        ],
      ]),
    });

    expect(payload?.routeParams).toEqual({ parts: ["a%2561", "b%252Fc"] });
    expect(payload?.params).toEqual(payload?.routeParams);
  });

  it("does not commit a slot loading shell over a retained nested slot segment", () => {
    const rootLayoutId = AppElementsWire.encodeLayoutId("/");
    const sidebarSlotId = AppElementsWire.encodeSlotId("sidebar", "/");
    const nestedSegmentId = createNestedBfcacheSlotSegmentId(sidebarSlotId, 1);
    const routeId = "route:/:slug";
    const routeManifest = manifest(
      [
        route({
          id: routeId,
          isDynamic: true,
          paramNames: ["slug"],
          pattern: "/:slug",
          patternParts: [":slug"],
          slotIds: [sidebarSlotId],
        }),
      ],
      [
        {
          defaultId: null,
          id: `${routeId}::${sidebarSlotId}`,
          ownerLayoutId: rootLayoutId,
          routeId,
          routeSegments: ["[slug]"],
          slotId: sidebarSlotId,
          slotParamNames: ["slug"],
          slotPatternParts: [":slug"],
          state: "active",
        },
      ],
      [
        {
          id: rootLayoutId,
          paramNames: [],
          patternParts: [],
          rootBoundaryId: null,
          treePath: "/",
        },
      ],
    );
    const identityFor = (slug: string) =>
      deriveBfcacheSegmentIdentity({
        activeRouteGraphId: null,
        boundSegmentKey: JSON.stringify([`slug|${slug}|d`]),
        interceptionTargetRouteGraphId: null,
        kind: "slot",
        ownerLayoutGraphId: rootLayoutId,
        slotGraphId: sidebarSlotId,
        state: "active",
      });
    const currentElements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        bfcacheSegmentIdentities: { [nestedSegmentId]: identityFor("alpha") },
        interceptionContext: null,
        layoutIds: [rootLayoutId],
        rootLayoutTreePath: "/",
        routeId: "route:/alpha",
      }),
      [nestedSegmentId]: null,
      [rootLayoutId]: createElement("div", null, "root"),
    };
    const createTemplate = (sourceSlug: string, renderedSegment = false) => {
      const elements: AppElements = {
        ...AppElementsWire.createMetadataEntries({
          bfcacheSegmentIdentities: { [nestedSegmentId]: identityFor(sourceSlug) },
          interceptionContext: null,
          layoutIds: [rootLayoutId],
          rootLayoutTreePath: "/",
          routeId: `route:/${sourceSlug}`,
        }),
        [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
        [nestedSegmentId]: null,
        [rootLayoutId]: createElement("div", null, "root"),
        "page:/:slug": null,
        [`route:/${sourceSlug}`]: createElement(
          "div",
          renderedSegment ? { id: nestedSegmentId } : null,
          "Slot loading",
        ),
      };
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements,
        href: `/${sourceSlug}`,
        interceptionContext: null,
        mountedSlotsHeader: "sidebar",
        routeManifest,
      });
      if (template === null) throw new Error("Expected optimistic route template");
      return template;
    };

    // The learned shell came from beta, but the target/current route is alpha.
    // The commit check must reify the omitted segment identity for alpha rather
    // than comparing against the stale identity stored in the learned shell.
    const retainedTemplate = createTemplate("beta");
    expect(retainedTemplate.omittedBfcacheSegmentIds).toEqual([nestedSegmentId]);
    expect(
      canCommitOptimisticRouteTemplate({
        currentElements,
        currentLayoutIds: [rootLayoutId],
        currentParams: { slug: "alpha" },
        routeManifest,
        targetRouteParams: { slug: "alpha" },
        targetUrlParts: ["alpha"],
        template: retainedTemplate,
      }),
    ).toBe(false);

    expect(
      canCommitOptimisticRouteTemplate({
        currentElements,
        currentLayoutIds: [rootLayoutId],
        currentParams: { slug: "alpha" },
        routeManifest,
        targetRouteParams: { slug: "gamma" },
        targetUrlParts: ["gamma"],
        template: retainedTemplate,
      }),
    ).toBe(true);
    expect(createTemplate("beta", true).omittedBfcacheSegmentIds).toEqual([]);
  });

  it("reifies omitted empty slot branches", () => {
    const rootLayoutId = AppElementsWire.encodeLayoutId("/");
    const sidebarSlotId = AppElementsWire.encodeSlotId("sidebar", "/");
    const nestedSegmentId = createNestedBfcacheSlotSegmentId(sidebarSlotId, 1);
    const routeId = "route:/dashboard";
    const routeManifest = manifest(
      [
        route({
          id: routeId,
          isDynamic: false,
          pattern: "/dashboard",
          patternParts: ["dashboard"],
          slotIds: [sidebarSlotId],
        }),
      ],
      [
        {
          defaultId: "default:sidebar",
          id: `${routeId}::${sidebarSlotId}`,
          ownerLayoutId: rootLayoutId,
          routeId,
          routeSegments: null,
          slotId: sidebarSlotId,
          state: "default",
        },
      ],
      [
        {
          id: rootLayoutId,
          paramNames: [],
          patternParts: [],
          rootBoundaryId: null,
          treePath: "/",
        },
      ],
    );
    const identity = deriveBfcacheSegmentIdentity({
      activeRouteGraphId: null,
      boundSegmentKey: "",
      interceptionTargetRouteGraphId: null,
      kind: "slot",
      ownerLayoutGraphId: rootLayoutId,
      slotGraphId: sidebarSlotId,
      state: "default",
    });
    const metadata = AppElementsWire.createMetadataEntries({
      bfcacheSegmentIdentities: { [nestedSegmentId]: identity },
      interceptionContext: null,
      layoutIds: [rootLayoutId],
      rootLayoutTreePath: "/",
      routeId,
    });
    const currentElements: AppElements = {
      ...metadata,
      [nestedSegmentId]: null,
      [rootLayoutId]: createElement("div", null, "root"),
    };
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements: {
        ...metadata,
        [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
        [nestedSegmentId]: null,
        [rootLayoutId]: createElement("div", null, "root"),
        "page:/dashboard": null,
        [routeId]: createElement("p", null, "Loading"),
      },
      href: "/dashboard",
      interceptionContext: null,
      mountedSlotsHeader: "sidebar",
      routeManifest,
    });
    if (template === null) throw new Error("Expected optimistic route template");

    expect(
      canCommitOptimisticRouteTemplate({
        currentElements,
        currentLayoutIds: [rootLayoutId],
        currentParams: {},
        routeManifest,
        targetRouteParams: {},
        targetUrlParts: ["dashboard"],
        template,
      }),
    ).toBe(false);
  });

  it("keeps learned templates distinct across mounted slot headers", () => {
    const routeManifest = blogManifest();
    const slotATemplate = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements: createBlogLoadingShellElements(),
      href: "/blog/post-1.rsc",
      interceptionContext: null,
      mountedSlotsHeader: "modal",
      routeManifest,
    });
    const slotBTemplate = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements: createBlogLoadingShellElements(),
      href: "/blog/post-2.rsc",
      interceptionContext: null,
      mountedSlotsHeader: "drawer",
      routeManifest,
    });

    if (slotATemplate === null || slotBTemplate === null) {
      throw new Error("Expected optimistic route templates");
    }

    const templates = new Map([
      [
        getOptimisticRouteTemplateKey({
          interceptionContext: null,
          mountedSlotsHeader: "modal",
          routeId: slotATemplate.routeId,
        }),
        slotATemplate,
      ],
      [
        getOptimisticRouteTemplateKey({
          interceptionContext: null,
          mountedSlotsHeader: "drawer",
          routeId: slotBTemplate.routeId,
        }),
        slotBTemplate,
      ],
    ]);

    expect(
      resolveOptimisticNavigationPayload({
        basePath: "",
        href: "/blog/post-3",
        interceptionContext: null,
        mountedSlotsHeader: "modal",
        routeManifest,
        templates,
      })?.template,
    ).toBe(slotATemplate);
    expect(
      resolveOptimisticNavigationPayload({
        basePath: "",
        href: "/blog/post-3",
        interceptionContext: null,
        mountedSlotsHeader: "drawer",
        routeManifest,
        templates,
      })?.template,
    ).toBe(slotBTemplate);
  });

  it("scopes prefetch source learning by current router context", () => {
    const cacheKey = "/blog/post-1.rsc\0/feed";

    expect(
      getOptimisticPrefetchSourceKey({
        cacheKey,
        interceptionContext: "/feed",
        mountedSlotsHeader: "modal",
      }),
    ).not.toBe(
      getOptimisticPrefetchSourceKey({
        cacheKey,
        interceptionContext: "/gallery",
        mountedSlotsHeader: "modal",
      }),
    );
    expect(
      getOptimisticPrefetchSourceKey({
        cacheKey,
        interceptionContext: "/feed",
        mountedSlotsHeader: "modal",
      }),
    ).not.toBe(
      getOptimisticPrefetchSourceKey({
        cacheKey,
        interceptionContext: "/feed",
        mountedSlotsHeader: "drawer",
      }),
    );
  });

  it("does not learn or resolve optimistic payloads for intercepted contexts", () => {
    const routeManifest = blogManifest();
    const elements = createBlogLoadingShellElements();

    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements,
      href: "/blog/post-1.rsc",
      interceptionContext: "/feed",
      mountedSlotsHeader: null,
      routeManifest,
    });

    expect(template).toBeNull();
    expect(
      resolveOptimisticNavigationPayload({
        basePath: "",
        href: "/blog/post-2",
        interceptionContext: "/feed",
        mountedSlotsHeader: null,
        routeManifest,
        templates: new Map(),
      }),
    ).toBeNull();
  });
});
