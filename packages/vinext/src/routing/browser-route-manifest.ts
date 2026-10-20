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

export function toBrowserRouteManifestWire(routeManifest: RouteManifest): BrowserRouteManifestWire {
  const graph = routeManifest.segmentGraph;
  return {
    graphVersion: routeManifest.graphVersion,
    routes: Array.from(graph.routes.values(), (route) => ({
      ...(route.id === createRouteIdFromPatternParts(route.patternParts) ? {} : { id: route.id }),
      patternParts: route.patternParts,
      isDynamic: route.isDynamic,
      paramNames: route.paramNames,
      rootBoundaryId: route.rootBoundaryId,
      pageId: route.pageId,
      layoutIds: route.layoutIds,
      slotIds: route.slotIds,
    })),
    layouts: Array.from(graph.layouts.values(), (layout) => ({
      id: layout.id,
      patternParts: layout.patternParts,
      rootBoundaryId: layout.rootBoundaryId,
    })),
    slotBindings: Array.from(graph.slotBindings.values(), (binding) => ({
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
    rootBoundaries: Array.from(graph.rootBoundaries.values(), (rootBoundary) => ({
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
