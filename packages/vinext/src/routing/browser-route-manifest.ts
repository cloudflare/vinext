import type {
  GraphVersion,
  RouteManifest,
  RouteManifestInterception,
  RouteManifestLayout,
  RouteManifestRootBoundary,
  RouteManifestRoute,
  RouteManifestSlotBinding,
} from "./app-route-graph.js";
import { buildOptimisticRouteTrie, matchOptimisticRouteTrie } from "./optimistic-route-trie.js";

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
 * Whether the router sends a URL pathname that both patterns match to the
 * route handler: it wins at the first part whose kind differs. Two patterns
 * that never differ would be the same route shape, which cannot hold both a
 * handler and a page.
 */
function routeHandlerOutranks(handler: readonly string[], rendered: readonly string[]): boolean {
  for (let index = 0; ; index++) {
    const handlerRank = patternPartRank(handler[index]);
    const renderedRank = patternPartRank(rendered[index]);
    if (handlerRank !== renderedRank) return handlerRank < renderedRank;
    if (handlerRank === 0 || handlerRank >= 3) return false;
  }
}

// No static route segment, a directory name, can contain "/".
const PROBE_SEGMENT = "/";

/**
 * URL pathnames that stand for every URL the handler pattern matches on the
 * optimistic trie: a param value that equals a static segment descends into
 * that static subtree, whose routes outrank the handler there.
 */
function routeHandlerProbes(handler: readonly string[]): string[][] {
  const parts = handler.map((part) => (part.startsWith(":") ? PROBE_SEGMENT : part));
  return handler.at(-1)?.endsWith("*") ? [parts.slice(0, -1), parts] : [parts];
}

/**
 * The browser only needs a route handler where the optimistic route trie of
 * the rendered routes would predict a route the handler outranks: the matcher
 * must find the handler there instead of rendering that route's shell. Any
 * other handler URL matches no rendered route on the client, or one the
 * router prefers, and its non-Flight response already turns the navigation
 * into a document load, so shipping its path would only publish the app's
 * API surface (issue #3624).
 */
function selectBrowserRoutes(routes: Iterable<RouteManifestRoute>): RouteManifestRoute[] {
  const allRoutes = [...routes];
  const renderedTrie = buildOptimisticRouteTrie(
    allRoutes.filter((route) => route.routeHandlerId === null),
  );
  return allRoutes.filter(
    (route) =>
      route.routeHandlerId === null ||
      routeHandlerProbes(route.patternParts).some((urlParts) => {
        const rendered = matchOptimisticRouteTrie(renderedTrie, urlParts)?.route;
        return (
          rendered !== undefined && routeHandlerOutranks(route.patternParts, rendered.patternParts)
        );
      }),
  );
}

/**
 * The graph records the browser receives: the shipped routes, their slot
 * bindings, and the layouts and root boundaries those and the interceptions
 * reach. Records only omitted route handlers reach would still name those
 * handlers' directories, and the browser reads no others.
 */
function selectBrowserGraph(graph: RouteManifest["segmentGraph"]) {
  const routes = selectBrowserRoutes(graph.routes.values());
  const routeIds = new Set(routes.map((route) => route.id));
  const slotBindings = [...graph.slotBindings.values()].filter((binding) =>
    routeIds.has(binding.routeId),
  );
  const layoutIds = new Set([
    ...routes.flatMap((route) => route.layoutIds),
    ...slotBindings.flatMap((binding) => binding.ownerLayoutId ?? []),
    ...[...graph.interceptions.values()].flatMap(
      (interception) => interception.ownerLayoutId ?? [],
    ),
  ]);
  const layouts = [...graph.layouts.values()].filter((layout) => layoutIds.has(layout.id));
  const rootBoundaryIds = new Set(
    [...routes, ...layouts].flatMap((record) => record.rootBoundaryId ?? []),
  );
  const rootBoundaries = [...graph.rootBoundaries.values()].filter((rootBoundary) =>
    rootBoundaryIds.has(rootBoundary.id),
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
