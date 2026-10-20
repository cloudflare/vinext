import type {
  GraphVersion,
  RouteManifest,
  RouteManifestInterception,
  RouteManifestLayout,
  RouteManifestRootBoundary,
  RouteManifestRoute,
  RouteManifestSlotBinding,
} from "./app-route-graph.js";

export type BrowserRouteManifestRoute = Pick<
  RouteManifestRoute,
  | "id"
  | "patternParts"
  | "isDynamic"
  | "paramNames"
  | "rootBoundaryId"
  | "pageId"
  | "layoutIds"
  | "slotIds"
>;

type BrowserRouteManifestLayout = Pick<
  RouteManifestLayout,
  "id" | "patternParts" | "rootBoundaryId"
>;

type BrowserRouteManifestSlotBinding = Pick<
  RouteManifestSlotBinding,
  | "id"
  | "routeId"
  | "slotId"
  | "ownerLayoutId"
  | "state"
  | "routeSegments"
  | "slotPatternParts"
  | "slotParamNames"
>;

export type BrowserRouteManifestInterception = Pick<
  RouteManifestInterception,
  "id" | "sourcePatternParts" | "targetPatternParts" | "slotId" | "ownerLayoutId" | "targetRouteId"
>;

type BrowserRouteManifestRootBoundary = Pick<RouteManifestRootBoundary, "id" | "treePath">;

/**
 * The part of the RouteManifest the browser navigation runtime reads: the
 * maps and fields the navigation planner, optimistic routing and interception
 * context resolution use.
 */
export type BrowserRouteManifest = {
  graphVersion: GraphVersion;
  segmentGraph: {
    routes: ReadonlyMap<string, BrowserRouteManifestRoute>;
    layouts: ReadonlyMap<string, BrowserRouteManifestLayout>;
    slotBindings: ReadonlyMap<string, BrowserRouteManifestSlotBinding>;
    interceptions: ReadonlyMap<string, BrowserRouteManifestInterception>;
    interceptionsBySlotId: ReadonlyMap<string, readonly BrowserRouteManifestInterception[]>;
    rootBoundaries: ReadonlyMap<string, BrowserRouteManifestRootBoundary>;
  };
};

/**
 * JSON form of `BrowserRouteManifest`. Every map is keyed by its values' `id`,
 * so maps travel as arrays of values in map order. A route omits `id` when it
 * is `route:` plus its pattern, and `interceptionsBySlotId` lists interception
 * ids instead of repeating the interceptions.
 */
export type BrowserRouteManifestWire = {
  graphVersion: string;
  routes: (Omit<BrowserRouteManifestRoute, "id"> & { id?: string })[];
  layouts: BrowserRouteManifestLayout[];
  slotBindings: BrowserRouteManifestSlotBinding[];
  interceptions: BrowserRouteManifestInterception[];
  interceptionsBySlotId: [slotId: string, interceptionIds: string[]][];
  rootBoundaries: BrowserRouteManifestRootBoundary[];
};

function createRouteIdFromPatternParts(patternParts: readonly string[]): string {
  return `route:/${patternParts.join("/")}`;
}

function isParamPart(part: string | undefined, suffix: "" | "+" | "*"): boolean {
  return part !== undefined && part.startsWith(":") && (suffix === "" || part.endsWith(suffix));
}

/**
 * Whether some URL pathname matches both route patterns. A catch-all is always
 * the last part and takes whatever the other pattern's remainder produces: a
 * required catch-all needs at least one more segment, an optional one also
 * accepts none.
 */
function routePatternsOverlap(a: readonly string[], b: readonly string[], index = 0): boolean {
  const partA = a[index];
  const partB = b[index];
  if (isParamPart(partA, "*") || isParamPart(partB, "*")) return true;
  if (isParamPart(partA, "+")) return partB !== undefined;
  if (isParamPart(partB, "+")) return partA !== undefined;
  if (partA === undefined || partB === undefined) return partA === partB;
  if (!isParamPart(partA, "") && !isParamPart(partB, "") && partA !== partB) return false;
  return routePatternsOverlap(a, b, index + 1);
}

/**
 * Route matching precedence of one pattern part, lower wins: the URL ending
 * here, then a static, dynamic, catch-all and optional catch-all part.
 */
function patternPartRank(part: string | undefined): number {
  if (part === undefined) return 0;
  if (!part.startsWith(":")) return 1;
  if (part.endsWith("+")) return 3;
  if (part.endsWith("*")) return 4;
  return 2;
}

/**
 * Whether the route handler wins some URL pathname that the rendered route
 * also matches. Both route matchers walk the parts in order and take the
 * first part kind that differs by precedence, so the handler shadows the
 * rendered route only when it wins at that part and the remainders overlap.
 */
function routeHandlerShadowsRoute(
  handler: readonly string[],
  rendered: readonly string[],
  index = 0,
): boolean {
  const handlerPart = handler[index];
  const renderedPart = rendered[index];
  const handlerRank = patternPartRank(handlerPart);
  const renderedRank = patternPartRank(renderedPart);
  if (handlerRank !== renderedRank) {
    return handlerRank < renderedRank && routePatternsOverlap(handler, rendered, index);
  }
  // Equal ends or catch-alls would be the same route shape, which cannot
  // hold both a handler and a page.
  if (handlerRank === 0 || handlerRank >= 3) return false;
  if (handlerRank === 1 && handlerPart !== renderedPart) return false;
  return routeHandlerShadowsRoute(handler, rendered, index + 1);
}

/**
 * The browser only needs a route handler that wins a URL another route also
 * matches: the optimistic route matcher must find the handler there instead
 * of predicting that route's shell. Any other handler URL is either won by a
 * rendered route or matches nothing on the client, and its non-Flight
 * response already turns the navigation into a document load, so shipping
 * its path would only publish the app's API surface (issue #3624).
 */
function selectBrowserRoutes(routes: Iterable<RouteManifestRoute>): RouteManifestRoute[] {
  const allRoutes = [...routes];
  const renderedRoutes = allRoutes.filter((route) => route.routeHandlerId === null);
  return allRoutes.filter(
    (route) =>
      route.routeHandlerId === null ||
      renderedRoutes.some((other) =>
        routeHandlerShadowsRoute(route.patternParts, other.patternParts),
      ),
  );
}

/**
 * The graph records the browser receives. Layouts and root boundaries that
 * only omitted route handlers reach would still name those handlers'
 * directories, so they are left out too; records shared with a shipped route,
 * slot binding or interception stay.
 */
function selectBrowserGraph(graph: RouteManifest["segmentGraph"]) {
  const routes = selectBrowserRoutes(graph.routes.values());
  const routeIds = new Set(routes.map((route) => route.id));
  const omittedRoutes = [...graph.routes.values()].filter((route) => !routeIds.has(route.id));
  const slotBindings = [...graph.slotBindings.values()].filter((binding) =>
    routeIds.has(binding.routeId),
  );

  const keptLayoutIds = new Set([
    ...routes.flatMap((route) => route.layoutIds),
    ...slotBindings.flatMap((binding) => binding.ownerLayoutId ?? []),
    ...[...graph.interceptions.values()].flatMap(
      (interception) => interception.ownerLayoutId ?? [],
    ),
  ]);
  const omittedLayoutIds = new Set(
    omittedRoutes.flatMap((route) => route.layoutIds).filter((id) => !keptLayoutIds.has(id)),
  );
  const allLayouts = [...graph.layouts.values()];
  const layouts = allLayouts.filter((layout) => !omittedLayoutIds.has(layout.id));
  const omittedLayouts = allLayouts.filter((layout) => omittedLayoutIds.has(layout.id));

  const keptRootBoundaryIds = new Set(
    [...routes, ...layouts].flatMap((record) => record.rootBoundaryId ?? []),
  );
  const omittedRootBoundaryIds = new Set(
    [...omittedRoutes, ...omittedLayouts]
      .flatMap((record) => record.rootBoundaryId ?? [])
      .filter((id) => !keptRootBoundaryIds.has(id)),
  );
  const rootBoundaries = [...graph.rootBoundaries.values()].filter(
    (rootBoundary) => !omittedRootBoundaryIds.has(rootBoundary.id),
  );

  return { routes, layouts, slotBindings, rootBoundaries };
}

export function toBrowserRouteManifestWire(routeManifest: RouteManifest): BrowserRouteManifestWire {
  const graph = routeManifest.segmentGraph;
  const browserGraph = selectBrowserGraph(graph);
  return {
    graphVersion: routeManifest.graphVersion,
    routes: browserGraph.routes.map((route) => ({
      ...(route.id === createRouteIdFromPatternParts(route.patternParts) ? {} : { id: route.id }),
      patternParts: route.patternParts,
      isDynamic: route.isDynamic,
      paramNames: route.paramNames,
      rootBoundaryId: route.rootBoundaryId,
      pageId: route.pageId,
      layoutIds: route.layoutIds,
      slotIds: route.slotIds,
    })),
    layouts: browserGraph.layouts.map((layout) => ({
      id: layout.id,
      patternParts: layout.patternParts,
      rootBoundaryId: layout.rootBoundaryId,
    })),
    slotBindings: browserGraph.slotBindings.map((binding) => ({
      id: binding.id,
      routeId: binding.routeId,
      slotId: binding.slotId,
      ownerLayoutId: binding.ownerLayoutId,
      state: binding.state,
      routeSegments: binding.routeSegments,
      slotPatternParts: binding.slotPatternParts,
      slotParamNames: binding.slotParamNames,
    })),
    interceptions: Array.from(graph.interceptions.values(), (interception) => ({
      id: interception.id,
      sourcePatternParts: interception.sourcePatternParts,
      targetPatternParts: interception.targetPatternParts,
      slotId: interception.slotId,
      ownerLayoutId: interception.ownerLayoutId,
      targetRouteId: interception.targetRouteId,
    })),
    interceptionsBySlotId: Array.from(graph.interceptionsBySlotId, ([slotId, interceptions]) => [
      slotId,
      interceptions.map((interception) => interception.id),
    ]),
    rootBoundaries: browserGraph.rootBoundaries.map((rootBoundary) => ({
      id: rootBoundary.id,
      treePath: rootBoundary.treePath,
    })),
  };
}

function mapById<Value extends { id: string }>(values: readonly Value[]): Map<string, Value> {
  return new Map(values.map((value) => [value.id, value]));
}

export function decodeBrowserRouteManifest(wire: BrowserRouteManifestWire): BrowserRouteManifest {
  const interceptions = mapById(wire.interceptions);
  return {
    graphVersion: wire.graphVersion,
    segmentGraph: {
      routes: mapById(
        wire.routes.map((route) => ({
          ...route,
          id: route.id ?? createRouteIdFromPatternParts(route.patternParts),
        })),
      ),
      layouts: mapById(wire.layouts),
      slotBindings: mapById(wire.slotBindings),
      interceptions,
      interceptionsBySlotId: new Map(
        wire.interceptionsBySlotId.map(([slotId, interceptionIds]) => [
          slotId,
          interceptionIds.flatMap((id) => interceptions.get(id) ?? []),
        ]),
      ),
      rootBoundaries: mapById(wire.rootBoundaries),
    },
  };
}
