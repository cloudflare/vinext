import { describe, expect, it } from "vite-plus/test";
import { createElement, isValidElement, Suspense, type ReactNode } from "react";
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
  resolveOptimisticNavigationPayload,
  type OptimisticRouteTemplate,
} from "../packages/vinext/src/server/app-optimistic-routing.js";
import type {
  GraphVersion,
  RouteManifest,
  RouteManifestRoute,
  RouteManifestSlotBinding,
} from "../packages/vinext/src/routing/app-route-graph.js";
import { isUnknownRecord } from "../packages/vinext/src/utils/record.js";

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

  it("preserves page-local fallbacks from an authoritative loading shell", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts
    const routeManifest = blogManifest();
    const elements = createBlogLoadingShellElements();
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements,
      href: "/blog/post-1.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    expect(template).not.toBeNull();
    expect(template?.preservePageElements).toBe(true);
    const pageId = AppElementsWire.encodePageId("/blog/post-1", null);
    expect(createOptimisticRouteElements(template!)[pageId]).toBe(elements[pageId]);
  });

  it("preserves page elements from an authoritative segment shell", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts
    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const resolvedLayoutPanel = createElement("p", null, "Resolved layout panel");
    const resolvedNestedFallback = createElement("p", null, "Resolved nested fallback");
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      "layout:/settings": createElement(
        "section",
        null,
        createElement(
          Suspense,
          { fallback: createElement("p", null, "Loading layout panel") },
          resolvedLayoutPanel,
        ),
      ),
      [pageId]: createElement(
        "main",
        null,
        createElement("p", null, "Static page content"),
        createElement(
          Suspense,
          {
            fallback: createElement(
              Suspense,
              { fallback: createElement("p", null, "Loading nested fallback") },
              resolvedNestedFallback,
            ),
          },
          createElement("p", null, "Resolved dynamic page"),
        ),
      ),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    expect(template).not.toBeNull();
    expect(template?.preservePageElements).toBe(true);
    expect(template?.suspendNestedBoundaries).toBe(true);
    const optimisticElements = createOptimisticRouteElements(template!);
    const optimisticPage = optimisticElements[pageId];
    expect(optimisticPage).not.toBe(elements[pageId]);
    expect(isValidElement(optimisticPage)).toBe(true);
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const children = Reflect.get(pageProps, "children");
    expect(Array.isArray(children)).toBe(true);
    const boundary = (children as unknown[])[1];
    expect(isValidElement(boundary) && boundary.type).toBe(Suspense);
    if (!isValidElement(boundary)) throw new Error("Expected a Suspense boundary");
    const boundaryProps = Reflect.get(boundary, "props");
    if (!isUnknownRecord(boundaryProps)) throw new Error("Expected Suspense boundary props");
    expect(isValidElement(Reflect.get(boundaryProps, "children"))).toBe(true);
    const optimisticFallback = Reflect.get(boundaryProps, "fallback");
    if (!isValidElement(optimisticFallback)) throw new Error("Expected an optimistic fallback");
    const optimisticFallbackProps = Reflect.get(optimisticFallback, "props");
    if (!isUnknownRecord(optimisticFallbackProps)) {
      throw new Error("Expected optimistic fallback props");
    }
    expect(Reflect.get(optimisticFallbackProps, "children")).not.toBe(resolvedNestedFallback);

    const optimisticLayout = optimisticElements["layout:/settings"];
    expect(optimisticLayout).not.toBe(elements["layout:/settings"]);
    if (!isValidElement(optimisticLayout)) throw new Error("Expected an optimistic layout");
    const layoutProps = Reflect.get(optimisticLayout, "props");
    if (!isUnknownRecord(layoutProps)) throw new Error("Expected optimistic layout props");
    const optimisticLayoutBoundary = Reflect.get(layoutProps, "children");
    if (!isValidElement(optimisticLayoutBoundary)) {
      throw new Error("Expected an optimistic layout boundary");
    }
    const optimisticLayoutBoundaryProps = Reflect.get(optimisticLayoutBoundary, "props");
    if (!isUnknownRecord(optimisticLayoutBoundaryProps)) {
      throw new Error("Expected optimistic layout boundary props");
    }
    expect(Reflect.get(optimisticLayoutBoundaryProps, "children")).not.toBe(resolvedLayoutPanel);
  });

  it("suspends boundaries in named ReactNode props without traversing circular data props", () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const resolvedDynamicPanel = createElement("p", null, "Resolved dynamic panel");
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading dynamic panel") },
      resolvedDynamicPanel,
    );
    const circularData: { self?: unknown; value: string } = { value: "data" };
    circularData.self = circularData;
    const circularPanelRecord: { panel: ReactNode; self?: unknown } = { panel };
    circularPanelRecord.self = circularPanelRecord;
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, {
        data: circularData,
        panel,
        panelRecord: circularPanelRecord,
      }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    expect(Reflect.get(pageProps, "data")).toBe(circularData);
    expect(circularData.self).toBe(circularData);

    const optimisticPanel = Reflect.get(pageProps, "panel");
    expect(isValidElement(optimisticPanel) && optimisticPanel.type).toBe(Suspense);
    if (!isValidElement(optimisticPanel)) throw new Error("Expected an optimistic panel");
    const panelProps = Reflect.get(optimisticPanel, "props");
    if (!isUnknownRecord(panelProps)) throw new Error("Expected optimistic panel props");
    expect(Reflect.get(panelProps, "children")).not.toBe(resolvedDynamicPanel);

    const optimisticPanelRecord = Reflect.get(pageProps, "panelRecord");
    expect(optimisticPanelRecord).not.toBe(circularPanelRecord);
    if (!isUnknownRecord(optimisticPanelRecord)) {
      throw new Error("Expected an optimistic panel record");
    }
    expect(Reflect.get(optimisticPanelRecord, "self")).toBe(optimisticPanelRecord);
    expect(Reflect.get(optimisticPanelRecord, "panel")).not.toBe(panel);
  });

  it("preserves fulfilled and pending thenable contracts in named ReactNode props", async () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const createPanel = (content: string) =>
      createElement(
        Suspense,
        { fallback: createElement("p", null, `Loading ${content}`) },
        createElement("p", null, content),
      );
    const fulfilledPanel = createPanel("fulfilled panel");
    const fulfilled = Object.assign(Promise.resolve(fulfilledPanel), {
      status: "fulfilled",
      value: fulfilledPanel,
    });
    let resolvePending: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePending = resolve;
    });
    void Object.defineProperty(pending, "status", {
      configurable: false,
      enumerable: true,
      value: "pending",
      writable: false,
    });
    void Object.preventExtensions(pending);
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { fulfilled, pending }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");

    const optimisticFulfilled = Reflect.get(pageProps, "fulfilled");
    expect(optimisticFulfilled).not.toBe(fulfilledPanel);
    if (
      (typeof optimisticFulfilled !== "object" && typeof optimisticFulfilled !== "function") ||
      optimisticFulfilled === null
    ) {
      throw new Error("Expected a fulfilled thenable");
    }
    expect(Reflect.get(optimisticFulfilled, "status")).toBe("fulfilled");
    const transformedFulfilledPanel = Reflect.get(optimisticFulfilled, "value");
    if (!isValidElement(transformedFulfilledPanel)) {
      throw new Error("Expected a transformed fulfilled panel");
    }
    const fulfilledProps = Reflect.get(transformedFulfilledPanel, "props");
    if (!isUnknownRecord(fulfilledProps)) throw new Error("Expected fulfilled panel props");
    expect(Reflect.get(fulfilledProps, "children")).not.toBe(fulfilledPanel.props.children);

    const optimisticPending = Reflect.get(pageProps, "pending");
    if (
      (typeof optimisticPending !== "object" && typeof optimisticPending !== "function") ||
      optimisticPending === null
    ) {
      throw new Error("Expected a pending thenable");
    }
    expect(typeof Reflect.get(optimisticPending, "then")).toBe("function");
    expect(Object.isExtensible(optimisticPending)).toBe(false);
    const pendingPanel = createPanel("pending panel");
    resolvePending?.(pendingPanel);
    const transformedPendingPanel = await (optimisticPending as Promise<unknown>);
    if (!isValidElement(transformedPendingPanel)) {
      throw new Error("Expected a transformed pending panel");
    }
    const pendingProps = Reflect.get(transformedPendingPanel, "props");
    if (!isUnknownRecord(pendingProps)) throw new Error("Expected pending panel props");
    expect(Reflect.get(pendingProps, "children")).not.toBe(pendingPanel.props.children);
    expect(Reflect.get(optimisticPending, "status")).toBe("fulfilled");
    expect(Reflect.get(optimisticPending, "value")).toBe(transformedPendingPanel);
    expect(await (optimisticPending as Promise<unknown>)).toBe(transformedPendingPanel);
  });

  it("suspends boundaries from unstamped pending ReactNode promises", async () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    let resolvePanel: ((value: ReactNode) => void) | undefined;
    const panelPromise = new Promise<ReactNode>((resolve) => {
      resolvePanel = resolve;
    });
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { panel: panelPromise }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticPanelPromise = Reflect.get(pageProps, "panel");
    expect(optimisticPanelPromise).not.toBe(panelPromise);

    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    resolvePanel?.(panel);
    const optimisticPanel = await (optimisticPanelPromise as Promise<ReactNode>);
    if (!isValidElement(optimisticPanel)) throw new Error("Expected an optimistic panel");
    const optimisticPanelProps = Reflect.get(optimisticPanel, "props");
    if (!isUnknownRecord(optimisticPanelProps)) {
      throw new Error("Expected optimistic panel props");
    }
    expect(Reflect.get(optimisticPanelProps, "children")).not.toBe(panel.props.children);
  });

  it("preserves fulfilled thenable prototypes and property descriptors", async () => {
    function Frame(): null {
      return null;
    }
    class PanelPromise extends Promise<ReactNode> {
      readonly #tag: string;

      static get [Symbol.species](): PromiseConstructor {
        return Promise;
      }

      constructor(
        executor: (
          resolve: (value: ReactNode | PromiseLike<ReactNode>) => void,
          reject: (reason?: unknown) => void,
        ) => void,
        tag: string,
      ) {
        if (tag !== "panel-promise") throw new Error("missing promise tag");
        super(executor);
        this.#tag = tag;
      }

      readTag(): string {
        return this.#tag;
      }
    }
    class SafePanelPromise extends Promise<ReactNode> {
      readonly #tag = "safe-panel-promise";

      readTag(): string {
        return this.#tag;
      }
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const metadataKey = Symbol("metadata");
    const fulfilled = new PanelPromise((resolve) => resolve(panel), "panel-promise");
    const safeFulfilled = Object.assign(new SafePanelPromise((resolve) => resolve(panel)), {
      status: "fulfilled",
      value: panel,
    });
    void Object.defineProperties(fulfilled, {
      status: { configurable: true, enumerable: true, value: "fulfilled", writable: true },
      value: { configurable: true, enumerable: true, value: panel, writable: true },
      hidden: { configurable: false, enumerable: false, value: "preserved", writable: false },
      catch: { configurable: false, enumerable: false, value: () => undefined, writable: false },
      finally: {
        configurable: false,
        enumerable: false,
        value: () => undefined,
        writable: false,
      },
      [metadataKey]: {
        configurable: true,
        enumerable: false,
        value: { source: "flight" },
        writable: false,
      },
    });
    void Object.freeze(fulfilled);
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { panel: fulfilled, safePanel: safeFulfilled }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticPanel = Reflect.get(pageProps, "panel") as Promise<unknown>;

    expect(optimisticPanel).not.toBe(fulfilled);
    expect(Object.getPrototypeOf(optimisticPanel)).toBe(Promise.prototype);
    expect(optimisticPanel).not.toBeInstanceOf(PanelPromise);
    expect(() => Promise.prototype.then.call(optimisticPanel, (value) => value)).not.toThrow();
    expect(Object.getOwnPropertyDescriptor(optimisticPanel, "hidden")).toEqual(
      Object.getOwnPropertyDescriptor(fulfilled, "hidden"),
    );
    expect(Object.getOwnPropertyDescriptor(optimisticPanel, metadataKey)).toEqual(
      Object.getOwnPropertyDescriptor(fulfilled, metadataKey),
    );
    expect(Object.isFrozen(optimisticPanel)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(optimisticPanel, "status")).toEqual(
      Object.getOwnPropertyDescriptor(fulfilled, "status"),
    );
    expect(() => Reflect.get(optimisticPanel, "catch")).not.toThrow();
    expect(() => Reflect.get(optimisticPanel, "finally")).not.toThrow();
    const transformedPanel = Reflect.get(optimisticPanel, "value");
    if (!isValidElement(transformedPanel)) throw new Error("Expected a transformed panel");
    const transformedPanelProps = Reflect.get(transformedPanel, "props");
    if (!isUnknownRecord(transformedPanelProps)) {
      throw new Error("Expected transformed panel props");
    }
    expect(Reflect.get(transformedPanelProps, "children")).not.toBe(panel.props.children);
    expect(Object.getOwnPropertyDescriptor(optimisticPanel, "value")).toEqual({
      ...Object.getOwnPropertyDescriptor(fulfilled, "value"),
      value: transformedPanel,
    });
    expect(await optimisticPanel).toBe(transformedPanel);

    const optimisticSafePanel = Reflect.get(pageProps, "safePanel") as SafePanelPromise;
    expect(optimisticSafePanel).toBeInstanceOf(SafePanelPromise);
    expect(optimisticSafePanel.readTag()).toBe("safe-panel-promise");
    expect(() => Promise.prototype.then.call(optimisticSafePanel, (value) => value)).not.toThrow();
  });

  it("preserves branded non-Promise thenable contracts", async () => {
    function Frame(): null {
      return null;
    }
    class PanelThenable {
      readonly #tag = "panel-thenable";
      readonly status = "fulfilled";

      constructor(readonly value: ReactNode) {}

      readTag(): string {
        return this.#tag;
      }

      // eslint-disable-next-line unicorn/no-thenable
      then<TResult>(onFulfilled: (value: ReactNode) => TResult): Promise<TResult> {
        return Promise.resolve(onFulfilled(this.value));
      }
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const fulfilled = new PanelThenable(panel);
    void Object.seal(fulfilled);
    const nonExtensible = new PanelThenable(panel);
    void Object.preventExtensions(nonExtensible);
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { nonExtensible, panel: fulfilled }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticPanel = Reflect.get(pageProps, "panel") as PanelThenable;

    expect(Object.getPrototypeOf(optimisticPanel)).toBe(PanelThenable.prototype);
    expect(optimisticPanel.readTag()).toBe("panel-thenable");
    expect(Object.isSealed(optimisticPanel)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(optimisticPanel, "status")).toEqual(
      Object.getOwnPropertyDescriptor(fulfilled, "status"),
    );
    const transformedPanel = Reflect.get(optimisticPanel, "value");
    if (!isValidElement(transformedPanel)) throw new Error("Expected a transformed panel");
    expect(await Promise.resolve(optimisticPanel)).toBe(transformedPanel);

    const optimisticNonExtensible = Reflect.get(pageProps, "nonExtensible") as PanelThenable;
    expect(Object.isExtensible(optimisticNonExtensible)).toBe(false);
    expect(Object.isSealed(optimisticNonExtensible)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(optimisticNonExtensible, "value")).toEqual({
      ...Object.getOwnPropertyDescriptor(nonExtensible, "value"),
      value: Reflect.get(optimisticNonExtensible, "value"),
    });
    expect(Reflect.get(optimisticNonExtensible, "value")).not.toBe(panel);
  });

  it("preserves transformed fulfilled-thenable cycles", () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const fulfilled = Object.assign(Promise.resolve<unknown>(undefined), {
      status: "fulfilled",
      value: undefined as unknown,
    });
    fulfilled.value = [fulfilled, panel];
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { panel: fulfilled }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticThenable = Reflect.get(pageProps, "panel");
    if (
      (typeof optimisticThenable !== "object" && typeof optimisticThenable !== "function") ||
      optimisticThenable === null
    ) {
      throw new Error("Expected an optimistic thenable");
    }
    const optimisticValue = Reflect.get(optimisticThenable, "value");
    expect(Array.isArray(optimisticValue)).toBe(true);
    expect((optimisticValue as unknown[])[0]).toBe(optimisticThenable);
    expect((optimisticValue as unknown[])[1]).not.toBe(panel);
  });

  it("preserves params-like fulfilled thenable identity and synchronous fields", () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const paramsValue = { slug: "settings" };
    const params = Object.assign(Promise.resolve(paramsValue), {
      slug: "settings",
      status: "fulfilled",
      value: paramsValue,
    });
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { panel, params }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    expect(optimisticPage).not.toBe(elements[pageId]);
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticParams = Reflect.get(pageProps, "params");
    expect(optimisticParams).toBe(params);
    if (
      (typeof optimisticParams !== "object" && typeof optimisticParams !== "function") ||
      optimisticParams === null
    ) {
      throw new Error("Expected params-like thenable");
    }
    expect(Reflect.get(optimisticParams, "slug")).toBe("settings");
  });

  it("transforms Suspense boundaries without manufacturing Set and Map subclass brands", () => {
    function Frame(): null {
      return null;
    }
    class PanelSet extends Set<ReactNode> {
      readonly #tag = "panel-set";
      cached: ReactNode = null;
      rejectOverridableOperations = false;

      override add(value: ReactNode): this {
        if (this.rejectOverridableOperations) {
          throw new Error("optimistic cloning must use Set.prototype.add");
        }
        return super.add(value);
      }

      override [Symbol.iterator](): SetIterator<ReactNode> {
        if (this.rejectOverridableOperations) {
          throw new Error("optimistic cloning must use Set.prototype.values");
        }
        return super[Symbol.iterator]();
      }

      readTag(): string {
        return this.#tag;
      }

      first(): ReactNode {
        return this.values().next().value;
      }
    }
    class PanelMap extends Map<string, ReactNode> {
      readonly #tag = "panel-map";
      cached: ReactNode = null;
      rejectOverridableOperations = false;

      override set(key: string, value: ReactNode): this {
        if (this.rejectOverridableOperations) {
          throw new Error("optimistic cloning must use Map.prototype.set");
        }
        return super.set(key, value);
      }

      override [Symbol.iterator](): MapIterator<[string, ReactNode]> {
        if (this.rejectOverridableOperations) {
          throw new Error("optimistic cloning must use Map.prototype.entries");
        }
        return super[Symbol.iterator]();
      }

      readTag(): string {
        return this.#tag;
      }

      firstValue(): ReactNode {
        return this.values().next().value;
      }
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const panels = new PanelSet([panel]);
    panels.cached = panel;
    panels.rejectOverridableOperations = true;
    const panelArray: unknown[] = [];
    panelArray.length = 3;
    void Object.defineProperty(panelArray, "1", {
      configurable: false,
      enumerable: true,
      value: panel,
      writable: false,
    });
    void Object.defineProperty(panelArray, "cached", {
      configurable: true,
      enumerable: true,
      value: panel,
      writable: true,
    });
    const arrayMetadata = Symbol("array-metadata");
    void Object.defineProperty(panelArray, arrayMetadata, {
      configurable: false,
      enumerable: false,
      value: "preserved",
      writable: false,
    });
    void Object.freeze(panelArray);
    const data = new PanelMap([["panel", panel]]);
    data.cached = panel;
    data.rejectOverridableOperations = true;
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { data, panelArray, panels }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticData = Reflect.get(pageProps, "data");
    expect(optimisticData).toBeInstanceOf(Map);
    expect(optimisticData).not.toBeInstanceOf(PanelMap);
    const optimisticDataPanel = Map.prototype.get.call(optimisticData, "panel");
    expect(optimisticDataPanel).not.toBe(panel);
    expect(Reflect.get(optimisticData as object, "cached")).toBe(optimisticDataPanel);
    const optimisticPanels = Reflect.get(pageProps, "panels");
    expect(optimisticPanels).toBeInstanceOf(Set);
    expect(optimisticPanels).not.toBeInstanceOf(PanelSet);
    const optimisticPanel = Set.prototype.values.call(optimisticPanels).next().value;
    if (!isValidElement(optimisticPanel)) throw new Error("Expected an optimistic panel");
    const panelProps = Reflect.get(optimisticPanel, "props");
    if (!isUnknownRecord(panelProps)) throw new Error("Expected optimistic panel props");
    expect(Reflect.get(panelProps, "children")).not.toBe(panel.props.children);
    expect(Reflect.get(optimisticPanels as object, "cached")).toBe(optimisticPanel);
    const optimisticPanelArray = Reflect.get(pageProps, "panelArray");
    expect(Object.getOwnPropertyDescriptor(optimisticPanelArray, arrayMetadata)).toEqual(
      Object.getOwnPropertyDescriptor(panelArray, arrayMetadata),
    );
    expect(0 in (optimisticPanelArray as unknown[])).toBe(false);
    expect(2 in (optimisticPanelArray as unknown[])).toBe(false);
    expect(Object.isFrozen(optimisticPanelArray)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(optimisticPanelArray, "1")).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
    });
    expect((optimisticPanelArray as unknown[])[1]).not.toBe(panel);
    expect(Reflect.get(optimisticPanelArray as object, "cached")).toBe(
      (optimisticPanelArray as unknown[])[1],
    );
  });

  it("falls back from container subclasses whose empty candidates cannot be populated", () => {
    function Frame(): null {
      return null;
    }
    class FrozenPanelArray extends Array<ReactNode> {
      constructor(...items: ReactNode[]) {
        super(...items);
        Object.freeze(this);
      }
    }
    class LockedPanelMap extends Map<string, ReactNode> {
      constructor(entries?: readonly (readonly [string, ReactNode])[]) {
        super(entries);
        if (entries !== undefined) {
          Object.defineProperty(this, "sourceOnly", {
            configurable: true,
            enumerable: true,
            value: entries[0]?.[1] ?? null,
            writable: true,
          });
        }
        Object.preventExtensions(this);
      }
    }
    class LockedPanelSet extends Set<ReactNode> {
      constructor(entries?: readonly ReactNode[]) {
        super(entries);
        if (entries !== undefined) {
          Object.defineProperty(this, "sourceOnly", {
            configurable: true,
            enumerable: true,
            value: entries[0] ?? null,
            writable: true,
          });
        }
        Object.preventExtensions(this);
      }
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const frozenPanels = new FrozenPanelArray(panel);
    const lockedMap = new LockedPanelMap([["panel", panel]]);
    const lockedSet = new LockedPanelSet([panel]);
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { frozenPanels, lockedMap, lockedSet }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");

    const optimisticArray = Reflect.get(pageProps, "frozenPanels");
    expect(Array.isArray(optimisticArray)).toBe(true);
    expect(optimisticArray).not.toBeInstanceOf(FrozenPanelArray);
    expect(Object.isFrozen(optimisticArray)).toBe(true);
    expect(Reflect.get(optimisticArray as object, "0")).not.toBe(panel);

    const optimisticMap = Reflect.get(pageProps, "lockedMap");
    expect(optimisticMap).toBeInstanceOf(Map);
    expect(optimisticMap).not.toBeInstanceOf(LockedPanelMap);
    expect(Object.isExtensible(optimisticMap)).toBe(false);
    expect(Map.prototype.get.call(optimisticMap, "panel")).not.toBe(panel);
    expect(Reflect.get(optimisticMap as object, "sourceOnly")).toBe(
      Map.prototype.get.call(optimisticMap, "panel"),
    );

    const optimisticSet = Reflect.get(pageProps, "lockedSet");
    expect(optimisticSet).toBeInstanceOf(Set);
    expect(optimisticSet).not.toBeInstanceOf(LockedPanelSet);
    expect(Object.isExtensible(optimisticSet)).toBe(false);
    const optimisticSetPanel = Set.prototype.values.call(optimisticSet).next().value;
    expect(optimisticSetPanel).not.toBe(panel);
    expect(Reflect.get(optimisticSet as object, "sourceOnly")).toBe(optimisticSetPanel);
  });

  it("falls back from constructible container brands and throwing constructor accessors", () => {
    function Frame(): null {
      return null;
    }
    class StatefulPanelArray extends Array<ReactNode> {
      readonly #sourceFirst: ReactNode;

      constructor(...entries: ReactNode[]) {
        super(...entries);
        this.#sourceFirst = entries[0];
      }

      hasSourceFirst(): boolean {
        return this[0] === this.#sourceFirst;
      }
    }
    class StatefulPanelMap extends Map<string, ReactNode> {
      readonly #sourceFirst: ReactNode;

      constructor(entries: readonly (readonly [string, ReactNode])[] = []) {
        super(entries);
        this.#sourceFirst = entries[0]?.[1];
      }

      hasSourceFirst(): boolean {
        return this.get("panel") === this.#sourceFirst;
      }
    }
    class StatefulPanelSet extends Set<ReactNode> {
      readonly #sourceFirst: ReactNode;

      constructor(entries: readonly ReactNode[] = []) {
        super(entries);
        this.#sourceFirst = entries[0];
      }

      hasSourceFirst(): boolean {
        return this.values().next().value === this.#sourceFirst;
      }
    }
    class ThrowingConstructorArray extends Array<ReactNode> {}
    let privateAccessorReads = 0;
    class PrivateAccessorArray extends Array<ReactNode> {
      readonly #panel: ReactNode;

      constructor(panel: ReactNode) {
        super();
        this.#panel = panel;
        this.length = 1;
      }

      get 0(): ReactNode {
        privateAccessorReads += 1;
        return this.#panel;
      }
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const statefulArray = new StatefulPanelArray(panel);
    const statefulMap = new StatefulPanelMap([["panel", panel]]);
    const statefulSet = new StatefulPanelSet([panel]);
    const throwingConstructorArray = new ThrowingConstructorArray(panel);
    const privateAccessorArray = new PrivateAccessorArray(panel);
    Object.defineProperty(ThrowingConstructorArray.prototype, "constructor", {
      configurable: true,
      get() {
        throw new Error("optimistic cloning must not read prototype.constructor");
      },
    });
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, {
        statefulArray,
        statefulMap,
        statefulSet,
        throwingConstructorArray,
        privateAccessorArray,
      }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");

    const optimisticArray = Reflect.get(pageProps, "statefulArray");
    expect(Array.isArray(optimisticArray)).toBe(true);
    expect(optimisticArray).not.toBeInstanceOf(StatefulPanelArray);
    expect(Reflect.get(optimisticArray as object, "0")).not.toBe(panel);

    const optimisticMap = Reflect.get(pageProps, "statefulMap");
    expect(optimisticMap).toBeInstanceOf(Map);
    expect(optimisticMap).not.toBeInstanceOf(StatefulPanelMap);
    expect(Map.prototype.get.call(optimisticMap, "panel")).not.toBe(panel);

    const optimisticSet = Reflect.get(pageProps, "statefulSet");
    expect(optimisticSet).toBeInstanceOf(Set);
    expect(optimisticSet).not.toBeInstanceOf(StatefulPanelSet);
    expect(Set.prototype.values.call(optimisticSet).next().value).not.toBe(panel);

    const optimisticThrowingConstructorArray = Reflect.get(pageProps, "throwingConstructorArray");
    expect(Array.isArray(optimisticThrowingConstructorArray)).toBe(true);
    expect(optimisticThrowingConstructorArray).not.toBeInstanceOf(ThrowingConstructorArray);
    expect(Reflect.get(optimisticThrowingConstructorArray as object, "0")).not.toBe(panel);

    const optimisticPrivateAccessorArray = Reflect.get(pageProps, "privateAccessorArray");
    expect(privateAccessorReads).toBe(0);
    expect(Array.isArray(optimisticPrivateAccessorArray)).toBe(true);
    expect(optimisticPrivateAccessorArray).not.toBeInstanceOf(PrivateAccessorArray);
    expect(Reflect.get(optimisticPrivateAccessorArray as object, "0")).not.toBe(panel);
    expect(privateAccessorReads).toBe(1);
  });

  it("preserves custom and one-shot iterable data props", () => {
    function Frame(): null {
      return null;
    }
    class DataBag implements Iterable<unknown> {
      readonly label = "bag";

      *[Symbol.iterator](): Iterator<unknown> {
        yield { slug: "settings" };
      }

      readLabel(): string {
        return this.label;
      }
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const dataBag = new DataBag();
    let oneShotReads = 0;
    const oneShot = (function* oneShotData(): Generator<unknown> {
      oneShotReads += 1;
      yield { value: "data" };
    })();
    let throwingNextReads = 0;
    const accessorIterator = {
      *[Symbol.iterator](): Iterator<unknown> {
        yield { value: "accessor data" };
      },
    };
    Object.defineProperty(accessorIterator, "next", {
      configurable: true,
      get() {
        throwingNextReads += 1;
        throw new Error("one-shot classification must not read next");
      },
    });
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { accessorIterator, dataBag, oneShot, panel }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticDataBag = Reflect.get(pageProps, "dataBag");
    expect(optimisticDataBag).toBe(dataBag);
    expect(optimisticDataBag).toBeInstanceOf(DataBag);
    expect((optimisticDataBag as DataBag).readLabel()).toBe("bag");
    expect(Reflect.get(pageProps, "oneShot")).toBe(oneShot);
    expect(oneShotReads).toBe(0);
    expect(Reflect.get(pageProps, "accessorIterator")).toBe(accessorIterator);
    expect(throwingNextReads).toBe(0);
  });

  it("defers array index accessors while transforming the React elements they produce", () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    let indexReads = 0;
    const panels: ReactNode[] = [];
    panels.length = 1;
    void Object.defineProperty(panels, "0", {
      configurable: false,
      enumerable: true,
      get() {
        indexReads += 1;
        return panel;
      },
    });
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { panels }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    const optimisticPanels = Reflect.get(pageProps, "panels") as ReactNode[];
    expect(indexReads).toBe(0);
    expect(Object.is(optimisticPanels, panels)).toBe(false);
    expect(indexReads).toBe(0);

    const optimisticPanel = optimisticPanels[0];
    expect(indexReads).toBe(1);
    if (!isValidElement(optimisticPanel)) throw new Error("Expected an optimistic panel");
    const optimisticPanelProps = Reflect.get(optimisticPanel, "props");
    if (!isUnknownRecord(optimisticPanelProps)) {
      throw new Error("Expected optimistic panel props");
    }
    expect(Reflect.get(optimisticPanelProps, "children")).not.toBe(panel.props.children);
  });

  it("transforms shared-cursor ReactNode iterables without consuming them first", () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    const entries = [panel, createElement("p", { key: "tail" }, "Tail")];
    let cursor = 0;
    const panels = {} as Iterable<ReactNode>;
    Object.defineProperty(panels, Symbol.iterator, {
      configurable: false,
      value() {
        const buffered = cursor < entries.length ? entries[cursor++] : undefined;
        let emittedBuffered = false;
        return {
          next(): IteratorResult<ReactNode> {
            if (!emittedBuffered && buffered !== undefined) {
              emittedBuffered = true;
              return { done: false, value: buffered };
            }
            if (cursor >= entries.length) return { done: true, value: undefined };
            return { done: false, value: entries[cursor++] };
          },
        };
      },
      writable: false,
    });
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { panels }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    expect(cursor).toBe(0);
    const optimisticPanels = [...(Reflect.get(pageProps, "panels") as Iterable<unknown>)];

    expect(optimisticPanels).toHaveLength(2);
    expect(
      Object.getOwnPropertyDescriptor(Reflect.get(pageProps, "panels"), Symbol.iterator),
    ).toMatchObject({ configurable: false, writable: false });
    const optimisticPanel = optimisticPanels[0];
    if (!isValidElement(optimisticPanel)) throw new Error("Expected an optimistic panel");
    const optimisticPanelProps = Reflect.get(optimisticPanel, "props");
    if (!isUnknownRecord(optimisticPanelProps)) {
      throw new Error("Expected optimistic panel props");
    }
    expect(Reflect.get(optimisticPanelProps, "children")).not.toBe(panel.props.children);
  });

  it("does not invoke iterable accessors before optimistic iteration", () => {
    function Frame(): null {
      return null;
    }

    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const panel = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading panel") },
      createElement("p", null, "Resolved panel"),
    );
    let accessorReads = 0;
    const panels = {} as Iterable<ReactNode>;
    Object.defineProperty(panels, Symbol.iterator, {
      configurable: true,
      get() {
        accessorReads += 1;
        return function* panelIterator(): Iterator<ReactNode> {
          yield panel;
        };
      },
    });
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: createElement(Frame, { panels }),
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    const optimisticPage = createOptimisticRouteElements(template)[pageId];
    if (!isValidElement(optimisticPage)) throw new Error("Expected an optimistic page element");
    const pageProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(pageProps)) throw new Error("Expected optimistic page props");
    expect(accessorReads).toBe(0);
    expect([...(Reflect.get(pageProps, "panels") as Iterable<unknown>)]).toHaveLength(1);
    expect(accessorReads).toBe(1);
  });

  it("suspends boundaries inside deeply nested arrays without overflowing the stack", () => {
    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const resolved = createElement("p", null, "Resolved deeply nested content");
    let page: unknown = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading deeply nested content") },
      resolved,
    );
    for (let index = 0; index < 2_000; index += 1) {
      page = [page];
    }
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: page as ReactNode,
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    let optimisticPage: unknown = createOptimisticRouteElements(template)[pageId];
    for (let index = 0; index < 2_000; index += 1) {
      if (!Array.isArray(optimisticPage)) throw new Error("Expected a nested optimistic array");
      optimisticPage = optimisticPage[0];
    }
    if (!isValidElement(optimisticPage)) throw new Error("Expected a nested Suspense boundary");
    const optimisticProps = Reflect.get(optimisticPage, "props");
    if (!isUnknownRecord(optimisticProps)) throw new Error("Expected optimistic Suspense props");
    expect(Reflect.get(optimisticProps, "children")).not.toBe(resolved);
  });

  it("does not leak nested Suspense content through deeply nested elements", () => {
    const routeManifest = staticSettingsManifest();
    const routeId = AppElementsWire.encodeRouteId("/settings", null);
    const pageId = AppElementsWire.encodePageId("/settings", null);
    const resolved = createElement("p", null, "Resolved deeply nested content");
    let page: ReactNode = createElement(
      Suspense,
      { fallback: createElement("p", null, "Loading deeply nested content") },
      resolved,
    );
    for (let index = 0; index < 2_000; index += 1) {
      page = createElement("div", null, page);
    }
    const elements: AppElements = {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: ["layout:/", "layout:/settings"],
        rootLayoutTreePath: "/",
        routeId,
      }),
      [pageId]: page,
    };
    const template = createOptimisticRouteTemplate({
      allowSegmentShell: true,
      basePath: "",
      elements,
      href: "/settings.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest,
    });

    if (template === null) throw new Error("Expected an optimistic route template");
    let nested: unknown = createOptimisticRouteElements(template)[pageId];
    for (let index = 0; index < 2_000; index += 1) {
      if (!isValidElement(nested)) throw new Error("Expected a nested optimistic element");
      const props = Reflect.get(nested, "props");
      if (!isUnknownRecord(props)) throw new Error("Expected nested optimistic props");
      nested = Reflect.get(props, "children");
    }
    if (!isValidElement(nested)) throw new Error("Expected a nested Suspense boundary");
    const suspenseProps = Reflect.get(nested, "props");
    if (!isUnknownRecord(suspenseProps)) throw new Error("Expected nested Suspense props");
    expect(Reflect.get(suspenseProps, "children")).not.toBe(resolved);
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
