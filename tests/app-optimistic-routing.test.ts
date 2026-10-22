import { describe, expect, it, vi } from "vite-plus/test";
import {
  createElement,
  isValidElement,
  Suspense,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ErrorBoundary } from "vinext/shims/error-boundary";
import { LayoutSegmentProvider } from "vinext/shims/layout-segment-context";
import { Slot } from "vinext/shims/slot";
import {
  AppElementsWire,
  APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import {
  canCommitOptimisticRouteTemplate,
  createOptimisticRouteElements,
  createOptimisticRouteTemplate,
  createOptimisticUrlRouteTemplates,
  getOptimisticPrefetchSourceKey,
  getOptimisticRouteTemplateKey,
  matchOptimisticRouteManifestRoute,
  pruneOptimisticUrlRouteTemplates,
  readOptimisticUrlRouteTemplate,
  resolveOptimisticNavigationParamsForHref,
  resolveOptimisticNavigationPayload,
  setOptimisticUrlRouteTemplate,
  settleOptimisticRouteRows,
  type OptimisticRouteTemplate,
} from "../packages/vinext/src/server/app-optimistic-routing.js";
import type {
  GraphVersion,
  RouteManifest,
  RouteManifestRoute,
  RouteManifestSlotBinding,
} from "../packages/vinext/src/routing/app-route-graph.js";
import { resolveAppPageRouteStateKey } from "../packages/vinext/src/server/app-page-segment-state.js";
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

function blogRouteStateKey(slug: string): string {
  return resolveAppPageRouteStateKey(["blog", "[slug]"], { slug });
}

function routeElementId(slug: string): string {
  return AppElementsWire.encodeRouteId(`/blog/${slug}`, null);
}

// A loading shell that stops at the route's own loading.tsx: the route entry
// and page entry carry the boundaries the full render keys by route state.
function blogPageIdentity(slug: string): string {
  return deriveBfcacheSegmentIdentity({
    boundSegmentKey: blogRouteStateKey(slug),
    graphId: "page:/blog/:slug",
    kind: "page",
    rootBoundaryId: "/",
  });
}

function createBlogMirroredLoadingShellElements(slug: string): AppElements {
  const routeId = routeElementId(slug);
  const pageId = AppElementsWire.encodePageId(`/blog/${slug}`, null);
  const key = blogRouteStateKey(slug);
  return {
    ...AppElementsWire.createMetadataEntries({
      bfcacheSegmentIdentities: { [pageId]: blogPageIdentity(slug) },
      interceptionContext: null,
      layoutIds: ["layout:/"],
      rootLayoutTreePath: "/",
      routeId,
    }),
    [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
    [pageId]: createElement(Suspense, { fallback: createElement("p", null, "Loading"), key }, null),
    [routeId]: createElement(
      "main",
      null,
      createElement(Suspense, { fallback: createElement("p", null, "Loading"), key }, "Page slot"),
    ),
  };
}

function readSuspense(value: unknown) {
  if (
    !isValidElement<{ children?: unknown; fallback?: unknown }>(value) ||
    value.type !== Suspense
  ) {
    throw new Error("Expected a Suspense boundary");
  }
  return value;
}

function readChild(value: unknown): unknown {
  if (!isValidElement<{ children?: unknown }>(value)) throw new Error("Expected an element");
  return value.props.children;
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
    const optimisticElements = createOptimisticRouteElements(template, template.urlRouteStateKey)!;
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

  it("suspends inside the page entry's own loading boundary", () => {
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements: createBlogMirroredLoadingShellElements("post-1"),
      href: "/blog/post-1.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest: blogManifest(),
    });
    if (template === null) throw new Error("Expected optimistic route template");

    const pageId = AppElementsWire.encodePageId("/blog/post-1", null);
    const elements = createOptimisticRouteElements(template, blogRouteStateKey("post-1"))!;
    const optimisticBoundary = readSuspense(elements[pageId]);
    // The real payload renders this keyed boundary, so React keeps the
    // fallback the optimistic commit mounted.
    expect(optimisticBoundary.key).toBe(blogRouteStateKey("post-1"));
    expect(optimisticBoundary.props.fallback).toBe(
      readSuspense(template.elements[pageId]).props.fallback,
    );
    expect(isValidElement(optimisticBoundary.props.children)).toBe(true);
    expect(readSuspense(readChild(elements[routeElementId("post-1")])).key).toBe(
      blogRouteStateKey("post-1"),
    );
  });

  it("does not keep a full prefetch's page boundary", () => {
    const pageId = AppElementsWire.encodePageId("/blog/post-1", null);
    const pageBoundary = createElement(Suspense, { fallback: null, key: "page-key" }, null);
    const template: OptimisticRouteTemplate = {
      elements: { [pageId]: pageBoundary },
      mountedSlotsHeader: null,
      omittedBfcacheSegmentIds: [],
      omittedLayoutIds: [],
      pageElementIds: [pageId],
      routeId: "route:/blog/:slug",
      routeStateKey: blogRouteStateKey("post-1"),
      urlRouteStateKey: blogRouteStateKey("post-1"),
    };

    const pageElement = createOptimisticRouteElements(template, blogRouteStateKey("post-1"))![
      pageId
    ];
    expect(isValidElement(pageElement) && pageElement.type).not.toBe(Suspense);
  });

  it("keys a template learned from another URL for the target", () => {
    const routeManifest = blogManifest();
    const routeId = routeElementId("post-3");
    const pageId = AppElementsWire.encodePageId("/blog/post-3", null);
    const shell = createBlogMirroredLoadingShellElements("post-3");
    const AppShell = (props: { children?: ReactNode; resetKey: string }) => props.children;
    const lazySlot = {
      $$typeof: Symbol.for("react.lazy"),
      _init: (payload: unknown) => payload,
      _payload: Slot,
    } as unknown as typeof Slot;
    const lazyProvider = {
      $$typeof: Symbol.for("react.lazy"),
      _init: (payload: unknown) => payload,
      _payload: LayoutSegmentProvider,
    } as unknown as typeof LayoutSegmentProvider;
    const SegmentError = () => createElement("p", null, "Error");
    const rootLayoutIdentity = deriveBfcacheSegmentIdentity({
      boundSegmentKey: "",
      graphId: "layout:/",
      kind: "layout",
      rootBoundaryId: "/",
    });
    // The slug segment's own key, bare, as a segment boundary is keyed.
    const slugSegmentKey = (slug: string): string => JSON.parse(blogRouteStateKey(slug))[1];
    // A template above the leaf inside a route group keeps the group segment.
    const groupTemplateKey = (slug: string) =>
      JSON.stringify(["(shop)", "blog", slugSegmentKey(slug)]);
    const groupTemplateIdentity = (slug: string) =>
      deriveBfcacheSegmentIdentity({
        boundSegmentKey: groupTemplateKey(slug),
        graphId: "template:/blog",
        kind: "template",
        rootBoundaryId: "/",
      });
    const loadingFallback = createElement("p", null, "Loading");
    const learn = (identities: Record<string, string>) => {
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: {
          ...shell,
          [APP_BFCACHE_SEGMENT_IDENTITIES_KEY]: identities,
          // Flight decodes a deferred row as a lazy element: a template's
          // slot, then the slug segment's error and loading boundaries. It
          // decodes the slot's client component type as a lazy too.
          [routeId]: {
            $$typeof: Symbol.for("react.lazy"),
            _init: (payload: unknown) => payload,
            // The root layout's segment provider lists the segments below it.
            _payload: createElement(
              lazyProvider,
              {
                providerId: "layout:/",
                segmentMap: { children: ["(shop)", "blog", "post-3"] },
                // Children are passed as the third argument.
              } as unknown as ComponentProps<typeof LayoutSegmentProvider>,
              createElement(
                lazySlot,
                { id: "template:/blog", key: groupTemplateKey("post-3") },
                createElement(
                  ErrorBoundary,
                  {
                    fallback: SegmentError,
                    resetKey: slugSegmentKey("post-3"),
                  } as unknown as ComponentProps<typeof ErrorBoundary>,
                  createElement(
                    Suspense,
                    { fallback: loadingFallback, key: slugSegmentKey("post-3") },
                    readChild(shell[routeId]) as ReactNode,
                  ),
                ),
              ),
            ),
          } as unknown as AppElements[string],
          // A loading boundary around what the template rendered, which keys
          // its own elements.
          "template:/blog": createElement(
            Suspense,
            { fallback: loadingFallback, key: slugSegmentKey("post-3") },
            createElement(
              AppShell,
              { key: slugSegmentKey("post-3"), resetKey: slugSegmentKey("post-3") },
              createElement(Suspense, { fallback: null, key: slugSegmentKey("post-3") }, "App"),
            ),
          ),
        },
        href: "/blog/post-3.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
      });
      if (template === null) throw new Error("Expected optimistic route template");
      return resolveOptimisticNavigationPayload({
        basePath: "",
        href: "/blog/post-4",
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
    };

    const payload = learn({
      [pageId]: blogPageIdentity("post-3"),
      "layout:/": rootLayoutIdentity,
      "template:/blog": groupTemplateIdentity("post-3"),
    });
    // The real payload for post-4 renders these keys, so it reuses the
    // boundaries the optimistic commit mounts.
    if (payload === null) throw new Error("Expected optimistic payload");
    const provider = payload.elements[routeId];
    if (!isValidElement<{ segmentMap?: unknown }>(provider)) {
      throw new Error("Expected an element");
    }
    // useSelectedLayoutSegment() reads the target's segments.
    expect(provider.props.segmentMap).toEqual({ children: ["(shop)", "blog", "post-4"] });
    const routeElement = readChild(provider);
    if (!isValidElement(routeElement)) throw new Error("Expected an element");
    const errorBoundary = readChild(routeElement);
    if (!isValidElement<{ resetKey?: unknown }>(errorBoundary)) {
      throw new Error("Expected an element");
    }
    const segmentBoundary = readSuspense(readChild(errorBoundary));
    expect(readSuspense(payload.elements[pageId]).key).toBe(blogRouteStateKey("post-4"));
    expect(routeElement.key).toBe(groupTemplateKey("post-4"));
    expect(errorBoundary.props.resetKey).toBe(slugSegmentKey("post-4"));
    expect(segmentBoundary.key).toBe(slugSegmentKey("post-4"));
    expect(readSuspense(readChild(segmentBoundary)).key).toBe(blogRouteStateKey("post-4"));
    // The template entry's loading boundary is rebound. What the app rendered
    // inside it keeps its keys and props.
    const templateBoundary = readSuspense(payload.elements["template:/blog"]);
    expect(templateBoundary.key).toBe(slugSegmentKey("post-4"));
    const appShell = readChild(templateBoundary);
    if (!isValidElement<{ resetKey?: unknown }>(appShell)) throw new Error("Expected an element");
    expect(appShell.key).toBe(slugSegmentKey("post-3"));
    expect(appShell.props.resetKey).toBe(slugSegmentKey("post-3"));
    expect(readSuspense(readChild(appShell)).key).toBe(slugSegmentKey("post-3"));
    // Slots are keyed by segment identities too. The page's and the
    // template's name the target; the root layout's is not bound to the slug.
    expect(AppElementsWire.readMetadata(payload.elements).bfcacheSegmentIdentities).toEqual({
      [pageId]: blogPageIdentity("post-4"),
      "layout:/": rootLayoutIdentity,
      "template:/blog": groupTemplateIdentity("post-4"),
    });

    // A layout or named slot bound to the slug was rendered with post-3's
    // params, so the shell is not committed for post-4.
    const leafLayoutIdentity = deriveBfcacheSegmentIdentity({
      boundSegmentKey: blogRouteStateKey("post-3"),
      graphId: "layout:/blog/[slug]",
      kind: "layout",
      rootBoundaryId: "/",
    });
    // Slot identities nest their owner's state key.
    const modalIdentity = deriveBfcacheSegmentIdentity({
      activeRouteGraphId: null,
      boundSegmentKey: JSON.stringify([blogRouteStateKey("post-3"), "photo"]),
      interceptionTargetRouteGraphId: null,
      kind: "slot",
      ownerLayoutGraphId: "layout:/blog/[slug]",
      slotGraphId: "slot:@modal",
      state: "active",
    });
    expect(
      learn({
        [pageId]: blogPageIdentity("post-3"),
        "layout:/blog/[slug]": leafLayoutIdentity,
      }),
    ).toBeNull();
    expect(
      learn({
        [pageId]: blogPageIdentity("post-3"),
        "slot:modal:/blog/[slug]": modalIdentity,
      }),
    ).toBeNull();
    // A slot binds params of its own, which the route state key doesn't
    // carry, so an identity naming none of the route's segments may still be
    // the learned URL's.
    const catchAllModalIdentity = deriveBfcacheSegmentIdentity({
      activeRouteGraphId: "/blog/[...rest]",
      boundSegmentKey: JSON.stringify(["blog", "rest|post-3|c"]),
      interceptionTargetRouteGraphId: null,
      kind: "slot",
      ownerLayoutGraphId: "layout:/",
      slotGraphId: "slot:@modal",
      state: "active",
    });
    expect(
      learn({
        [pageId]: blogPageIdentity("post-3"),
        "slot:modal:/": catchAllModalIdentity,
      }),
    ).toBeNull();
  });

  it("keys a template by the route state the server rendered", () => {
    // A rewrite served /blog/post-1 from /blog/post-9, so the shell's
    // boundaries are keyed for post-9.
    const shell = createBlogMirroredLoadingShellElements("post-9");
    const routeId = routeElementId("post-1");
    const pageId = AppElementsWire.encodePageId("/blog/post-1", null);
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements: {
        ...shell,
        ...AppElementsWire.createMetadataEntries({
          bfcacheSegmentIdentities: { [pageId]: blogPageIdentity("post-9") },
          interceptionContext: null,
          layoutIds: ["layout:/"],
          rootLayoutTreePath: "/",
          routeId,
        }),
        [pageId]: shell[AppElementsWire.encodePageId("/blog/post-9", null)],
        [routeId]: shell[routeElementId("post-9")],
      },
      href: "/blog/post-1.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest: blogManifest(),
    });
    expect(template?.routeStateKey).toBe(blogRouteStateKey("post-9"));
    if (template === null) throw new Error("Expected optimistic route template");

    // Committed for /blog/post-1, the real payload is rewritten the same way,
    // so the shell keeps its keys.
    const own = createOptimisticRouteElements(template, blogRouteStateKey("post-1"))!;
    expect(readSuspense(own[pageId]).key).toBe(blogRouteStateKey("post-9"));
    expect(readSuspense(readChild(own[routeId])).key).toBe(blogRouteStateKey("post-9"));

    // Committed for another URL, it is keyed for that URL.
    const other = createOptimisticRouteElements(template, blogRouteStateKey("post-2"))!;
    expect(readSuspense(other[pageId]).key).toBe(blogRouteStateKey("post-2"));
    expect(readSuspense(readChild(other[routeId])).key).toBe(blogRouteStateKey("post-2"));
    expect(AppElementsWire.readMetadata(other).bfcacheSegmentIdentities[pageId]).toBe(
      blogPageIdentity("post-2"),
    );
  });

  it("does not commit a shell whose segment keys can't be rebound", () => {
    // app/id|2|d/(g)/template.tsx above app/id|2|d/(g)/[id]: learned from
    // /id|2|d/2 and committed for /id|2|d/3, only the [id] segment changes,
    // but the static segment has the same key, so bare keys such as the
    // template's or an [id] boundary's can't tell the two apart.
    const fromKey = JSON.stringify(["id|2|d", "id|2|d"]);
    const toKey = JSON.stringify(["id|2|d", "id|3|d"]);
    const staticTemplateKey = JSON.stringify(["id|2|d", "(g)"]);
    const pageId = AppElementsWire.encodePageId("/id|2|d/2", null);
    const routeId = "route:/id|2|d/2";
    const fallback = createElement("p", null, "Loading");
    const template: OptimisticRouteTemplate = {
      elements: {
        ...AppElementsWire.createMetadataEntries({
          interceptionContext: null,
          layoutIds: ["layout:/"],
          rootLayoutTreePath: "/",
          routeId,
        }),
        [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
        [pageId]: createElement(Suspense, { fallback, key: fromKey }, null),
        [routeId]: createElement(
          "div",
          { key: staticTemplateKey },
          createElement(Suspense, { fallback, key: fromKey }, "Page slot"),
        ),
      },
      mountedSlotsHeader: null,
      omittedBfcacheSegmentIds: [],
      omittedLayoutIds: [],
      pageElementIds: [pageId],
      routeId: "route:/id|2|d/:id",
      routeStateKey: fromKey,
      urlRouteStateKey: fromKey,
    };

    expect(createOptimisticRouteElements(template, toKey)).toBeNull();
    // Committed for its own URL, it needs no rebinding.
    expect(createOptimisticRouteElements(template, fromKey)).not.toBeNull();
  });

  it("keys segment maps for the target only where it can tell segments apart", () => {
    const learn = (fromKey: string, segments: string[] = []) => {
      const pageId = AppElementsWire.encodePageId("/blog/learned", null);
      const routeId = "route:/blog/learned";
      const fallback = createElement("p", null, "Loading");
      const template: OptimisticRouteTemplate = {
        elements: {
          ...AppElementsWire.createMetadataEntries({
            interceptionContext: null,
            layoutIds: ["layout:/"],
            rootLayoutTreePath: "/",
            routeId,
          }),
          [APP_PREFETCH_LOADING_SHELL_MARKER_KEY]: "LoadingBoundary",
          [pageId]: createElement(Suspense, { fallback, key: fromKey }, null),
          [routeId]: createElement(
            LayoutSegmentProvider,
            {
              providerId: "layout:/",
              segmentMap: { children: segments },
              // Children are passed as the third argument.
            } as unknown as ComponentProps<typeof LayoutSegmentProvider>,
            createElement(Suspense, { fallback, key: fromKey }, "Page slot"),
          ),
        },
        mountedSlotsHeader: null,
        omittedBfcacheSegmentIds: [],
        omittedLayoutIds: [],
        pageElementIds: [pageId],
        routeId: "route:/blog/:slug",
        routeStateKey: fromKey,
        urlRouteStateKey: fromKey,
      };
      return template;
    };
    const readSegments = (elements: AppElements | null) => {
      const provider = elements?.["route:/blog/learned"];
      if (!isValidElement<{ segmentMap?: { children?: unknown } }>(provider)) {
        throw new Error("Expected the segment provider");
      }
      return provider.props.segmentMap?.children;
    };
    const blogKey = blogRouteStateKey("post-4");
    expect(
      readSegments(
        createOptimisticRouteElements(
          learn(blogRouteStateKey("post-3"), ["blog", "post-3"]),
          blogKey,
        ),
      ),
    ).toEqual(["blog", "post-4"]);
    // A param's name may contain `|`; its value is URL-encoded.
    const pipeKey = (value: string) => resolveAppPageRouteStateKey(["[a|b]"], { "a|b": value });
    expect(
      readSegments(createOptimisticRouteElements(learn(pipeKey("one"), ["one"]), pipeKey("two"))),
    ).toEqual(["two"]);
    // Learned from /blog/blog: a segment map's "blog" may be either segment.
    expect(createOptimisticRouteElements(learn(blogRouteStateKey("blog")), blogKey)).toBeNull();
    // A param spelled like the page's own segment, which its provider lists.
    expect(createOptimisticRouteElements(learn(blogRouteStateKey("__PAGE__")), blogKey)).toBeNull();
    // A param spelled like a route group, which segment maps list.
    expect(createOptimisticRouteElements(learn(blogRouteStateKey("(shop)")), blogKey)).toBeNull();
    // An optional catch-all that gains segments shifts a segment map's
    // positions.
    const shopKey = (rest: string[]) =>
      resolveAppPageRouteStateKey(["shop", "[[...rest]]"], { rest });
    expect(createOptimisticRouteElements(learn(shopKey([])), shopKey(["a"]))).toBeNull();
    expect(createOptimisticRouteElements(learn(shopKey(["a"])), shopKey([]))).toBeNull();
    expect(createOptimisticRouteElements(learn(shopKey(["a"])), shopKey(["b", "c"]))).not.toBe(
      null,
    );
  });

  it("does not commit a shell while what it mirrors or rebinds is pending", () => {
    const routeManifest = blogManifest();
    const routeId = routeElementId("post-3");
    const pageId = AppElementsWire.encodePageId("/blog/post-3", null);
    const shell = createBlogMirroredLoadingShellElements("post-3");
    const slugSegmentKey = JSON.parse(blogRouteStateKey("post-3"))[1];
    // Flight decodes a row it hasn't read yet, or a client component type
    // whose module hasn't loaded, as a lazy whose initializer throws.
    let resolved: unknown = null;
    const lazy = <T>(value: () => T): T =>
      ({
        $$typeof: Symbol.for("react.lazy"),
        _init: () => {
          if (resolved === null) throw new Promise(() => {});
          return value();
        },
        _payload: null,
      }) as unknown as T;
    const learn = (elements: Partial<AppElements>) => {
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: { ...shell, ...elements } as AppElements,
        href: "/blog/post-3.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
      });
      if (template === null) throw new Error("Expected optimistic route template");
      return template;
    };
    const post4 = blogRouteStateKey("post-4");

    // The page entry's boundary is mirrored, and shows which route state the
    // shell is keyed for, even when committed for the URL it was learned from.
    const pendingPage = learn({ [pageId]: lazy(() => shell[pageId]) });
    expect(createOptimisticRouteElements(pendingPage, post4)).toBeNull();
    expect(createOptimisticRouteElements(pendingPage, blogRouteStateKey("post-3"))).toBeNull();
    // Once it has resolved, the shell is keyed for the target.
    resolved = true;
    expect(readSuspense(createOptimisticRouteElements(pendingPage, post4)![pageId]).key).toBe(
      post4,
    );
    resolved = null;

    // A route row settling gave up on would suspend above the mirrored
    // boundary, for the learned URL too.
    const pendingRoute = learn({ [routeId]: lazy(() => shell[routeId]) });
    expect(createOptimisticRouteElements(pendingRoute, post4)).toBeNull();
    expect(createOptimisticRouteElements(pendingRoute, blogRouteStateKey("post-3"))).toBeNull();
    // So would a boundary in the route chain whose module hasn't loaded,
    // whatever it is keyed by.
    const PendingBoundary = lazy(() => Slot);
    const routeWithPendingType = (key: string) =>
      learn({
        [routeId]: createElement(PendingBoundary, { id: "x", key }, shell[routeId] as ReactNode),
      });
    expect(createOptimisticRouteElements(routeWithPendingType(slugSegmentKey), post4)).toBeNull();
    expect(createOptimisticRouteElements(routeWithPendingType("blog"), post4)).toBeNull();
    expect(
      createOptimisticRouteElements(routeWithPendingType("blog"), blogRouteStateKey("post-3")),
    ).toBeNull();
    // A client loading.tsx is a lazy type until its module loads, which the
    // commit renders as the mirrored boundaries' fallback.
    const PendingLoading = lazy(() => () => "Loading");
    const pendingFallback = (fallback: ReactNode) =>
      createElement(Suspense, { fallback, key: blogRouteStateKey("post-3") }, null);
    const routeWithPendingFallback = learn({
      [routeId]: createElement("main", null, pendingFallback(createElement(PendingLoading))),
    });
    const pageWithPendingFallback = learn({
      [pageId]: pendingFallback(createElement(PendingLoading)),
    });
    // A loading.tsx that renders a pending promise, or a client component in
    // a Set, in the route's mirrored boundary.
    const routeWithPromisedFallback = learn({
      [routeId]: createElement(
        "main",
        null,
        pendingFallback(createElement("div", null, new Promise(() => {}) as never)),
      ),
    });
    const routeWithSetFallback = learn({
      [routeId]: createElement(
        "main",
        null,
        pendingFallback(
          createElement("div", null, new Set([createElement(PendingLoading)]) as never),
        ),
      ),
    });
    // A layout renders its output above the boundary too, down to its own
    // Suspense boundaries, and a client component the elements in its props.
    const PendingClient = lazy(() => () => "Nav");
    const layoutId = "layout:/";
    const layoutWith = (output: ReactNode) =>
      learn({ [layoutId]: createElement("div", null, output, shell[layoutId] as ReactNode) });
    const layoutWithPendingClient = layoutWith(
      createElement("header", null, createElement("nav", null, createElement(PendingClient))),
    );
    const layoutWithPendingProp = layoutWith(
      createElement(Slot, { id: "x", fallback: createElement(PendingClient) } as never),
    );
    const layoutWithPendingRegion = layoutWith(
      createElement(Slot, { id: "x", regions: { nav: createElement(PendingClient) } } as never),
    );
    const layoutWithPendingSet = layoutWith(
      createElement("div", null, new Set([createElement(PendingClient)]) as never),
    );
    const layoutWithIterator = layoutWith(
      createElement("div", null, [createElement("p", { key: "p" })].values() as never),
    );
    // React renders a promise's value once it has fulfilled. Flight decodes
    // one with its status.
    const promised = (promise: Promise<unknown>, status: string, value?: ReactNode) =>
      layoutWith(createElement("div", null, Object.assign(promise, { status, value }) as never));
    const layoutWithPendingPromise = promised(new Promise(() => {}), "pending");
    const layoutWithPromisedClient = promised(
      Promise.resolve(),
      "fulfilled",
      createElement(PendingClient),
    );
    const layoutWithPendingSuspense = layoutWith(
      createElement(Suspense, { fallback: null }, createElement(PendingClient)),
    );
    // A layout renders its named slots' entries too, a client loading.tsx
    // in one, say.
    const slotWithPendingLoading = learn({
      [AppElementsWire.encodeSlotId("sidebar", "/")]: createElement(PendingLoading),
    });
    for (const target of [blogRouteStateKey("post-3"), post4]) {
      expect(createOptimisticRouteElements(routeWithPendingFallback, target)).toBeNull();
      expect(createOptimisticRouteElements(pageWithPendingFallback, target)).toBeNull();
      expect(createOptimisticRouteElements(routeWithPromisedFallback, target)).toBeNull();
      expect(createOptimisticRouteElements(routeWithSetFallback, target)).toBeNull();
      expect(createOptimisticRouteElements(layoutWithPendingClient, target)).toBeNull();
      expect(createOptimisticRouteElements(layoutWithPendingProp, target)).toBeNull();
      expect(createOptimisticRouteElements(layoutWithPendingRegion, target)).toBeNull();
      expect(createOptimisticRouteElements(layoutWithPendingSet, target)).toBeNull();
      expect(createOptimisticRouteElements(layoutWithPendingPromise, target)).toBeNull();
      expect(createOptimisticRouteElements(layoutWithPromisedClient, target)).toBeNull();
      // Reading an iterator's entries would consume them before React does.
      expect(createOptimisticRouteElements(layoutWithIterator, target)).toBeNull();
      expect(createOptimisticRouteElements(slotWithPendingLoading, target)).toBeNull();
      // The layout's own boundary shows its fallback instead.
      expect(createOptimisticRouteElements(layoutWithPendingSuspense, target)).not.toBeNull();
    }
    resolved = true;
    expect(
      createOptimisticRouteElements(layoutWithPendingClient, blogRouteStateKey("post-3")),
    ).not.toBeNull();
    expect(
      createOptimisticRouteElements(slotWithPendingLoading, blogRouteStateKey("post-3")),
    ).not.toBeNull();
    expect(
      createOptimisticRouteElements(layoutWithPendingSet, blogRouteStateKey("post-3")),
    ).not.toBeNull();
    expect(
      createOptimisticRouteElements(layoutWithPromisedClient, blogRouteStateKey("post-3")),
    ).not.toBeNull();
    expect(
      createOptimisticRouteElements(layoutWithPendingPromise, blogRouteStateKey("post-3")),
    ).toBeNull();
    expect(createOptimisticRouteElements(pendingRoute, blogRouteStateKey("post-3"))).not.toBeNull();
    expect(
      createOptimisticRouteElements(routeWithPendingFallback, blogRouteStateKey("post-3")),
    ).not.toBeNull();
    expect(
      createOptimisticRouteElements(pageWithPendingFallback, blogRouteStateKey("post-3")),
    ).not.toBeNull();
    expect(
      createOptimisticRouteElements(routeWithSetFallback, blogRouteStateKey("post-3")),
    ).not.toBeNull();
    expect(
      createOptimisticRouteElements(routeWithPendingType("blog"), blogRouteStateKey("post-3")),
    ).not.toBeNull();
  });

  it("reads the rows a shell rebinds before it is learned", async () => {
    const routeId = routeElementId("post-3");
    const pageId = AppElementsWire.encodePageId("/blog/post-3", null);
    const shell = createBlogMirroredLoadingShellElements("post-3");
    // Flight parses a row when it is first read, and a row that renders a
    // client component then waits for its module.
    const deferred = <T>(value: T): T => {
      let loaded = false;
      let loading: Promise<void> | null = null;
      return {
        $$typeof: Symbol.for("react.lazy"),
        _init: () => {
          if (loaded) return value;
          loading ??= new Promise<void>((resolve) =>
            setTimeout(() => {
              loaded = true;
              resolve();
            }),
          );
          throw loading;
        },
        // React's dev checks read a lazy child's payload.
        _payload: {},
      } as unknown as T;
    };
    // A client loading.tsx, as the page boundary's fallback.
    const Loading = deferred(() => "Loading");
    const Nav = deferred(() => "Nav");
    // A promise a layout renders, which Flight decodes with its status, and
    // which settles after the rows above have loaded.
    const region = Object.assign(new Promise<void>((resolve) => setTimeout(resolve, 10)), {
      status: "pending",
      value: undefined as ReactNode,
    });
    void region.then(() => {
      region.status = "fulfilled";
      region.value = "Region";
    });
    const elements = {
      ...shell,
      [pageId]: deferred(
        createElement(
          Suspense,
          { fallback: createElement(Loading), key: blogRouteStateKey("post-3") },
          null,
        ),
      ),
      // A client component in a layout's output.
      "layout:/": createElement(
        "div",
        null,
        createElement("nav", null, createElement(Nav)),
        region as never,
      ),
      // A row inside a row, around a client component type.
      [routeId]: deferred(
        createElement(
          deferred(Slot),
          { id: "template:/blog", key: JSON.parse(blogRouteStateKey("post-3"))[1] },
          deferred(shell[routeId]) as ReactNode,
        ),
      ),
    } as AppElements;
    await settleOptimisticRouteRows(elements);
    const template = createOptimisticRouteTemplate({
      allowLoadingShell: true,
      basePath: "",
      elements,
      href: "/blog/post-3.rsc",
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeManifest: blogManifest(),
    });
    if (template === null) throw new Error("Expected optimistic route template");
    const post4 = blogRouteStateKey("post-4");
    const payload = createOptimisticRouteElements(template, post4);
    expect(readSuspense(payload![pageId]).key).toBe(post4);
    // The fallback's module has loaded, so the shell commits for its own URL.
    expect(Reflect.get(Loading, "_init")()).toBeTypeOf("function");
    expect(Reflect.get(Nav, "_init")()).toBeTypeOf("function");
    expect(region.status).toBe("fulfilled");
    expect(createOptimisticRouteElements(template, blogRouteStateKey("post-3"))).not.toBeNull();
  });

  it("gives up a shell whose rows don't resolve rather than hold the navigation", async () => {
    vi.useFakeTimers();
    try {
      const routeId = routeElementId("post-3");
      const shell = createBlogMirroredLoadingShellElements("post-3");
      // A client module whose chunk never loads.
      const stalled = new Promise<never>(() => {});
      const elements = {
        ...shell,
        [routeId]: {
          $$typeof: Symbol.for("react.lazy"),
          _init: () => {
            throw stalled;
          },
          _payload: {},
        },
      } as unknown as AppElements;
      let settled = false;
      const settling = settleOptimisticRouteRows(elements).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settling;
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements,
        href: "/blog/post-3.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest: blogManifest(),
      });
      if (template === null) throw new Error("Expected optimistic route template");
      expect(createOptimisticRouteElements(template, blogRouteStateKey("post-4"))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits the shell learned from the target URL itself", () => {
    const routeManifest = blogManifest();
    // The leaf layout is rendered into each shell with its URL's slug.
    const learn = (slug: string) => {
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: {
          ...createBlogMirroredLoadingShellElements(slug),
          [APP_BFCACHE_SEGMENT_IDENTITIES_KEY]: {
            [AppElementsWire.encodePageId(`/blog/${slug}`, null)]: blogPageIdentity(slug),
            "layout:/blog/[slug]": deriveBfcacheSegmentIdentity({
              boundSegmentKey: blogRouteStateKey(slug),
              graphId: "layout:/blog/[slug]",
              kind: "layout",
              rootBoundaryId: "/",
            }),
          },
        },
        href: `/blog/${slug}.rsc`,
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
      });
      if (template === null) throw new Error("Expected optimistic route template");
      return template;
    };
    const routeKey = {
      interceptionContext: null,
      mountedSlotsHeader: null,
      routeId: "route:/blog/:slug",
    };
    const post3 = learn("post-3");
    const post4 = learn("post-4");
    // post-4 was learned last, so it is the route's template too.
    const templates = new Map([
      [getOptimisticRouteTemplateKey(routeKey), post4],
      [
        getOptimisticRouteTemplateKey({ ...routeKey, urlRouteStateKey: post3.urlRouteStateKey }),
        post3,
      ],
      [
        getOptimisticRouteTemplateKey({ ...routeKey, urlRouteStateKey: post4.urlRouteStateKey }),
        post4,
      ],
    ]);
    const resolve = (href: string) =>
      resolveOptimisticNavigationPayload({
        basePath: "",
        href,
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
        templates,
      });

    expect(resolve("/blog/post-3")?.template).toBe(post3);
    expect(resolve("/blog/post-4")?.template).toBe(post4);
    // post-5 has no shell of its own, and the route's template renders post-4's layout.
    expect(resolve("/blog/post-5")).toBeNull();
  });

  it("reads a URL's template only while its prefetch is in the cache", () => {
    const createTemplate = () => {
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: createBlogMirroredLoadingShellElements("post-3"),
        href: "/blog/post-3.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest: blogManifest(),
      });
      if (template === null) throw new Error("Expected optimistic route template");
      return template;
    };
    const template = createTemplate();
    const entry = {};
    const prefetchCache = new Map<string, object>([["/blog/post-3", entry]]);
    const urlTemplates = createOptimisticUrlRouteTemplates();
    const learn = (learnedEntry: object) =>
      setOptimisticUrlRouteTemplate(urlTemplates, {
        cacheKey: "/blog/post-3",
        entry: learnedEntry,
        sourceKey: "source:post-3",
        template,
        urlTemplateKey: "route+post-3",
      });
    const read = () => readOptimisticUrlRouteTemplate(urlTemplates, prefetchCache, "route+post-3");
    const prune = () => pruneOptimisticUrlRouteTemplates(urlTemplates, prefetchCache);

    learn(entry);
    prune();
    expect(read()).toBe(template);
    // A new prefetch of the URL replaces the entry it was learned from. The
    // template isn't read even before a learning pass prunes it.
    prefetchCache.set("/blog/post-3", {});
    expect(read()).toBeUndefined();
    prune();
    expect(urlTemplates.sources.size).toBe(0);
    expect(urlTemplates.owners.size).toBe(0);

    // A prefetch evicted from the cache drops the URL's template too.
    prefetchCache.set("/blog/post-3", entry);
    learn(entry);
    expect(read()).toBe(template);
    prefetchCache.delete("/blog/post-3");
    expect(read()).toBeUndefined();
    prune();
    expect(urlTemplates.sources.size).toBe(0);
    expect(urlTemplates.owners.size).toBe(0);

    // So does one already garbage collected.
    prefetchCache.set("/blog/post-3", entry);
    learn(entry);
    urlTemplates.sources.set("source:post-3", {
      cacheKey: "/blog/post-3",
      entry: { deref: () => undefined } as unknown as WeakRef<object>,
      urlTemplateKey: "route+post-3",
    });
    expect(read()).toBeUndefined();
    prune();
    expect(urlTemplates.sources.size).toBe(0);
    expect(urlTemplates.owners.size).toBe(0);
  });

  it("tracks every prefetch a URL's template was learned from", () => {
    const createTemplate = () => {
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: createBlogMirroredLoadingShellElements("post-3"),
        href: "/blog/post-3.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest: blogManifest(),
      });
      if (template === null) throw new Error("Expected optimistic route template");
      return template;
    };
    const sources = (["a", "b", "c"] as const).map((key) => ({
      cacheKey: `/blog/post-3?${key}`,
      entry: {},
      sourceKey: `source:${key}`,
      template: createTemplate(),
      urlTemplateKey: "route+post-3",
    }));
    // Three cache keys for one URL, learned in order, so the last one learned
    // owns the URL's template.
    const prefetchCache = new Map<string, object>(
      sources.map((source) => [source.cacheKey, source.entry]),
    );
    const urlTemplates = createOptimisticUrlRouteTemplates();
    for (const source of sources) setOptimisticUrlRouteTemplate(urlTemplates, source);
    const read = () => readOptimisticUrlRouteTemplate(urlTemplates, prefetchCache, "route+post-3");
    const prune = () => pruneOptimisticUrlRouteTemplates(urlTemplates, prefetchCache);

    // A prefetch that no longer owns the template only forgets its source, so
    // a new prefetch at its key is learned again.
    prefetchCache.delete("/blog/post-3?a");
    prune();
    expect(read()).toBe(sources[2]!.template);
    expect([...urlTemplates.sources.keys()]).toEqual(["source:b", "source:c"]);

    // Once the owning prefetch goes, the URL's remaining prefetch is learned
    // again rather than left without a template.
    prefetchCache.delete("/blog/post-3?c");
    expect(read()).toBeUndefined();
    prune();
    expect(urlTemplates.sources.size).toBe(0);
    expect(urlTemplates.owners.size).toBe(0);
  });

  it("does not commit a shell for another URL deeper than it rebinds", () => {
    const routeId = routeElementId("post-3");
    const shell = createBlogMirroredLoadingShellElements("post-3");
    const learn = (wrappers: number) => {
      let route = shell[routeId] as ReactNode;
      for (let index = 0; index < wrappers; index++) route = createElement("div", null, route);
      const template = createOptimisticRouteTemplate({
        allowLoadingShell: true,
        basePath: "",
        elements: { ...shell, [routeId]: route } as AppElements,
        href: "/blog/post-3.rsc",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest: blogManifest(),
      });
      if (template === null) throw new Error("Expected optimistic route template");
      return createOptimisticRouteElements(template, blogRouteStateKey("post-4"));
    };
    expect(learn(90)).not.toBeNull();
    // Boundaries below the limit would stay keyed for post-3.
    expect(learn(110)).toBeNull();
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
    expect(
      createOptimisticRouteElements(template!, template!.urlRouteStateKey)![childrenSlotId],
    ).not.toBe(elements[childrenSlotId]);
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
