import { describe, expect, it } from "vite-plus/test";
import { createElement, Fragment, isValidElement, Suspense } from "react";
import {
  AppElementsWire,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import {
  createOptimisticRouteElements,
  createOptimisticRouteTemplate,
  getOptimisticPrefetchSourceKey,
  getOptimisticRouteTemplateKey,
  matchOptimisticRouteManifestRoute,
  prepareOptimisticRouteTemplate,
  resolveOptimisticNavigationPayload,
  type OptimisticRouteTemplate,
} from "../packages/vinext/src/server/app-optimistic-routing.js";
import type {
  GraphVersion,
  RouteManifest,
  RouteManifestRoute,
  RouteManifestSlotBinding,
} from "../packages/vinext/src/routing/app-route-graph.js";

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
): RouteManifest {
  return {
    graphVersion: "graph:test" as GraphVersion,
    segmentGraph: {
      boundaries: new Map(),
      defaults: new Map(),
      interceptions: new Map(),
      interceptionsBySlotId: new Map(),
      layouts: new Map(),
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

  it("preserves runtime-prefetch page content while suspending its innermost boundary", () => {
    const routeManifest = manifest([
      route({
        id: "route:/runtime/:itemId",
        isDynamic: true,
        paramNames: ["itemId"],
        pattern: "/runtime/:itemId",
        patternParts: ["runtime", ":itemId"],
      }),
    ]);
    const layoutId = AppElementsWire.encodeLayoutId("/");
    const routeId = AppElementsWire.encodeRouteId("/runtime/phone", null);
    const pageId = AppElementsWire.encodePageId("/runtime/phone", null);
    const layout = createElement("div", { "data-layout": true }, "Cached layout");
    const staticContent = createElement("div", { "data-static": true }, "Static content");
    const innerSuspense = createElement(
      Suspense,
      { fallback: createElement("p", { id: "page-loading" }, "Loading item details") },
      createElement("div", { "data-dynamic": true }, "Stale item"),
    );
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: [layoutId],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [layoutId]: layout,
      [pageId]: createElement("section", null, staticContent, innerSuspense),
      [routeId]: createElement("main", null, "Route"),
    };

    const template = createOptimisticRouteTemplate({
      basePath: "",
      dynamicSuspenseOrdinals: [0],
      elements,
      href: "/runtime/phone.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      preservePageElements: true,
      routeManifest,
      variantKey: "runtime:phone",
    });
    expect(template?.pageElementIds).toEqual([pageId]);

    const optimisticElements = createOptimisticRouteElements(template!);
    expect(optimisticElements[layoutId]).toBe(layout);
    const pageElement = optimisticElements[pageId];
    expect(isValidElement(pageElement)).toBe(true);
    if (!isValidElement(pageElement)) return;
    const children = (pageElement.props as { children: unknown }).children;
    expect(Array.isArray(children)).toBe(true);
    if (!Array.isArray(children)) return;
    expect(children[0]).toBe(staticContent);
    expect(children[1]).not.toBe(innerSuspense);
    const suspense = children[1];
    expect(isValidElement(suspense)).toBe(true);
    if (!isValidElement(suspense)) return;
    expect((suspense.props as { fallback: unknown }).fallback).toBe(
      (innerSuspense.props as { fallback: unknown }).fallback,
    );
  });

  it("resolves static RSC lazy chunks but stops at the observed dynamic boundary", async () => {
    const routeManifest = manifest([
      route({
        id: "route:/runtime/:itemId",
        isDynamic: true,
        paramNames: ["itemId"],
        pattern: "/runtime/:itemId",
        patternParts: ["runtime", ":itemId"],
      }),
    ]);
    const routeId = AppElementsWire.encodeRouteId("/runtime/phone", null);
    const pageId = AppElementsWire.encodePageId("/runtime/phone", null);
    const loading = createElement("p", { id: "page-loading" }, "Loading item details");
    const withChildren = <T>(element: T, children: unknown): T => ({
      ...element,
      props: { ...(element as { props: object }).props, children },
    });
    let dynamicInitCalls = 0;
    const dynamicLazy = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: null,
      _init() {
        dynamicInitCalls += 1;
        throw new Promise<never>(() => {});
      },
    };
    const staticLazy = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: null,
      _init() {
        const dynamicBoundary = withChildren(
          createElement(Suspense, { fallback: loading }),
          dynamicLazy,
        );
        return createElement(
          Fragment,
          null,
          createElement("div", { "data-static": true }, "Static content"),
          dynamicBoundary,
        );
      },
    };
    const pageLazy = {
      $$typeof: Symbol.for("react.lazy"),
      _payload: null,
      _init() {
        const outerBoundary = withChildren(
          createElement(Suspense, { fallback: createElement("p", null, "Loading page") }),
          staticLazy,
        );
        return createElement("section", null, outerBoundary);
      },
    };
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: pageLazy as never,
      [routeId]: createElement("main", null, "Route"),
    };
    const template = createOptimisticRouteTemplate({
      basePath: "",
      dynamicSuspenseOrdinals: [1],
      elements,
      href: "/runtime/phone.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      preservePageElements: true,
      routeManifest,
    });

    const prepared = await prepareOptimisticRouteTemplate(template!);
    const page = createOptimisticRouteElements(prepared)[pageId];
    expect(prepared.pageElementsPrepared).toBe(true);
    expect(dynamicInitCalls).toBe(0);
    expect(isValidElement(page)).toBe(true);
    if (!isValidElement(page)) return;
    const outer = (page.props as { children: unknown }).children;
    expect(isValidElement(outer)).toBe(true);
    if (!isValidElement(outer)) return;
    const fragment = (outer.props as { children: unknown }).children;
    expect(isValidElement(fragment)).toBe(true);
    if (!isValidElement(fragment)) return;
    const children = (fragment.props as { children: unknown }).children;
    expect(Array.isArray(children)).toBe(true);
    if (!Array.isArray(children)) return;
    const dynamicBoundary = children[1];
    expect(isValidElement(dynamicBoundary)).toBe(true);
    if (!isValidElement(dynamicBoundary)) return;
    expect((dynamicBoundary.props as { fallback: unknown }).fallback).toBe(loading);
    expect((dynamicBoundary.props as { children: unknown }).children).not.toBe(dynamicLazy);
  });

  it("preserves cached Suspense siblings and replaces only the observed dynamic hole", () => {
    const routeManifest = manifest([
      route({
        id: "route:/runtime/:itemId",
        isDynamic: true,
        paramNames: ["itemId"],
        pattern: "/runtime/:itemId",
        patternParts: ["runtime", ":itemId"],
      }),
    ]);
    const routeId = AppElementsWire.encodeRouteId("/runtime/phone", null);
    const pageId = AppElementsWire.encodePageId("/runtime/phone", null);
    const cachedSibling = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading cached sibling") },
      createElement("div", { "data-cached": true }, "Cached sibling"),
    );
    const dynamicHole = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading dynamic hole") },
      createElement("div", { "data-dynamic": true }, "Stale dynamic content"),
    );
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement("section", null, cachedSibling, dynamicHole),
      [routeId]: createElement("main", null, "Route"),
    };
    const template = createOptimisticRouteTemplate({
      basePath: "",
      dynamicSuspenseOrdinals: [1],
      elements,
      href: "/runtime/phone.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      preservePageElements: true,
      routeManifest,
    });

    const optimisticPage = createOptimisticRouteElements(template!)[pageId];
    expect(isValidElement(optimisticPage)).toBe(true);
    if (!isValidElement(optimisticPage)) return;
    const children = (optimisticPage.props as { children: unknown }).children;
    expect(Array.isArray(children)).toBe(true);
    if (!Array.isArray(children)) return;
    expect(children[0]).toBe(cachedSibling);
    expect(children[1]).not.toBe(dynamicHole);
    const replacedHole = children[1];
    expect(isValidElement(replacedHole)).toBe(true);
    if (!isValidElement(replacedHole)) return;
    expect((replacedHole.props as { fallback: unknown }).fallback).toBe(
      (dynamicHole.props as { fallback: unknown }).fallback,
    );
  });

  it("scopes dynamic Suspense ordinals to each rendered page element", () => {
    const childrenSlotId = AppElementsWire.encodeSlotId("children", "/parallel");
    const routeManifest = manifest([
      route({
        id: "route:/runtime/:itemId",
        isDynamic: true,
        paramNames: ["itemId"],
        pattern: "/runtime/:itemId",
        patternParts: ["runtime", ":itemId"],
        slotIds: [childrenSlotId],
      }),
    ]);
    const routeId = AppElementsWire.encodeRouteId("/runtime/phone", null);
    const pageId = AppElementsWire.encodePageId("/runtime/phone", null);
    const mainBoundary = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading main") },
      createElement("div", null, "Stale main"),
    );
    const slotBoundary = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading slot") },
      createElement("div", null, "Cached slot"),
    );
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: mainBoundary,
      [childrenSlotId]: slotBoundary,
      [routeId]: createElement("main", null, "Route"),
    };

    const template = createOptimisticRouteTemplate({
      basePath: "",
      dynamicSuspenseOrdinals: [0],
      dynamicSuspenseOrdinalsByPageElementId: {
        [childrenSlotId]: [],
        [pageId]: [0],
      },
      elements,
      href: "/runtime/phone.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      preservePageElements: true,
      routeManifest,
    });
    const optimistic = createOptimisticRouteElements(template!);

    expect(optimistic[pageId]).not.toBe(mainBoundary);
    expect(optimistic[childrenSlotId]).toBe(slotBoundary);
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

    expect(
      createOptimisticRouteTemplate({
        basePath: "",
        elements: {
          ...elements,
          [AppElementsWire.encodePageId("/blog/post-1", null)]: null,
        },
        href: "/blog/post-1.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        preservePageElements: true,
        routeManifest,
        variantKey: "runtime\0loading",
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
