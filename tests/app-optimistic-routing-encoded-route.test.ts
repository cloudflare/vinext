import { describe, expect, it } from "vite-plus/test";
import { createElement, type ReactNode } from "react";
import {
  APP_PREFETCH_LOADING_SHELL_MARKER_KEY,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import {
  createOptimisticRouteTemplate,
  getOptimisticRouteTemplateKey,
  resolveOptimisticNavigationPayload,
  type OptimisticRouteTemplate,
} from "../packages/vinext/src/server/app-optimistic-routing.js";
import { createAppPageRenderIdentity } from "../packages/vinext/src/server/app-page-render-identity.js";
import { buildAppPageElements } from "../packages/vinext/src/server/app-page-route-wiring.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "../packages/vinext/src/server/app-rsc-render-mode.js";
import type {
  GraphVersion,
  RouteManifest,
  RouteManifestRoute,
} from "../packages/vinext/src/routing/app-route-graph.js";

// The browser can't tell which route the server renders for a percent-encoded
// pathname: the server matches static segments on their raw spelling, and a
// dynamic sibling renders another spelling of a static page without a
// recorded prerender (see "renders the dynamic sibling for another spelling of
// a page without a recorded prerender" in tests/app-rsc-route-matching.test.ts).

function RootLayout({ children }: { children?: ReactNode }): ReactNode {
  return createElement("html", null, createElement("body", null, children));
}

function SlugLoading(): ReactNode {
  return createElement("p", null, "Loading [slug]...");
}

function SlugPage(): ReactNode {
  return createElement("p", null, "[slug] page");
}

function manifestRoute(input: {
  id: string;
  isDynamic: boolean;
  paramNames?: readonly string[];
  pattern: string;
  patternParts: readonly string[];
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
    slotIds: [],
    templateIds: [],
  };
}

// app/<staticName>/page and app/[slug]/page.
function manifest(staticName: string): RouteManifest {
  const routes = [
    manifestRoute({
      id: `route:/${staticName}`,
      isDynamic: false,
      pattern: `/${staticName}`,
      patternParts: [staticName],
    }),
    manifestRoute({
      id: "route:/:slug",
      isDynamic: true,
      paramNames: ["slug"],
      pattern: "/:slug",
      patternParts: [":slug"],
    }),
  ];
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
      slotBindings: new Map(),
      slots: new Map(),
      templates: new Map(),
    },
  };
}

// The loading-shell prefetch payload the server builds when `/[slug]` renders
// `routePath`, the raw pathname it matched, for a request to `displayPathname`.
function slugLoadingShell(displayPathname: string, routePath: string): AppElements {
  const slug = decodeURIComponent(routePath.slice(1));
  const elements = buildAppPageElements({
    element: createElement(SlugPage),
    makeThenableParams(params) {
      return Promise.resolve(params);
    },
    matchedParams: { slug },
    renderIdentity: createAppPageRenderIdentity({
      displayPathname,
      matchedRoutePathname: routePath,
      targetMatchedPathname: routePath,
    }),
    renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
    route: {
      error: null,
      errors: [null],
      ids: {
        layouts: ["layout:/"],
        page: "page:/:slug",
        rootBoundary: null,
        route: "route:/:slug",
        routeHandler: null,
        slots: {},
        templates: [],
      },
      layoutTreePositions: [0],
      layouts: [{ default: RootLayout }],
      loading: { default: SlugLoading },
      notFound: null,
      notFounds: [null],
      routeSegments: ["[slug]"],
      templateTreePositions: [],
      templates: [],
    },
    routePath,
    rootNotFoundModule: null,
  });
  expect(elements[APP_PREFETCH_LOADING_SHELL_MARKER_KEY]).toBe("LoadingBoundary");
  return elements;
}

function learn(options: { elements: AppElements; href: string; routeManifest: RouteManifest }) {
  return createOptimisticRouteTemplate({
    allowLoadingShell: true,
    basePath: "",
    elements: options.elements,
    href: options.href,
    interceptionContext: null,
    mountedSlotsHeader: null,
    routeManifest: options.routeManifest,
  });
}

describe("optimistic templates for percent-encoded pathnames", () => {
  it("does not store a /[slug] shell prefetched via /%61dmin under the static /admin route", () => {
    // The server matches `/%61dmin` raw: the static `/admin` (no prerender)
    // doesn't take it, `/[slug]` renders it.
    const routeManifest = manifest("admin");
    const template = learn({
      elements: slugLoadingShell("/%61dmin", "/%61dmin"),
      href: "/%61dmin",
      routeManifest,
    });

    // Either learn it for the route that rendered it, or learn nothing; never
    // for `/admin`, which would show `/[slug]`'s loading UI on `/admin`.
    expect(template?.routeId ?? null).not.toBe("route:/admin");

    const templates = new Map<string, OptimisticRouteTemplate>();
    if (template !== null) {
      templates.set(
        getOptimisticRouteTemplateKey({
          interceptionContext: null,
          mountedSlotsHeader: null,
          routeId: template.routeId,
        }),
        template,
      );
    }
    expect(
      resolveOptimisticNavigationPayload({
        basePath: "",
        href: "/admin",
        interceptionContext: null,
        mountedSlotsHeader: null,
        routeManifest,
        templates,
      }),
    ).toBeNull();
  });

  it("learns the /[slug] shell when middleware rewrites /b to /%61", () => {
    // `/[slug]` renders `/%61`, which the server doesn't match to the static
    // `/a`. `/b` matches `/[slug]` too, so the shell is the URL's route's.
    const template = learn({
      elements: slugLoadingShell("/b", "/%61"),
      href: "/b",
      routeManifest: manifest("a"),
    });

    expect(template?.routeId ?? null).toBe("route:/:slug");
    expect(template?.params).toEqual({ slug: "b" });
  });
});
