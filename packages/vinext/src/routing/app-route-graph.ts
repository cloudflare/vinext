/**
 * App Router route graph construction.
 *
 * Scans app/ directories and materializes route metadata before the request-time
 * matcher consumes it. Keep request matching and cache ownership in app-router.ts.
 */
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { compareRoutes, decodeRouteSegment } from "./utils.js";
import { scanWithExtensions, type ValidFileMatcher } from "./file-matcher.js";
import { validateRoutePatterns } from "./route-validation.js";

export type InterceptingRoute = {
  /** The interception convention: "." | ".." | "../.." | "..." */
  convention: string;
  /** The URL pattern this intercepts (e.g. "/photos/:id") */
  targetPattern: string;
  /**
   * URL pattern of the *intercepting route* — the path that owns the slot
   * containing this interception marker, with route groups and `@slot`
   * segments stripped. Mirrors Next.js' `interceptingRoute` from
   * `extractInterceptionRouteInformation`.
   *
   * Used at request time to gate `findIntercept` against the Next-URL /
   * interception-context header: an intercept only fires when the source
   * pathname matches `^<sourceMatchPattern>(?:/.*)?$`. Without this gate
   * a direct RSC fetch to the intercept target would render the modal
   * instead of the underlying page.
   *
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/interception-routes.ts
   */
  sourceMatchPattern: string;
  /** Absolute path to the intercepting page component */
  pagePath: string;
  /** Absolute layout paths inside the intercepting route tree, outermost to innermost */
  layoutPaths: string[];
  /** Parameter names for dynamic segments */
  params: string[];
};

export type ParallelSlot = {
  /** Graph-owned semantic slot identity. Required on AppRouteGraphParallelSlot. */
  id?: string;
  /** Stable slot identity (name + owning directory), used for route serialization keys. */
  key: string;
  /** Slot name (e.g. "team" from @team) */
  name: string;
  /** Absolute path to the @slot directory that owns this slot. Internal routing metadata. */
  ownerDir: string;
  /** Stable tree path for the directory whose layout owns this slot. */
  ownerTreePath: string;
  /** Whether the slot owner directory declares its own page component. */
  hasPage: boolean;
  /** Absolute path to the slot's page component */
  pagePath: string | null;
  /** Absolute path to the slot's default.tsx fallback */
  defaultPath: string | null;
  /** Absolute path to the slot's layout component (wraps slot content) */
  layoutPath: string | null;
  /** Absolute path to the slot's loading component */
  loadingPath: string | null;
  /** Absolute path to the slot's error component */
  errorPath: string | null;
  /** Intercepting routes within this slot */
  interceptingRoutes: InterceptingRoute[];
  /**
   * The layout index (0-based, in route.layouts[]) that this slot belongs to.
   * Slots are passed as props to the layout at their directory level, not
   * necessarily the innermost layout. -1 means "innermost" (legacy default).
   */
  layoutIndex: number;
  /**
   * Filesystem segments from the slot's root directory to its active page.
   * Used at render time to compute segments for useSelectedLayoutSegment(slotName).
   * For a page at the slot root (@team/page.tsx), this is [].
   * For a sub-page (@team/members/page.tsx), this is ["members"].
   * null when the slot has no active page (showing default.tsx fallback).
   */
  routeSegments: string[] | null;
  /**
   * Full URL pattern parts for the slot's active page (owner prefix +
   * slot-relative pattern). Set when an inherited slot mirrors a sub-page
   * whose param names may differ from the route's. The runtime matches the
   * request URL against these parts to extract slot-specific params.
   */
  slotPatternParts?: string[];
  /**
   * Param names captured by `slotPatternParts`, in order of appearance.
   * Used at runtime to decide whether to extract slot-specific params or
   * reuse the route's matched params.
   */
  slotParamNames?: string[];
};

export type AppRoute = {
  /** Graph-owned semantic identities. Required on AppRouteGraphRoute. */
  ids?: AppRouteSemanticIds;
  /** URL pattern, e.g. "/" or "/about" or "/blog/:slug" */
  pattern: string;
  /** Absolute file path to the page component */
  pagePath: string | null;
  /** Absolute file path to the route handler (route.ts) */
  routePath: string | null;
  /** Ordered list of layout files from root to leaf */
  layouts: string[];
  /** Ordered list of all discovered template files from root to leaf (not necessarily aligned 1:1 with layouts) */
  templates: string[];
  /** Parallel route slots (from @slot directories at the route's directory level) */
  parallelSlots: ParallelSlot[];
  /** Loading component path */
  loadingPath: string | null;
  /** Error component path (leaf directory only) */
  errorPath: string | null;
  /**
   * Per-layout error boundary paths, aligned with the layouts array.
   * Each entry is the error.tsx at the same directory level as the
   * corresponding layout (or null if that level has no error.tsx).
   */
  layoutErrorPaths: (string | null)[];
  /** Per-segment error boundary paths, aligned with errorTreePositions. */
  errorPaths?: string[];
  /** Tree position (directory depth from app/ root) for each error boundary. */
  errorTreePositions?: number[];
  /** Not-found component path (nearest, walking up from page dir) */
  notFoundPath: string | null;
  /**
   * Not-found component paths per layout level (aligned with layouts array).
   * Each entry is the not-found.tsx at that layout's directory, or null.
   * Used to create per-layout NotFoundBoundary so that notFound() thrown from
   * a layout is caught by the parent layout's boundary (matching Next.js behavior).
   */
  notFoundPaths: (string | null)[];
  /**
   * Forbidden component paths per layout level (aligned with layouts array).
   * Each entry is the forbidden.tsx at that layout's directory, or null.
   * Used to create per-layout ForbiddenBoundary.
   */
  forbiddenPaths: (string | null)[];
  /** Forbidden component path (403) at the route's directory level */
  forbiddenPath: string | null;
  /** Unauthorized component path (401) at the route's directory level */
  unauthorizedPath: string | null;
  /** Unauthorized component paths per layout level (aligned with layouts array). */
  unauthorizedPaths: (string | null)[];
  /**
   * Filesystem segments from app/ root to the route's directory.
   * Includes route groups and dynamic segments (as template strings like "[id]").
   * Used at render time to compute the child segments for useSelectedLayoutSegments().
   */
  routeSegments: string[];
  /** Tree position (directory depth from app/ root) for each template. */
  templateTreePositions?: number[];
  /**
   * Tree position (directory depth from app/ root) for each layout.
   * Used to slice routeSegments and determine which segments are below each layout.
   * For example, root layout = 0, a layout at app/blog/ = 1, app/blog/(group)/ = 2.
   * Unlike the old layoutSegmentDepths, this counts ALL directory levels including
   * route groups and parallel slots.
   */
  layoutTreePositions: number[];
  /** Whether this is a dynamic route */
  isDynamic: boolean;
  /** Parameter names for dynamic segments */
  params: string[];
  /** Dynamic parameter names captured by the route's root layout. */
  rootParamNames?: string[];
  /** Pre-split pattern segments (computed once at scan time, reused per request) */
  patternParts: string[];
};

export type AppRouteSemanticIds = {
  route: string;
  page: string | null;
  routeHandler: string | null;
  rootBoundary: RootBoundaryId | null;
  layouts: readonly string[];
  templates: readonly string[];
  /**
   * Bridge map for the current route metadata shape: keyed by `slot.key`
   * (`name@relative/path` infrastructure id), value is the graph-owned semantic slot id.
   */
  slots: Readonly<Record<string, string>>;
};

export type AppRouteGraphParallelSlot = ParallelSlot & {
  id: string;
};

export type AppRouteGraphRoute = Omit<AppRoute, "ids" | "parallelSlots" | "rootParamNames"> & {
  ids: AppRouteSemanticIds;
  parallelSlots: AppRouteGraphParallelSlot[];
  rootParamNames: string[];
};

type Flavor<T, Brand extends string> = T & { readonly __flavor?: Brand };

export type GraphVersion = Flavor<string, "GraphVersion">;
export type RootBoundaryId = Flavor<string, "RootBoundaryId">;

export type RouteManifestRoute = {
  id: string;
  pattern: string;
  patternParts: readonly string[];
  isDynamic: boolean;
  paramNames: readonly string[];
  rootParamNames: readonly string[];
  rootBoundaryId: RootBoundaryId | null;
  pageId: string | null;
  routeHandlerId: string | null;
  layoutIds: readonly string[];
  templateIds: readonly string[];
  slotIds: readonly string[];
};

export type RouteManifestPage = {
  id: string;
  routeId: string;
  pattern: string;
};

export type RouteManifestRouteHandler = {
  id: string;
  routeId: string;
  pattern: string;
};

export type RouteManifestLayout = {
  id: string;
  treePath: string;
  patternParts: readonly string[];
  paramNames: readonly string[];
  rootBoundaryId: RootBoundaryId | null;
};

export type RouteManifestTemplate = {
  id: string;
  treePath: string;
  rootBoundaryId: RootBoundaryId | null;
  ownerLayoutId: string | null;
  reset: {
    kind: "remountSubtree";
    treePath: string;
  };
};

export type RouteManifestSlot = {
  id: string;
  key: string;
  name: string;
  ownerTreePath: string;
  ownerLayoutId: string | null;
  rootBoundaryId: RootBoundaryId | null;
  defaultId: string | null;
  hasDefault: boolean;
  hasPage: boolean;
};

export type RouteManifestDefault = {
  id: string;
  slotId: string;
  ownerTreePath: string;
  ownerLayoutId: string | null;
  rootBoundaryId: RootBoundaryId | null;
};

export type RouteManifestSlotBindingState = "active" | "default" | "unmatched";

export type RouteManifestSlotBinding = {
  id: string;
  routeId: string;
  slotId: string;
  ownerLayoutId: string | null;
  state: RouteManifestSlotBindingState;
  defaultId: string | null;
  routeSegments: readonly string[] | null;
  slotPatternParts?: readonly string[];
  slotParamNames?: readonly string[];
};

export type RouteManifestInterception = {
  id: string;
  sourcePattern: string;
  sourcePatternParts: readonly string[];
  targetPattern: string;
  targetPatternParts: readonly string[];
  slotId: string;
  ownerLayoutId: string | null;
  interceptingRouteId: string | null;
  targetRouteId: string | null;
};

export type RouteManifestBoundaryOutcome = "error" | "forbidden" | "notFound" | "unauthorized";

export type RouteManifestBoundary = {
  id: string;
  outcome: RouteManifestBoundaryOutcome;
  treePath: string;
  ownerLayoutId: string | null;
  rootBoundaryId: RootBoundaryId | null;
};

export type RouteManifestRootBoundary = {
  id: RootBoundaryId;
  layoutId: string;
  treePath: string;
};

export type StaticSegmentGraph = {
  routes: ReadonlyMap<string, RouteManifestRoute>;
  pages: ReadonlyMap<string, RouteManifestPage>;
  routeHandlers: ReadonlyMap<string, RouteManifestRouteHandler>;
  layouts: ReadonlyMap<string, RouteManifestLayout>;
  templates: ReadonlyMap<string, RouteManifestTemplate>;
  slots: ReadonlyMap<string, RouteManifestSlot>;
  defaults: ReadonlyMap<string, RouteManifestDefault>;
  slotBindings: ReadonlyMap<string, RouteManifestSlotBinding>;
  interceptions: ReadonlyMap<string, RouteManifestInterception>;
  interceptionsBySlotId: ReadonlyMap<string, readonly RouteManifestInterception[]>;
  boundaries: ReadonlyMap<string, RouteManifestBoundary>;
  rootBoundaries: ReadonlyMap<RootBoundaryId, RouteManifestRootBoundary>;
};

export type RouteManifest = {
  graphVersion: GraphVersion;
  segmentGraph: StaticSegmentGraph;
};

function createAppRouteGraphRouteId(pattern: string): string {
  return `route:${pattern}`;
}

function createAppRouteGraphPageId(pattern: string): string {
  return `page:${pattern}`;
}

function createAppRouteGraphRouteHandlerId(pattern: string): string {
  return `route-handler:${pattern}`;
}

function createAppRouteGraphLayoutId(treePath: string): string {
  return `layout:${treePath}`;
}

function createAppRouteGraphTemplateId(treePath: string): string {
  return `template:${treePath}`;
}

function createAppRouteGraphSlotId(slotName: string, ownerTreePath: string): string {
  return `slot:${slotName}:${ownerTreePath}`;
}

function createAppRouteGraphDefaultId(slotId: string): string {
  return `default:${slotId}`;
}

function createAppRouteGraphInterceptionId(
  slotId: string,
  sourcePattern: string,
  targetPattern: string,
): string {
  return `interception:${slotId}:${sourcePattern}->${targetPattern}`;
}

function createAppRouteGraphRootBoundaryId(treePath: string): RootBoundaryId {
  return `root-boundary:${treePath}`;
}

function compareStableStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedMapValues<T>(map: ReadonlyMap<string, T>): T[] {
  return Array.from(map.entries())
    .sort(([left], [right]) => compareStableStrings(left, right))
    .map(([, value]) => value);
}

function createRouteManifest(routes: readonly AppRouteGraphRoute[]): RouteManifest {
  const segmentGraph = createStaticSegmentGraph(routes);

  return {
    graphVersion: createRouteManifestGraphVersion(segmentGraph),
    segmentGraph,
  };
}

function createStaticSegmentGraph(routes: readonly AppRouteGraphRoute[]): StaticSegmentGraph {
  const routeEntries = new Map<string, RouteManifestRoute>();
  const pages = new Map<string, RouteManifestPage>();
  const routeHandlers = new Map<string, RouteManifestRouteHandler>();
  const layouts = new Map<string, RouteManifestLayout>();
  const templates = new Map<string, RouteManifestTemplate>();
  const slots = new Map<string, RouteManifestSlot>();
  const defaults = new Map<string, RouteManifestDefault>();
  const slotBindings = new Map<string, RouteManifestSlotBinding>();
  const interceptions = new Map<string, RouteManifestInterception>();
  const boundaries = new Map<string, RouteManifestBoundary>();
  const rootBoundaries = new Map<RootBoundaryId, RouteManifestRootBoundary>();
  const routeIdByPattern = createRouteManifestRouteIdByPattern(routes);

  for (const route of routes) {
    routeEntries.set(route.ids.route, {
      id: route.ids.route,
      pattern: route.pattern,
      patternParts: [...route.patternParts],
      isDynamic: route.isDynamic,
      paramNames: [...route.params],
      rootParamNames: [...route.rootParamNames],
      rootBoundaryId: route.ids.rootBoundary,
      pageId: route.ids.page,
      routeHandlerId: route.ids.routeHandler,
      layoutIds: [...route.ids.layouts],
      templateIds: [...route.ids.templates],
      slotIds: route.parallelSlots.map((slot) => slot.id).sort(compareStableStrings),
    });

    if (route.ids.page) {
      pages.set(route.ids.page, {
        id: route.ids.page,
        routeId: route.ids.route,
        pattern: route.pattern,
      });
    }

    if (route.ids.routeHandler) {
      routeHandlers.set(route.ids.routeHandler, {
        id: route.ids.routeHandler,
        routeId: route.ids.route,
        pattern: route.pattern,
      });
    }

    for (const [index, layoutId] of route.ids.layouts.entries()) {
      const treePosition = route.layoutTreePositions[index];
      assertRouteManifestTreePosition("layout", route, layoutId, treePosition);

      const treePath = createAppRouteGraphTreePath(route.routeSegments, treePosition);
      const existingLayout = layouts.get(layoutId);
      if (existingLayout) {
        assertRouteManifestRootBoundary("layout", route, layoutId, existingLayout.rootBoundaryId);
      }
      const layoutRouteParts = convertTreePathToRouteParts(treePath);
      const layout = {
        id: layoutId,
        treePath,
        patternParts: layoutRouteParts.urlSegments,
        paramNames: layoutRouteParts.params,
        rootBoundaryId: route.ids.rootBoundary,
      };
      layouts.set(layoutId, layout);
      addRouteManifestBoundaryFacts({
        boundaries,
        route,
        layoutId,
        treePath,
        layoutIndex: index,
      });

      if (index === 0 && route.ids.rootBoundary) {
        rootBoundaries.set(route.ids.rootBoundary, {
          id: route.ids.rootBoundary,
          layoutId,
          treePath,
        });
      }
    }

    addRouteManifestSegmentErrorBoundaryFacts({ boundaries, route });

    for (const [index, templateId] of route.ids.templates.entries()) {
      const treePosition = route.templateTreePositions?.[index];
      assertRouteManifestTreePosition("template", route, templateId, treePosition);
      const treePath = createAppRouteGraphTreePath(route.routeSegments, treePosition);

      const existingTemplate = templates.get(templateId);
      if (existingTemplate) {
        assertRouteManifestRootBoundary(
          "template",
          route,
          templateId,
          existingTemplate.rootBoundaryId,
        );
      }
      templates.set(templateId, {
        id: templateId,
        treePath,
        rootBoundaryId: route.ids.rootBoundary,
        ownerLayoutId: findRouteManifestOwnerLayoutId(route, treePosition),
        reset: {
          kind: "remountSubtree",
          treePath,
        },
      });
    }

    for (const slot of route.parallelSlots) {
      const ownerLayoutId = findSlotOwnerLayoutId(route, slot);
      const defaultId = slot.defaultPath ? createAppRouteGraphDefaultId(slot.id) : null;
      if (slot.layoutPath) {
        // Materialize the slot-local layout as its own entry so consumers
        // (e.g. typegen) can distinguish it from the owning layout. Note
        // that this layout may have zero entries in `slots`: the slot
        // itself is registered below against `ownerLayoutId`, which points
        // to the ancestor layout that owns the slot prop.
        const slotLayoutTreePath = createSlotLayoutTreePath(slot);
        const slotLayoutId = createAppRouteGraphLayoutId(slotLayoutTreePath);
        const existingLayout = layouts.get(slotLayoutId);
        if (existingLayout) {
          assertRouteManifestRootBoundary(
            "layout",
            route,
            slotLayoutId,
            existingLayout.rootBoundaryId,
          );
        }
        const slotLayoutRouteParts = convertTreePathToRouteParts(slotLayoutTreePath);
        layouts.set(slotLayoutId, {
          id: slotLayoutId,
          treePath: slotLayoutTreePath,
          patternParts: slotLayoutRouteParts.urlSegments,
          paramNames: slotLayoutRouteParts.params,
          rootBoundaryId: route.ids.rootBoundary,
        });
      }
      slots.set(slot.id, {
        id: slot.id,
        key: slot.key,
        name: slot.name,
        ownerTreePath: slot.ownerTreePath,
        ownerLayoutId,
        rootBoundaryId: ownerLayoutId ? route.ids.rootBoundary : null,
        defaultId,
        hasDefault: slot.defaultPath !== null,
        hasPage: slot.hasPage,
      });
      if (defaultId) {
        defaults.set(defaultId, {
          id: defaultId,
          slotId: slot.id,
          ownerTreePath: slot.ownerTreePath,
          ownerLayoutId,
          rootBoundaryId: ownerLayoutId ? route.ids.rootBoundary : null,
        });
      }
      const binding = createRouteManifestSlotBinding(route, slot, ownerLayoutId, defaultId);
      slotBindings.set(binding.id, binding);
      addRouteManifestInterceptionFacts({
        interceptions,
        ownerLayoutId,
        route,
        routeIdByPattern,
        slot,
      });
    }
  }

  const interceptionsBySlotId = createRouteManifestInterceptionsBySlotId(interceptions);

  return {
    routes: routeEntries,
    pages,
    routeHandlers,
    layouts,
    templates,
    slots,
    defaults,
    slotBindings,
    interceptions,
    interceptionsBySlotId,
    boundaries,
    rootBoundaries,
  };
}

function createRouteManifestRouteIdByPattern(
  routes: readonly AppRouteGraphRoute[],
): ReadonlyMap<string, string> {
  return new Map(routes.map((route) => [route.pattern, route.ids.route]));
}

function findRouteManifestOwnerLayoutId(
  route: AppRouteGraphRoute,
  treePosition: number,
): string | null {
  const layoutIndex = route.layoutTreePositions.indexOf(treePosition);
  return route.ids.layouts[layoutIndex] ?? null;
}

function findSlotOwnerLayoutId(
  route: AppRouteGraphRoute,
  slot: AppRouteGraphParallelSlot,
): string | null {
  if (slot.layoutIndex < 0) return null;
  return route.ids.layouts[slot.layoutIndex] ?? null;
}

function createSlotLayoutTreePath(slot: AppRouteGraphParallelSlot): string {
  const slotSegment = `@${slot.name}`;
  if (slot.ownerTreePath === "/") return `/${slotSegment}`;
  return `${slot.ownerTreePath}/${slotSegment}`;
}

function createRouteManifestSlotBinding(
  route: AppRouteGraphRoute,
  slot: AppRouteGraphParallelSlot,
  ownerLayoutId: string | null,
  defaultId: string | null,
): RouteManifestSlotBinding {
  const state = getRouteManifestSlotBindingState(slot);
  const binding: RouteManifestSlotBinding = {
    id: `${route.ids.route}::${slot.id}`,
    routeId: route.ids.route,
    slotId: slot.id,
    ownerLayoutId,
    state,
    defaultId: state === "default" ? defaultId : null,
    routeSegments: slot.routeSegments ? [...slot.routeSegments] : null,
  };

  if (slot.slotPatternParts) {
    binding.slotPatternParts = [...slot.slotPatternParts];
  }
  if (slot.slotParamNames) {
    binding.slotParamNames = [...slot.slotParamNames];
  }

  return binding;
}

function addRouteManifestInterceptionFacts(input: {
  interceptions: Map<string, RouteManifestInterception>;
  ownerLayoutId: string | null;
  route: AppRouteGraphRoute;
  routeIdByPattern: ReadonlyMap<string, string>;
  slot: AppRouteGraphParallelSlot;
}): void {
  for (const interception of input.slot.interceptingRoutes) {
    const id = createAppRouteGraphInterceptionId(
      input.slot.id,
      interception.sourceMatchPattern,
      interception.targetPattern,
    );
    input.interceptions.set(id, {
      id,
      sourcePattern: interception.sourceMatchPattern,
      sourcePatternParts: splitRouteManifestPatternParts(interception.sourceMatchPattern),
      targetPattern: interception.targetPattern,
      targetPatternParts: splitRouteManifestPatternParts(interception.targetPattern),
      slotId: input.slot.id,
      ownerLayoutId: input.ownerLayoutId,
      interceptingRouteId: input.routeIdByPattern.get(interception.sourceMatchPattern) ?? null,
      targetRouteId: input.routeIdByPattern.get(interception.targetPattern) ?? null,
    });
  }
}

function createRouteManifestInterceptionsBySlotId(
  interceptions: ReadonlyMap<string, RouteManifestInterception>,
): ReadonlyMap<string, readonly RouteManifestInterception[]> {
  const interceptionsBySlotId = new Map<string, RouteManifestInterception[]>();
  for (const interception of interceptions.values()) {
    const existing = interceptionsBySlotId.get(interception.slotId);
    if (existing) {
      existing.push(interception);
    } else {
      interceptionsBySlotId.set(interception.slotId, [interception]);
    }
  }

  for (const slotInterceptions of interceptionsBySlotId.values()) {
    slotInterceptions.sort((left, right) => compareStableStrings(left.id, right.id));
  }

  return new Map(
    Array.from(interceptionsBySlotId.entries()).sort(([left], [right]) =>
      compareStableStrings(left, right),
    ),
  );
}

function splitRouteManifestPatternParts(pattern: string): string[] {
  return pattern.split("/").filter((part) => part.length > 0);
}

function getRouteManifestSlotBindingState(
  slot: AppRouteGraphParallelSlot,
): RouteManifestSlotBindingState {
  if (slot.pagePath) return "active";
  if (slot.defaultPath) return "default";
  return "unmatched";
}

function addRouteManifestBoundaryFacts(input: {
  boundaries: Map<string, RouteManifestBoundary>;
  route: AppRouteGraphRoute;
  layoutId: string;
  treePath: string;
  layoutIndex: number;
}): void {
  addRouteManifestBoundaryFact(input, "error", input.route.layoutErrorPaths[input.layoutIndex]);
  addRouteManifestBoundaryFact(input, "notFound", input.route.notFoundPaths[input.layoutIndex]);
  addRouteManifestBoundaryFact(input, "forbidden", input.route.forbiddenPaths[input.layoutIndex]);
  addRouteManifestBoundaryFact(
    input,
    "unauthorized",
    input.route.unauthorizedPaths[input.layoutIndex],
  );
}

function addRouteManifestSegmentErrorBoundaryFacts(input: {
  boundaries: Map<string, RouteManifestBoundary>;
  route: AppRouteGraphRoute;
}): void {
  for (const [index, boundaryPath] of (input.route.errorPaths ?? []).entries()) {
    const treePosition = input.route.errorTreePositions?.[index];
    assertRouteManifestBoundaryTreePosition(input.route, boundaryPath, treePosition);
    const ownerLayoutId = findRouteManifestOwnerLayoutId(input.route, treePosition);
    if (ownerLayoutId !== null) continue;

    const treePath = createAppRouteGraphTreePath(input.route.routeSegments, treePosition);
    addRouteManifestBoundaryFact(
      {
        boundaries: input.boundaries,
        route: input.route,
        layoutId: ownerLayoutId,
        treePath,
      },
      "error",
      boundaryPath,
    );
  }
}

function addRouteManifestBoundaryFact(
  input: {
    boundaries: Map<string, RouteManifestBoundary>;
    route: AppRouteGraphRoute;
    layoutId: string | null;
    treePath: string;
  },
  outcome: RouteManifestBoundaryOutcome,
  boundaryPath: string | null | undefined,
): void {
  if (!boundaryPath) return;

  const id = `boundary:${outcome}:${input.treePath}`;
  input.boundaries.set(id, {
    id,
    outcome,
    treePath: input.treePath,
    ownerLayoutId: input.layoutId,
    rootBoundaryId: input.route.ids.rootBoundary,
  });
}

function assertRouteManifestTreePosition(
  kind: "layout" | "template",
  route: AppRouteGraphRoute,
  id: string,
  treePosition: number | undefined,
): asserts treePosition is number {
  if (treePosition !== undefined) return;

  throw new Error(
    `[vinext] App route graph invariant violated: missing ${kind} tree position for ${id} on ${route.pattern}`,
  );
}

function assertRouteManifestBoundaryTreePosition(
  route: AppRouteGraphRoute,
  boundaryPath: string,
  treePosition: number | undefined,
): asserts treePosition is number {
  if (treePosition !== undefined) return;

  throw new Error(
    `[vinext] App route graph invariant violated: missing boundary tree position for ${boundaryPath} on ${route.pattern}`,
  );
}

function assertRouteManifestRootBoundary(
  kind: "layout" | "template",
  route: AppRouteGraphRoute,
  id: string,
  existingRootBoundaryId: RootBoundaryId | null,
): void {
  if (existingRootBoundaryId === route.ids.rootBoundary) return;

  throw new Error(
    `[vinext] App route graph invariant violated: ${kind} ${id} is shared across root boundaries (${existingRootBoundaryId ?? "none"} and ${route.ids.rootBoundary ?? "none"}) on ${route.pattern}`,
  );
}

function createRouteManifestGraphVersion(segmentGraph: StaticSegmentGraph): GraphVersion {
  // The manifest hash is canonical only if top-level map keys are sorted and
  // inner route arrays keep their own semantic order: layoutIds/templateIds in
  // tree-position order, and slotIds in compareStableStrings order.
  const stableShape = {
    routes: sortedMapValues(segmentGraph.routes),
    pages: sortedMapValues(segmentGraph.pages),
    routeHandlers: sortedMapValues(segmentGraph.routeHandlers),
    layouts: sortedMapValues(segmentGraph.layouts),
    templates: sortedMapValues(segmentGraph.templates),
    slots: sortedMapValues(segmentGraph.slots),
    defaults: sortedMapValues(segmentGraph.defaults),
    slotBindings: sortedMapValues(segmentGraph.slotBindings),
    interceptions: sortedMapValues(segmentGraph.interceptions),
    interceptionsBySlotId: sortedMapValues(segmentGraph.interceptionsBySlotId),
    boundaries: sortedMapValues(segmentGraph.boundaries),
    rootBoundaries: sortedMapValues(segmentGraph.rootBoundaries),
  };
  return `graph:${createHash("sha256").update(JSON.stringify(stableShape)).digest("hex")}`;
}

export async function buildAppRouteGraph(
  appDir: string,
  matcher: ValidFileMatcher,
): Promise<{ routes: AppRouteGraphRoute[]; routeManifest: RouteManifest }> {
  // Find all page.tsx and route.ts files, excluding @slot directories
  // (slot pages are not standalone routes — they're rendered as props of their parent layout)
  // and _private folders (Next.js convention for colocated non-route files).
  //
  // The `@children` directory is special: Next.js treats `@children` as
  // transparent — `app/@children/page.tsx` provides the layout's children
  // prop for `/` and registers a real page route at `/`. This mirrors the
  // Next.js types plugin (which skips `@children` when enumerating slots)
  // and `normalizeAppPath` (which strips any `@` segment including
  // `@children` from the URL). See:
  //   - packages/next/src/build/webpack/plugins/next-types-plugin/index.ts
  //   - packages/next/src/shared/lib/router/utils/app-paths.ts
  //   - packages/next/src/build/normalize-catchall-routes.ts
  //
  // Interception marker directories (e.g. `(.)photo`, `(..)showcase`,
  // `(..)(..)hoge`, `(...)photos`) are also excluded from the global page
  // scan because the marker is not a real URL segment — Next.js treats these
  // as a separate route family resolved via interception rewrites. Without
  // this exclusion the scanner would register patterns like
  // `/templates/(..)showcase` as standalone routes, breaking the build (and
  // any URL containing the marker).
  //
  // See https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/interception-routes.ts
  const routes: AppRouteGraphRoute[] = [];

  const excludeDir = (name: string) =>
    (name.startsWith("@") && name !== "@children") ||
    name.startsWith("_") ||
    isInterceptionMarkerDir(name);

  // Process page files in a single pass
  // Use function form of exclude for Node < 22.14 compatibility (string arrays require >= 22.14)
  for await (const file of scanWithExtensions("**/page", appDir, matcher.extensions, excludeDir)) {
    const route = fileToAppRoute(file, appDir, "page", matcher);
    if (route) routes.push(route);
  }

  // Process route handler files (API routes) in a single pass
  for await (const file of scanWithExtensions("**/route", appDir, matcher.extensions, excludeDir)) {
    const route = fileToAppRoute(file, appDir, "route", matcher);
    if (route) routes.push(route);
  }

  // Layouts with parallel slot pages are valid route entries even when the
  // segment has no children page. Next.js uses this for modal/feed patterns
  // like app/user/[id]/layout + @feed/page + @modal/default.
  const routePatterns = new Set(routes.map((route) => route.pattern));
  // Ghost parents are layout-only routes whose URL pattern collides with an
  // existing route (e.g. sibling route groups like (group-a)/layout.tsx and
  // (group-b)/page.tsx both anchored at "/"). Their slot directories still
  // contribute synthetic sub-routes (e.g. @parallel/[...catcher]/page.tsx →
  // /:catcher+), but the ghost itself is not added to the routes table.
  const ghostParentRoutes: AppRouteGraphRoute[] = [];
  for await (const file of scanWithExtensions(
    "**/layout",
    appDir,
    matcher.extensions,
    excludeDir,
  )) {
    const dir = path.dirname(file);
    const routeDir = dir === "." ? appDir : path.join(appDir, dir);
    if (!hasParallelSlotDirectory(routeDir)) continue;
    if (discoverParallelSlots(routeDir, appDir, matcher).length === 0) continue;

    const route = directoryToAppRoute(dir, appDir, matcher, null, null);
    if (!route) continue;
    if (routePatterns.has(route.pattern)) {
      ghostParentRoutes.push(route);
      continue;
    }

    routes.push(route);
    routePatterns.add(route.pattern);
  }

  // Discover sub-routes created by nested pages within parallel slots.
  // In Next.js, pages nested inside @slot directories create additional URL routes.
  // For example, @audience/demographics/page.tsx at app/parallel-routes/ creates
  // a route at /parallel-routes/demographics.
  const slotSubRoutes = discoverSlotSubRoutes(routes, matcher, ghostParentRoutes);
  routes.push(...slotSubRoutes);

  validatePageRouteConflicts(routes, appDir);
  validateRoutePatterns(routes.map((route) => route.pattern));
  const interceptTargetPatterns = [
    ...new Set(
      routes.flatMap((route) =>
        route.parallelSlots.flatMap((slot) =>
          slot.interceptingRoutes.map((intercept) => intercept.targetPattern),
        ),
      ),
    ),
  ];
  validateRoutePatterns(interceptTargetPatterns);

  // Sort: static routes first, then dynamic, then catch-all
  routes.sort(compareRoutes);

  return { routes, routeManifest: createRouteManifest(routes) };
}

function hasParallelSlotDirectory(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("@") &&
        // `@children` is not a parallel slot — see discoverParallelSlots.
        entry.name !== "@children",
    );
  } catch {
    return false;
  }
}

function validatePageRouteConflicts(routes: readonly AppRoute[], appDir: string): void {
  const byPattern = new Map<string, { pagePath: string | null; routePath: string | null }>();

  // validateRoutePatterns() would also reject page/route pairs because they
  // share a URL pattern. Keep this pass first so the error names both files.
  for (const route of routes) {
    const entry = byPattern.get(route.pattern);
    if (!entry) {
      byPattern.set(route.pattern, {
        pagePath: route.pagePath,
        routePath: route.routePath,
      });
      continue;
    }

    if (!entry.pagePath && route.pagePath) {
      entry.pagePath = route.pagePath;
    }
    if (!entry.routePath && route.routePath) {
      entry.routePath = route.routePath;
    }
  }

  for (const [pattern, entry] of byPattern) {
    if (!entry.pagePath || !entry.routePath) continue;

    throw new Error(
      `Conflicting route and page at ${pattern}: route at ${formatAppFilePath(
        entry.routePath,
        appDir,
      )} and page at ${formatAppFilePath(entry.pagePath, appDir)}`,
    );
  }
}

function formatAppFilePath(filePath: string, appDir: string): string {
  const relativePath = path.relative(appDir, filePath).replace(/\\/g, "/");
  const parsedPath = path.parse(relativePath);
  const withoutExtension = path.join(parsedPath.dir, parsedPath.name).replace(/\\/g, "/");
  return withoutExtension.startsWith("/") ? withoutExtension : `/${withoutExtension}`;
}

/**
 * Discover sub-routes created by nested pages within parallel slots.
 *
 * In Next.js, pages nested inside @slot directories create additional URL routes.
 * For example, given:
 *   app/parallel-routes/@audience/demographics/page.tsx
 * This creates a route at /parallel-routes/demographics where:
 * - children slot → parent's default.tsx
 * - @audience slot → @audience/demographics/page.tsx (matched)
 * - other slots → their default.tsx (fallback)
 */
function discoverSlotSubRoutes(
  routes: AppRouteGraphRoute[],
  matcher: ValidFileMatcher,
  ghostParents: readonly AppRouteGraphRoute[] = [],
): AppRouteGraphRoute[] {
  const syntheticRoutes: AppRouteGraphRoute[] = [];

  // O(1) lookup for existing routes by pattern — avoids O(n) routes.find() per sub-path per parent.
  // Updated as new synthetic routes are pushed so that later parents can see earlier synthetic entries.
  const routesByPattern = new Map<string, AppRoute>(routes.map((r) => [r.pattern, r]));

  const applySlotSubPages = (
    route: AppRoute,
    slotPages: Map<string, string>,
    rawSegments: string[],
  ): void => {
    route.parallelSlots = route.parallelSlots.map((slot) => {
      const subPage = slotPages.get(slot.key);
      if (subPage !== undefined) {
        return { ...slot, pagePath: subPage, routeSegments: rawSegments };
      }
      return slot;
    });
  };

  // Iterate real routes first so that later ghost-parent passes can detect
  // synthetic conflicts against routes the real pass minted.
  const allParents: AppRouteGraphRoute[] = [...routes, ...ghostParents];
  for (const parentRoute of allParents) {
    if (parentRoute.parallelSlots.length === 0) continue;

    // Only page-bearing routes or layout-only UI routes (not route handlers)
    // can own nested parallel-slot sub-routes.
    const isLayoutOnlyUiRoute =
      !parentRoute.pagePath && !parentRoute.routePath && parentRoute.layouts.length > 0;
    if (!parentRoute.pagePath && !isLayoutOnlyUiRoute) continue;

    // For page-bearing routes, the route directory is the page's directory.
    // For layout-only routes (no page.tsx), proxy the route directory through
    // the innermost layout — it lives at the same filesystem level as the route.
    const parentPageDir = parentRoute.pagePath
      ? path.dirname(parentRoute.pagePath)
      : path.dirname(parentRoute.layouts[parentRoute.layouts.length - 1]);

    // Collect sub-paths from all slots.
    // Map: normalized visible sub-path -> slot pages, raw filesystem segments (for routeSegments),
    // and the pre-computed convertedSubRoute (to avoid a redundant re-conversion in the merge loop).
    const subPathMap = new Map<
      string,
      {
        // Raw filesystem segments (with route groups, @slots, etc.) used for routeSegments so
        // that useSelectedLayoutSegments() sees the correct segment list at runtime.
        rawSegments: string[];
        // Pre-computed URL parts, params, isDynamic from convertSegmentsToRouteParts.
        converted: { urlSegments: string[]; params: string[]; isDynamic: boolean };
        slotPages: Map<string, string>;
      }
    >();

    for (const slot of parentRoute.parallelSlots) {
      // Only scan sub-pages from slots owned by this route directory.
      // Inherited slots with the same name live in different owner dirs.
      if (path.dirname(slot.ownerDir) !== parentPageDir) {
        continue;
      }
      const slotDir = slot.ownerDir;
      if (!fs.existsSync(slotDir)) continue;

      const subPages = findSlotSubPages(slotDir, matcher);
      for (const { relativePath, pagePath } of subPages) {
        const subSegments = relativePath.split(path.sep);
        const convertedSubRoute = convertSegmentsToRouteParts(subSegments);
        if (!convertedSubRoute) continue;

        const { urlSegments } = convertedSubRoute;
        const normalizedSubPath = urlSegments.join("/");
        let subPathEntry = subPathMap.get(normalizedSubPath);

        if (!subPathEntry) {
          subPathEntry = {
            rawSegments: subSegments,
            converted: convertedSubRoute,
            slotPages: new Map(),
          };
          subPathMap.set(normalizedSubPath, subPathEntry);
        }

        const existingSlotPage = subPathEntry.slotPages.get(slot.key);
        if (existingSlotPage) {
          const pattern = joinRoutePattern(parentRoute.pattern, normalizedSubPath);
          throw new Error(
            `You cannot have two routes that resolve to the same path ("${pattern}").`,
          );
        }

        subPathEntry.slotPages.set(slot.key, pagePath);
      }
    }

    if (subPathMap.size === 0) continue;

    // Find the default.tsx for the children slot at the parent directory.
    // When the parent route has a children page, a default.tsx is required so
    // the synthetic sub-route has a fallback for the children slot. Layout-only
    // parent routes (no page.tsx) do not need a default — the children slot was
    // never occupied at the parent level, so the sub-route simply renders null.
    const childrenDefault = findFile(parentPageDir, "default", matcher);
    if (parentRoute.pagePath && !childrenDefault) continue;

    for (const { rawSegments, converted: convertedSubRoute, slotPages } of subPathMap.values()) {
      const {
        urlSegments: urlParts,
        params: subParams,
        isDynamic: subIsDynamic,
      } = convertedSubRoute;

      const subUrlPath = urlParts.join("/");
      const pattern = joinRoutePattern(parentRoute.pattern, subUrlPath);

      const existingRoute = routesByPattern.get(pattern);
      if (existingRoute) {
        if (existingRoute.routePath && !existingRoute.pagePath) {
          throw new Error(
            `You cannot have two routes that resolve to the same path ("${pattern}").`,
          );
        }
        applySlotSubPages(existingRoute, slotPages, rawSegments);
        continue;
      }

      // Skip synthetic routes that would structurally conflict with an existing
      // route (same shape, different param names). The slot content is handled
      // by findMirroredSlotPage for the existing route instead.
      // Scan routesByPattern (not just the original routes array) so synthetic
      // routes created earlier in this loop are also visible.
      const syntheticParts = [...parentRoute.patternParts, ...urlParts];
      const hasStructuralConflict = Array.from(routesByPattern.values()).some((r) =>
        patternsStructurallyEquivalent(r.patternParts, syntheticParts),
      );
      if (hasStructuralConflict) continue;

      // Build parallel slots for this sub-route: matching slots get the sub-page,
      // non-matching slots get null pagePath (rendering falls back to defaultPath)
      const subSlots: AppRouteGraphParallelSlot[] = parentRoute.parallelSlots.map((slot) => {
        const subPage = slotPages.get(slot.key);
        return {
          ...slot,
          pagePath: subPage || null,
          routeSegments: subPage ? rawSegments : null,
        };
      });

      const newRoute: AppRouteGraphRoute = {
        ids: createAppRouteSemanticIds({
          pattern,
          pagePath: childrenDefault,
          routePath: null,
          routeSegments: [...parentRoute.routeSegments, ...rawSegments],
          layoutTreePositions: parentRoute.layoutTreePositions,
          templateTreePositions: parentRoute.templateTreePositions,
          slots: subSlots,
        }),
        pattern,
        pagePath: childrenDefault, // children slot uses parent's default.tsx as page
        routePath: null,
        layouts: parentRoute.layouts,
        templates: parentRoute.templates,
        parallelSlots: subSlots,
        loadingPath: parentRoute.loadingPath,
        errorPath: parentRoute.errorPath,
        layoutErrorPaths: parentRoute.layoutErrorPaths,
        notFoundPath: parentRoute.notFoundPath,
        notFoundPaths: parentRoute.notFoundPaths,
        forbiddenPaths: parentRoute.forbiddenPaths,
        forbiddenPath: parentRoute.forbiddenPath,
        unauthorizedPath: parentRoute.unauthorizedPath,
        unauthorizedPaths: parentRoute.unauthorizedPaths,
        routeSegments: [...parentRoute.routeSegments, ...rawSegments],
        templateTreePositions: parentRoute.templateTreePositions,
        layoutTreePositions: parentRoute.layoutTreePositions,
        isDynamic: parentRoute.isDynamic || subIsDynamic,
        params: [...parentRoute.params, ...subParams],
        rootParamNames: parentRoute.rootParamNames,
        patternParts: [...parentRoute.patternParts, ...urlParts],
      };
      syntheticRoutes.push(newRoute);
      routesByPattern.set(pattern, newRoute);
    }
  }

  return syntheticRoutes;
}

/**
 * Find all page files in subdirectories of a parallel slot directory.
 * Returns relative paths (from the slot dir) and absolute page paths.
 * Skips the root page.tsx (already handled as the slot's main page)
 * and intercepting route directories.
 */
type SlotSubPageEntry = { relativePath: string; pagePath: string };

// Per-build memo: a slot directory's sub-pages depend only on the directory
// contents and the matcher's accepted extensions. Inherited slots get scanned
// once per descendant route, so without memoization a route N segments deep
// pays O(N) full subtree walks for every shared ancestor slot.
//
// Keyed by matcher (one matcher per build) so the cache is naturally scoped
// to a single build run and gets collected when the build finishes — no
// cross-build pollution in long-lived dev servers.
const findSlotSubPagesCache = new WeakMap<ValidFileMatcher, Map<string, SlotSubPageEntry[]>>();

function findSlotSubPages(slotDir: string, matcher: ValidFileMatcher): SlotSubPageEntry[] {
  let perMatcher = findSlotSubPagesCache.get(matcher);
  if (!perMatcher) {
    perMatcher = new Map();
    findSlotSubPagesCache.set(matcher, perMatcher);
  }
  const cached = perMatcher.get(slotDir);
  if (cached) return cached;

  const results: SlotSubPageEntry[] = [];

  function scan(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip intercepting route directories
      if (matchInterceptConvention(entry.name)) continue;
      // Skip private folders (prefixed with _)
      if (entry.name.startsWith("_")) continue;

      const subDir = path.join(dir, entry.name);
      const page = findFile(subDir, "page", matcher);
      if (page) {
        const relativePath = path.relative(slotDir, subDir);
        results.push({ relativePath, pagePath: page });
      }
      // Continue scanning deeper for nested sub-pages
      scan(subDir);
    }
  }

  scan(slotDir);
  perMatcher.set(slotDir, results);
  return results;
}

/**
 * Convert a file path relative to app/ into an AppRoute.
 */
function fileToAppRoute(
  file: string,
  appDir: string,
  type: "page" | "route",
  matcher: ValidFileMatcher,
): AppRouteGraphRoute | null {
  // Remove the filename (page.tsx or route.ts)
  let dir = path.dirname(file);

  // `@children` is transparent in routing: `app/foo/@children/page.tsx`
  // provides the children prop for `/foo` and registers a real page route
  // at `/foo`. Strip a trailing `@children` segment so the route is
  // anchored at its parent directory — that way slot discovery treats
  // sibling `@slot` directories as owned (not inherited) and the route's
  // layouts/boundaries are sourced from the parent. Mirrors Next.js'
  // `normalizeAppPath` which drops any `@` segment (including `@children`)
  // from the URL. See packages/next/src/shared/lib/router/utils/app-paths.ts.
  if (type === "page" && dir !== "." && path.basename(dir) === "@children") {
    const parent = path.dirname(dir);
    dir = parent === "" || parent === "." ? "." : parent;
  }

  return directoryToAppRoute(
    dir,
    appDir,
    matcher,
    type === "page" ? path.join(appDir, file) : null,
    type === "route" ? path.join(appDir, file) : null,
  );
}

function directoryToAppRoute(
  dir: string,
  appDir: string,
  matcher: ValidFileMatcher,
  pagePath: string | null,
  routePath: string | null,
): AppRouteGraphRoute | null {
  const segments = dir === "." ? [] : dir.split(path.sep);

  const params: string[] = [];
  let isDynamic = false;

  const convertedRoute = convertSegmentsToRouteParts(segments);
  if (!convertedRoute) return null;

  const { urlSegments, params: routeParams, isDynamic: routeIsDynamic } = convertedRoute;
  params.push(...routeParams);
  isDynamic = routeIsDynamic;

  const pattern = "/" + urlSegments.join("/");

  // Discover layouts and templates from root to leaf
  const layouts = discoverLayouts(segments, appDir, matcher);
  const templates = discoverTemplates(segments, appDir, matcher);
  const templateTreePositions = computeLayoutTreePositions(appDir, templates);

  // Compute the tree position (directory depth) for each layout.
  const layoutTreePositions = computeLayoutTreePositions(appDir, layouts);

  // Discover per-segment error boundaries. Next.js loader trees carry an
  // error convention for a segment even when that segment has no layout.
  // In Next.js, each segment independently wraps its children with an ErrorBoundary.
  // This array enables interleaving error boundaries with layouts in the rendering.
  const layoutErrorPaths = discoverLayoutAlignedErrors(segments, appDir, matcher);
  const errorEntries = discoverSegmentErrors(segments, appDir, matcher);
  const errorPaths = errorEntries.map((entry) => entry.path);
  const errorTreePositions = errorEntries.map((entry) => entry.treePosition);

  // Discover loading, error in the route's directory
  const routeDir = dir === "." ? appDir : path.join(appDir, dir);
  const loadingPath = findFile(routeDir, "loading", matcher);
  const errorPath = findFile(routeDir, "error", matcher);

  // Discover not-found/forbidden/unauthorized: walk from route directory up to root (nearest wins).
  const notFoundPath = discoverBoundaryFile(segments, appDir, "not-found", matcher);
  const forbiddenPath = discoverBoundaryFile(segments, appDir, "forbidden", matcher);
  const unauthorizedPath = discoverBoundaryFile(segments, appDir, "unauthorized", matcher);

  // Discover per-layout not-found files (one per layout directory).
  // These are used for per-layout NotFoundBoundary to match Next.js behavior where
  // notFound() thrown from a layout is caught by the parent layout's boundary.
  const notFoundPaths = discoverBoundaryFilePerLayout(layouts, "not-found", matcher);
  const forbiddenPaths = discoverBoundaryFilePerLayout(layouts, "forbidden", matcher);
  const unauthorizedPaths = discoverBoundaryFilePerLayout(layouts, "unauthorized", matcher);

  // Discover parallel slots (@team, @analytics, etc.).
  // Slots at the route's own directory use page.tsx; slots at ancestor directories
  // (inherited from parent layouts) use default.tsx as fallback.
  const parallelSlots = discoverInheritedParallelSlots(segments, appDir, routeDir, matcher);

  return {
    ids: createAppRouteSemanticIds({
      pattern: pattern === "/" ? "/" : pattern,
      pagePath,
      routePath,
      routeSegments: segments,
      layoutTreePositions,
      templateTreePositions,
      slots: parallelSlots,
    }),
    pattern: pattern === "/" ? "/" : pattern,
    pagePath,
    routePath,
    layouts,
    templates,
    parallelSlots,
    loadingPath,
    errorPath,
    layoutErrorPaths,
    errorPaths,
    errorTreePositions,
    notFoundPath,
    notFoundPaths,
    forbiddenPaths,
    forbiddenPath,
    unauthorizedPath,
    unauthorizedPaths,
    routeSegments: segments,
    templateTreePositions,
    layoutTreePositions,
    isDynamic,
    params,
    rootParamNames: computeRootParamNames(segments, layoutTreePositions),
    patternParts: urlSegments,
  };
}

function dynamicParamNameFromSegment(segment: string): string | null {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) return segment.slice(5, -2);
  if (segment.startsWith("[...") && segment.endsWith("]")) return segment.slice(4, -1);
  if (segment.startsWith("[") && segment.endsWith("]")) return segment.slice(1, -1);
  return null;
}

export function computeRootParamNames(
  routeSegments: readonly string[],
  layoutTreePositions: readonly number[],
): string[] {
  const rootLayoutPosition = layoutTreePositions[0];
  if (rootLayoutPosition == null || rootLayoutPosition <= 0) return [];

  const names: string[] = [];
  for (const segment of routeSegments.slice(0, rootLayoutPosition)) {
    const name = dynamicParamNameFromSegment(segment);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function resolveRootBoundaryId(
  routeSegments: readonly string[],
  layoutTreePositions: readonly number[],
): RootBoundaryId | null {
  const rootLayoutPosition = layoutTreePositions[0];
  if (rootLayoutPosition === undefined) return null;

  // Position 0 is the app root layout and still owns a real root boundary.
  // Only a missing layout position means the route is layoutless.
  return createAppRouteGraphRootBoundaryId(
    createAppRouteGraphTreePath(routeSegments, rootLayoutPosition),
  );
}

function createAppRouteSemanticIds(input: {
  pattern: string;
  pagePath: string | null;
  routePath: string | null;
  routeSegments: readonly string[];
  layoutTreePositions: readonly number[];
  templateTreePositions?: readonly number[];
  slots: readonly AppRouteGraphParallelSlot[];
}): AppRouteSemanticIds {
  const slots: Record<string, string> = {};
  for (const slot of input.slots) {
    slots[slot.key] = slot.id;
  }

  return {
    route: createAppRouteGraphRouteId(input.pattern),
    page: input.pagePath ? createAppRouteGraphPageId(input.pattern) : null,
    routeHandler: input.routePath ? createAppRouteGraphRouteHandlerId(input.pattern) : null,
    rootBoundary: resolveRootBoundaryId(input.routeSegments, input.layoutTreePositions),
    layouts: input.layoutTreePositions.map((treePosition) =>
      createAppRouteGraphLayoutId(createAppRouteGraphTreePath(input.routeSegments, treePosition)),
    ),
    templates: (input.templateTreePositions ?? []).map((treePosition) =>
      createAppRouteGraphTemplateId(createAppRouteGraphTreePath(input.routeSegments, treePosition)),
    ),
    slots,
  };
}

function createAppRouteGraphTreePath(
  routeSegments: readonly string[],
  treePosition: number,
): string {
  const treePathSegments = routeSegments.slice(0, treePosition);
  if (treePathSegments.length === 0) {
    return "/";
  }
  return `/${treePathSegments.join("/")}`;
}

function convertTreePathToRouteParts(treePath: string): {
  urlSegments: string[];
  params: string[];
} {
  if (treePath === "/") return { urlSegments: [], params: [] };
  const segments = treePath.split("/").filter(Boolean);
  const routeParts = convertSegmentsToRouteParts(segments);
  if (!routeParts) {
    throw new Error(`Invalid App Router layout tree path "${treePath}".`);
  }
  return { urlSegments: routeParts.urlSegments, params: routeParts.params };
}

/**
 * Compute the tree position (directory depth from app root) for each layout.
 * Root layout = 0, a layout at app/blog/ = 1, app/blog/(group)/ = 2.
 * Counts ALL directory levels including route groups and parallel slots.
 */
function computeLayoutTreePositions(appDir: string, layouts: string[]): number[] {
  return layouts.map((layoutPath) => {
    const layoutDir = path.dirname(layoutPath);
    if (layoutDir === appDir) return 0;
    const relative = path.relative(appDir, layoutDir);
    return relative.split(path.sep).length;
  });
}

/**
 * Discover all layout files from root to the given directory.
 * Each level of the directory tree may have a layout.tsx.
 */
function discoverLayouts(segments: string[], appDir: string, matcher: ValidFileMatcher): string[] {
  const layouts: string[] = [];

  // Check root layout
  const rootLayout = findFile(appDir, "layout", matcher);
  if (rootLayout) layouts.push(rootLayout);

  // Check each directory level
  let currentDir = appDir;
  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);
    const layout = findFile(currentDir, "layout", matcher);
    if (layout) layouts.push(layout);
  }

  return layouts;
}

/**
 * Discover all template files from root to the given directory.
 * Each level of the directory tree may have a template.tsx.
 * Templates are like layouts but re-mount on navigation.
 */
function discoverTemplates(
  segments: string[],
  appDir: string,
  matcher: ValidFileMatcher,
): string[] {
  const templates: string[] = [];

  // Check root template
  const rootTemplate = findFile(appDir, "template", matcher);
  if (rootTemplate) templates.push(rootTemplate);

  // Check each directory level
  let currentDir = appDir;
  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);
    const template = findFile(currentDir, "template", matcher);
    if (template) templates.push(template);
  }

  return templates;
}

/**
 * Discover error.tsx files by segment tree position.
 *
 * Next.js stores conventions on every loader-tree segment; a route-group
 * directory with error.tsx but no sibling layout.tsx must still wrap its
 * descendants. Keeping positions explicit avoids conflating segment boundaries
 * with layout component ownership.
 */
function discoverSegmentErrors(
  segments: string[],
  appDir: string,
  matcher: ValidFileMatcher,
): { path: string; treePosition: number }[] {
  const errors: { path: string; treePosition: number }[] = [];

  const rootError = findFile(appDir, "error", matcher);
  if (rootError) {
    errors.push({ path: rootError, treePosition: 0 });
  }

  // Check each directory level
  let currentDir = appDir;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    currentDir = path.join(currentDir, segment);
    const error = findFile(currentDir, "error", matcher);
    if (error) {
      errors.push({ path: error, treePosition: index + 1 });
    }
  }

  return errors;
}

/**
 * Discover error.tsx files aligned with the layouts array.
 *
 * Route manifests still model layout-owned boundary facts by layout index.
 * Keep this layout-aligned compatibility shape separate from segment-owned
 * error boundaries so route-group errors without layouts do not get attributed
 * to unrelated layouts.
 */
function discoverLayoutAlignedErrors(
  segments: string[],
  appDir: string,
  matcher: ValidFileMatcher,
): (string | null)[] {
  const errors: (string | null)[] = [];

  const rootLayout = findFile(appDir, "layout", matcher);
  if (rootLayout) {
    errors.push(findFile(appDir, "error", matcher));
  }

  let currentDir = appDir;
  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);
    const layout = findFile(currentDir, "layout", matcher);
    if (layout) {
      errors.push(findFile(currentDir, "error", matcher));
    }
  }

  return errors;
}

/**
 * Discover the nearest boundary file (not-found, forbidden, unauthorized)
 * by walking from the route's directory up to the app root.
 * Returns the first (closest) file found, or null.
 */
function discoverBoundaryFile(
  segments: string[],
  appDir: string,
  fileName: string,
  matcher: ValidFileMatcher,
): string | null {
  // Build all directory paths from leaf to root
  const dirs: string[] = [];
  let dir = appDir;
  dirs.push(dir);
  for (const segment of segments) {
    dir = path.join(dir, segment);
    dirs.push(dir);
  }

  // Walk from leaf (last) to root (first)
  for (let i = dirs.length - 1; i >= 0; i--) {
    const f = findFile(dirs[i], fileName, matcher);
    if (f) return f;
  }
  return null;
}

/**
 * Discover boundary files (not-found, forbidden, unauthorized) at each layout directory.
 * Returns an array aligned with the layouts array, where each entry is the boundary
 * file at that layout's directory, or null if none exists there.
 *
 * This is used for per-layout error boundaries. In Next.js, each layout level
 * has its own boundary that wraps the layout's children. When notFound() is thrown
 * from a layout, it propagates up to the parent layout's boundary.
 */
function discoverBoundaryFilePerLayout(
  layouts: string[],
  fileName: string,
  matcher: ValidFileMatcher,
): (string | null)[] {
  return layouts.map((layoutPath) => {
    const layoutDir = path.dirname(layoutPath);
    return findFile(layoutDir, fileName, matcher);
  });
}

/**
 * Discover parallel slots inherited from ancestor directories.
 *
 * In Next.js, parallel slots belong to the layout that defines them. When a
 * child route is rendered, its parent layout's slots must still be present.
 * If the child doesn't have matching content in a slot, the slot's default.tsx
 * is rendered instead.
 *
 * Walk from appDir through each segment to the route's directory. At each level
 * that has @slot dirs, collect them. Slots at the route's own directory level
 * use page.tsx; slots at ancestor levels use default.tsx only.
 */
function discoverInheritedParallelSlots(
  segments: string[],
  appDir: string,
  routeDir: string,
  matcher: ValidFileMatcher,
): AppRouteGraphParallelSlot[] {
  const slotMap = new Map<string, AppRouteGraphParallelSlot>();

  // Walk from appDir through each segment, tracking layout indices.
  // layoutIndex tracks which position in the route's layouts[] array corresponds
  // to a given directory. Only directories with a layout.tsx file increment.
  // segmentIndex aligns each entry with `segments`: dirsToCheck[i] is reached
  // after consuming segments[0..i-1], so segments.slice(i) are the segments
  // below this directory (used to mirror inherited slot sub-pages).
  let currentDir = appDir;
  const dirsToCheck: { dir: string; layoutIdx: number; segmentIndex: number }[] = [];
  let layoutIdx = findFile(appDir, "layout", matcher) ? 0 : -1;
  dirsToCheck.push({ dir: appDir, layoutIdx, segmentIndex: 0 });

  for (let i = 0; i < segments.length; i++) {
    currentDir = path.join(currentDir, segments[i]);
    if (findFile(currentDir, "layout", matcher)) {
      layoutIdx++;
    }
    dirsToCheck.push({ dir: currentDir, layoutIdx, segmentIndex: i + 1 });
  }

  const routeHasLayout = layoutIdx >= 0;

  for (const { dir, layoutIdx: lvlLayoutIdx, segmentIndex } of dirsToCheck) {
    // Once a route has a root layout below app/, slots discovered before that
    // layout are above the root and cannot be owned by any layout in this route.
    // Layout-less routes keep their legacy slot metadata here; validation is separate.
    if (lvlLayoutIdx < 0 && routeHasLayout) continue;

    const isOwnDir = dir === routeDir;
    const slotLayoutIdx = Math.max(lvlLayoutIdx, 0);
    const slotsAtLevel = discoverParallelSlots(dir, appDir, matcher);
    const segmentsBelow = segments.slice(segmentIndex);

    for (const slot of slotsAtLevel) {
      if (isOwnDir) {
        // At the route's own directory: use page.tsx (normal behavior)
        slot.layoutIndex = slotLayoutIdx;
        slotMap.set(slot.key, slot);
      } else {
        // At an ancestor directory: the slot's own page.tsx belongs to the
        // parent route. Look for a mirrored sub-page at @slot/<segments-below>
        // (e.g. @breadcrumbs/about/page.tsx for /about), falling back to
        // default.tsx when no mirror exists. The mirror search also accepts
        // pattern-compatible matches (e.g. slot's [name] for route's [id]) so
        // the runtime can extract slot-specific params via slotPatternParts.
        const mirror = findMirroredSlotPage(slot.ownerDir, segmentsBelow, matcher);
        let slotPatternParts: string[] | undefined;
        let slotParamNames: string[] | undefined;
        if (mirror) {
          const ownerSegments = segments.slice(0, segmentIndex);
          const ownerUrl = convertSegmentsToRouteParts([...ownerSegments]);
          slotPatternParts = [...(ownerUrl?.urlSegments ?? []), ...mirror.slotUrlSegments];
          slotParamNames = [...(ownerUrl?.params ?? []), ...mirror.slotParamNames];
        }
        const inheritedSlot: AppRouteGraphParallelSlot = {
          ...slot,
          pagePath: mirror?.pagePath ?? null,
          layoutIndex: slotLayoutIdx,
          routeSegments: mirror?.segments ?? null,
          slotPatternParts,
          slotParamNames,
          // defaultPath, loadingPath, errorPath, interceptingRoutes remain
        };
        slotMap.set(slot.key, inheritedSlot);
      }
    }
  }

  return Array.from(slotMap.values());
}

/**
 * Look for a page file inside a parallel slot directory that mirrors the
 * route's path below the slot's owner. The match falls through two tiers:
 *   1. Literal filesystem path — fast path when route and slot share shape.
 *   2. Scored pattern compatibility — enumerate sub-pages, accept those
 *      whose URL pattern can match the route's URL space (slot dynamic
 *      markers may have different names than the route's, and slot
 *      catch-alls may subsume the route), and pick the most-specific via
 *      `scoreSlotPattern`. Exact URL-parts equality (e.g. through route
 *      groups appearing on only one side, like `(marketing)/about` ↔
 *      `@breadcrumbs/about`) naturally wins because all literal segments
 *      score highest.
 *
 * Returns the slot sub-page's absolute path, its raw filesystem segments
 * (for `routeSegments`), and its URL parts / param names (for
 * `slotPatternParts` / `slotParamNames`). Returns null when no mirror matches.
 */
function findMirroredSlotPage(
  slotDir: string,
  segmentsBelow: readonly string[],
  matcher: ValidFileMatcher,
): {
  pagePath: string;
  segments: string[];
  slotUrlSegments: string[];
  slotParamNames: string[];
} | null {
  if (segmentsBelow.length === 0) return null;

  // Convert once: both tiers need the URL form of the route's segments below
  // this directory.
  const routeUrl = convertSegmentsToRouteParts([...segmentsBelow]);

  // Tier 1: literal filesystem match.
  const literalDir = path.join(slotDir, ...segmentsBelow);
  const literalPage = findFile(literalDir, "page", matcher);
  if (literalPage) {
    return {
      pagePath: literalPage,
      segments: [...segmentsBelow],
      slotUrlSegments: routeUrl?.urlSegments ?? [],
      slotParamNames: routeUrl?.params ?? [],
    };
  }

  if (!routeUrl || routeUrl.urlSegments.length === 0) return null;

  // Tier 2: enumerate slot sub-pages and pick the most-specific compatible
  // pattern. Exact URL-parts matches naturally win the score.
  type Candidate = {
    pagePath: string;
    segments: string[];
    slotUrlSegments: string[];
    slotParamNames: string[];
    score: number;
  };
  let best: Candidate | null = null;
  for (const { relativePath, pagePath } of findSlotSubPages(slotDir, matcher)) {
    const slotSegments = relativePath.split(path.sep);
    const slotUrl = convertSegmentsToRouteParts(slotSegments);
    if (!slotUrl) continue;
    if (!patternsCompatible(slotUrl.urlSegments, routeUrl.urlSegments)) continue;
    const score = scoreSlotPattern(slotUrl.urlSegments);
    if (!best || score > best.score) {
      best = {
        pagePath,
        segments: slotSegments,
        slotUrlSegments: slotUrl.urlSegments,
        slotParamNames: slotUrl.params,
        score,
      };
    }
  }

  return best;
}

/**
 * Whether a slot pattern can match the same URL space as the route's URL
 * parts (where the route's parts are themselves a pattern, since a route
 * file like `[id]/page.tsx` produces `:id`).
 *
 * - `:name+` (catch-all) consumes one-or-more remaining segments.
 * - `:name*` (optional catch-all) consumes zero-or-more.
 * - `:name` (single dynamic) consumes exactly one segment, matching any
 *   route segment (literal or dynamic).
 * - Literal slot segments must equal the route's segment exactly; a literal
 *   slot segment paired with a dynamic route segment is rejected because we
 *   can't know statically whether the runtime value will equal the literal.
 *   This also means a literal slot sub-page never matches a catch-all route
 *   (e.g. slot `about/page.tsx` is not bound to a route `[...slug]`) — the
 *   catch-all might or might not resolve to "about" at request time.
 */
function patternsCompatible(slotParts: readonly string[], routeParts: readonly string[]): boolean {
  let i = 0;
  let j = 0;
  while (i < slotParts.length) {
    const sp = slotParts[i];
    if (sp.endsWith("+")) return j < routeParts.length;
    if (sp.endsWith("*")) return true;
    if (j >= routeParts.length) return false;
    const rp = routeParts[j];
    if (sp.startsWith(":")) {
      i++;
      j++;
      continue;
    }
    if (rp.startsWith(":")) return false;
    if (sp !== rp) return false;
    i++;
    j++;
  }
  return j === routeParts.length;
}

/**
 * Score a slot pattern by specificity so the most-specific match wins:
 *   literal > single dynamic > catch-all > optional catch-all.
 *
 * Required catch-all (`:name+`, ≥1 segment) is more constrained than the
 * optional variant (`:name*`, ≥0 segments), so it scores higher.
 */
function scoreSlotPattern(urlSegments: readonly string[]): number {
  let score = 0;
  for (const seg of urlSegments) {
    if (seg.endsWith("*")) score += 1;
    else if (seg.endsWith("+")) score += 2;
    else if (seg.startsWith(":")) score += 3;
    else score += 4;
  }
  return score;
}

/**
 * Map a pattern segment to the tree-node type used by Next.js' route
 * validator. Two segments are structurally equivalent iff they share the
 * same tree-node type.
 */
function segmentTreeNodeType(seg: string): string {
  if (!seg.startsWith(":")) return `literal:${seg}`;
  if (seg.endsWith("*")) return "optionalCatchAll";
  if (seg.endsWith("+")) return "catchAll";
  return "dynamic";
}

function patternsStructurallyEquivalent(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (segmentTreeNodeType(a[i]) !== segmentTreeNodeType(b[i])) return false;
  }
  return true;
}

/**
 * Discover parallel route slots (@team, @analytics, etc.) in a directory.
 * Returns a ParallelSlot for each @-prefixed subdirectory that has a page or default component.
 */
function discoverParallelSlots(
  dir: string,
  appDir: string,
  matcher: ValidFileMatcher,
): AppRouteGraphParallelSlot[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const slots: AppRouteGraphParallelSlot[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;
    // `@children` is not a parallel slot — Next.js maps it to the layout's
    // `children` prop, i.e., it provides the route's page rather than an
    // independent slot. Skip it here so it never appears in parallelSlots.
    // See packages/next/src/build/webpack/plugins/next-types-plugin/index.ts
    // and packages/next/src/build/normalize-catchall-routes.ts.
    if (entry.name === "@children") continue;

    const slotName = entry.name.slice(1); // "@team" -> "team"
    const slotDir = path.join(dir, entry.name);

    const pagePath = findFile(slotDir, "page", matcher);
    const defaultPath = findFile(slotDir, "default", matcher);
    const interceptingRoutes = discoverInterceptingRoutes(slotDir, dir, appDir, matcher);

    // Only include slots that have at least a page, default, or intercepting route
    if (!pagePath && !defaultPath && interceptingRoutes.length === 0) continue;

    const ownerSegments = path
      .relative(appDir, dir)
      .split(path.sep)
      .filter((segment) => segment.length > 0);
    const ownerTreePath = createAppRouteGraphTreePath(ownerSegments, ownerSegments.length);

    slots.push({
      id: createAppRouteGraphSlotId(slotName, ownerTreePath),
      key: `${slotName}@${path.relative(appDir, slotDir).replace(/\\/g, "/")}`,
      name: slotName,
      ownerDir: slotDir,
      ownerTreePath,
      hasPage: pagePath !== null,
      pagePath,
      defaultPath,
      layoutPath: findFile(slotDir, "layout", matcher),
      loadingPath: findFile(slotDir, "loading", matcher),
      errorPath: findFile(slotDir, "error", matcher),
      interceptingRoutes,
      layoutIndex: -1, // Will be set by discoverInheritedParallelSlots
      routeSegments: pagePath ? [] : null,
    });
  }

  return slots;
}

/**
 * The interception convention prefix patterns.
 * (.) — same level, (..) — one level up, (..)(..)" — two levels up, (...) — root
 */
const INTERCEPT_PATTERNS = [
  { prefix: "(...)", convention: "..." },
  { prefix: "(..)(..)", convention: "../.." },
  { prefix: "(..)", convention: ".." },
  { prefix: "(.)", convention: "." },
] as const;

/**
 * Check whether a directory name begins with an interception route marker.
 *
 * Matches the prefixes listed in {@link INTERCEPT_PATTERNS}: `(.)`, `(..)`,
 * `(...)`, `(..)(..)`. The marker is not a real URL segment, so the global
 * page/route scanner must skip these directories to avoid materialising
 * literal patterns like `/templates/(..)showcase`. Interception target
 * registration happens separately via {@link discoverInterceptingRoutes}.
 */
function isInterceptionMarkerDir(name: string): boolean {
  return matchInterceptConvention(name) !== null;
}

/**
 * Discover intercepting routes inside a parallel slot directory.
 *
 * Intercepting routes use conventions like (.)photo, (..)feed, (...), etc.
 * They intercept navigation to another route and render within the slot instead.
 *
 * @param slotDir - The parallel slot directory (e.g. app/feed/@modal)
 * @param routeDir - The directory of the route that owns this slot (e.g. app/feed)
 * @param appDir - The root app directory
 */
function discoverInterceptingRoutes(
  slotDir: string,
  routeDir: string,
  appDir: string,
  matcher: ValidFileMatcher,
): InterceptingRoute[] {
  if (!fs.existsSync(slotDir)) return [];

  const results: InterceptingRoute[] = [];

  // Recursively scan for page files inside intercepting directories
  scanForInterceptingPages(slotDir, routeDir, appDir, results, matcher);

  return results;
}

/**
 * Recursively scan a directory tree for page.tsx files that are inside
 * intercepting route directories.
 */
function scanForInterceptingPages(
  currentDir: string,
  routeDir: string,
  appDir: string,
  results: InterceptingRoute[],
  matcher: ValidFileMatcher,
): void {
  if (!fs.existsSync(currentDir)) return;

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip private folders (prefixed with _)
    if (entry.name.startsWith("_")) continue;

    // Check if this directory name starts with an interception convention
    const interceptMatch = matchInterceptConvention(entry.name);

    if (interceptMatch) {
      // This directory is the start of an intercepting route
      // e.g. "(.)photos" means intercept same-level "photos" route
      const restOfName = entry.name.slice(interceptMatch.prefix.length);
      const interceptDir = path.join(currentDir, entry.name);

      // Find page files within this intercepting directory tree.
      // `currentDir` is the *parent* of the marker dir — used by
      // computeInterceptSourceMatchPattern to derive the intercepting-route
      // URL (the path that owns the slot containing the marker).
      collectInterceptingPages(
        interceptDir,
        interceptDir,
        interceptMatch.convention,
        restOfName,
        routeDir,
        appDir,
        currentDir,
        results,
        matcher,
      );
    } else {
      // Regular subdirectory — keep scanning for intercepting dirs
      scanForInterceptingPages(
        path.join(currentDir, entry.name),
        routeDir,
        appDir,
        results,
        matcher,
      );
    }
  }
}

/**
 * Match a directory name against interception convention prefixes.
 */
function matchInterceptConvention(name: string): { prefix: string; convention: string } | null {
  for (const pattern of INTERCEPT_PATTERNS) {
    if (name.startsWith(pattern.prefix)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Collect page.tsx files inside an intercepting route directory tree
 * and compute their target URL patterns.
 */
function collectInterceptingPages(
  currentDir: string,
  interceptRoot: string,
  convention: string,
  interceptSegment: string,
  routeDir: string,
  appDir: string,
  /**
   * Filesystem directory that owns the slot containing the interception
   * marker — i.e. the parent of the marker dir. Used to derive the
   * intercepting-route URL pattern that gates `findIntercept` at request
   * time. With route groups and `@slot` segments stripped, this becomes
   * Next.js' `interceptingRoute`.
   */
  interceptParentDir: string,
  results: InterceptingRoute[],
  matcher: ValidFileMatcher,
  parentLayoutPaths: readonly string[] = [],
): void {
  const currentLayoutPath = findFile(currentDir, "layout", matcher);
  const layoutPaths = currentLayoutPath
    ? [...parentLayoutPaths, currentLayoutPath]
    : parentLayoutPaths;

  // Check for page.tsx in current directory
  const page = findFile(currentDir, "page", matcher);
  if (page) {
    const targetPattern = computeInterceptTarget(
      convention,
      interceptSegment,
      currentDir,
      interceptRoot,
      routeDir,
      appDir,
    );
    if (targetPattern) {
      const sourceMatchPattern = computeInterceptSourceMatchPattern(interceptParentDir, appDir);
      results.push({
        convention,
        layoutPaths: [...layoutPaths],
        targetPattern: targetPattern.pattern,
        sourceMatchPattern,
        pagePath: page,
        params: targetPattern.params,
      });
    }
  }

  // Recurse into subdirectories for nested intercepting routes
  if (!fs.existsSync(currentDir)) return;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip private folders (prefixed with _)
    if (entry.name.startsWith("_")) continue;
    collectInterceptingPages(
      path.join(currentDir, entry.name),
      interceptRoot,
      convention,
      interceptSegment,
      routeDir,
      appDir,
      interceptParentDir,
      results,
      matcher,
      layoutPaths,
    );
  }
}

/**
 * Compute the URL pattern for the *intercepting route* — the path that
 * owns the slot containing the interception marker. Route groups (`(name)`)
 * and parallel slots (`@slot`) are stripped because Next.js'
 * `normalizeAppPath` treats them as invisible in the URL.
 *
 * Mirrors Next.js' computation in `extractInterceptionRouteInformation`:
 * `interceptingRoute = normalizeAppPath(path.split(marker, 2)[0])`.
 *
 * Returns `/` for the app root.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/interception-routes.ts
 */
function computeInterceptSourceMatchPattern(interceptParentDir: string, appDir: string): string {
  const segments = path.relative(appDir, interceptParentDir).split(path.sep).filter(Boolean);
  const converted = convertSegmentsToRouteParts(segments);
  const urlSegments = converted
    ? converted.urlSegments
    : segments.filter((segment) => !isInvisibleSegment(segment));
  if (urlSegments.length === 0) return "/";
  return "/" + urlSegments.join("/");
}

/**
 * Check whether a path segment is invisible in the URL (route groups, parallel slots, ".").
 *
 * Used by computeInterceptTarget, convertSegmentsToRouteParts, and
 * hasRemainingVisibleSegments — keep this the single source of truth.
 */
export function isInvisibleSegment(segment: string): boolean {
  if (segment === ".") return true;
  if (segment.startsWith("(") && segment.endsWith(")")) return true;
  if (segment.startsWith("@")) return true;
  return false;
}

/**
 * Compute the target URL pattern for an intercepting route.
 *
 * Interception conventions (..), (..)(..)" climb by *visible route segments*
 * (not filesystem directories). Route groups like (marketing) and parallel
 * slots like @modal are invisible and must be skipped when counting levels.
 *
 * - (.) same level: resolve relative to routeDir
 * - (..) one level up: climb 1 visible segment
 * - (..)(..) two levels up: climb 2 visible segments
 * - (...) root: resolve from appDir
 */
function computeInterceptTarget(
  convention: string,
  interceptSegment: string,
  currentDir: string,
  interceptRoot: string,
  routeDir: string,
  appDir: string,
): { pattern: string; params: string[] } | null {
  // Determine the base segments for target resolution.
  // We work on route segments (not filesystem paths) so that route groups
  // and parallel slots are properly skipped when climbing.
  const routeSegments = path.relative(appDir, routeDir).split(path.sep).filter(Boolean);

  let baseParts: string[];
  switch (convention) {
    case ".":
      baseParts = routeSegments;
      break;
    case "..":
    case "../..": {
      const levelsToClimb = convention === ".." ? 1 : 2;
      let climbed = 0;
      let cutIndex = routeSegments.length;
      while (cutIndex > 0 && climbed < levelsToClimb) {
        cutIndex--;
        if (!isInvisibleSegment(routeSegments[cutIndex])) {
          climbed++;
        }
      }
      if (climbed < levelsToClimb) {
        const interceptionRoute = formatInterceptionRoutePath(
          routeSegments,
          convention,
          interceptSegment,
          path.relative(interceptRoot, currentDir).split(path.sep).filter(Boolean),
        );
        if (convention === "..") {
          throw new Error(
            `Invalid interception route: ${interceptionRoute}. Cannot use (..) marker at the root level, use (.) instead.`,
          );
        }
        throw new Error(
          `Invalid interception route: ${interceptionRoute}. Cannot use (..)(..) marker at the root level or one level up.`,
        );
      }
      baseParts = routeSegments.slice(0, cutIndex);
      break;
    }
    case "...":
      baseParts = [];
      break;
    default:
      return null;
  }

  // Add the intercept segment and any nested path segments
  const nestedParts = path.relative(interceptRoot, currentDir).split(path.sep).filter(Boolean);
  const allSegments = [...baseParts, interceptSegment, ...nestedParts];

  const convertedTarget = convertSegmentsToRouteParts(allSegments);
  if (!convertedTarget) return null;

  const { urlSegments, params } = convertedTarget;

  const pattern = "/" + urlSegments.join("/");
  return { pattern: pattern === "/" ? "/" : pattern, params };
}

function formatInterceptionRoutePath(
  routeSegments: string[],
  convention: string,
  interceptSegment: string,
  nestedParts: string[],
): string {
  const marker = markerForInterceptionConvention(convention);
  const convertedRoute = convertSegmentsToRouteParts(routeSegments);
  const prefix = convertedRoute
    ? convertedRoute.urlSegments
    : routeSegments.filter((segment) => !isInvisibleSegment(segment));
  const routePath = [...prefix, `${marker}${interceptSegment}`, ...nestedParts]
    .filter(Boolean)
    .join("/");
  return routePath ? `/${routePath}` : "/";
}

function markerForInterceptionConvention(convention: string): string {
  switch (convention) {
    case ".":
      return "(.)";
    case "..":
      return "(..)";
    case "../..":
      return "(..)(..)";
    case "...":
      return "(...)";
    default:
      return "";
  }
}

/**
 * Find a file by name (without extension) in a directory.
 * Checks configured pageExtensions.
 */
function findFile(dir: string, name: string, matcher: ValidFileMatcher): string | null {
  for (const ext of matcher.dottedExtensions) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Convert filesystem path segments to URL route parts, skipping invisible segments
 * (route groups, @slots, ".") and converting dynamic segment syntax to Express-style
 * patterns (e.g. "[id]" → ":id", "[...slug]" → ":slug+").
 */
export function convertSegmentsToRouteParts(
  segments: readonly string[],
): { urlSegments: string[]; params: string[]; isDynamic: boolean } | null {
  const urlSegments: string[] = [];
  const params: string[] = [];
  let isDynamic = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (isInvisibleSegment(segment)) continue;

    // Catch-all segments are only valid in terminal URL position.
    // Matches Next.js PARAMETER_PATTERN: any non-] chars inside brackets.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/get-dynamic-param.ts
    const catchAllMatch = segment.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAllMatch) {
      if (hasRemainingVisibleSegments(segments, i + 1)) return null;
      // Guard: names ending in + or * would collide with internal pattern
      // modifiers (:name+ catch-all, :name* optional-catch-all).
      if (catchAllMatch[1].endsWith("+") || catchAllMatch[1].endsWith("*")) return null;
      isDynamic = true;
      params.push(catchAllMatch[1]);
      urlSegments.push(`:${catchAllMatch[1]}+`);
      continue;
    }

    const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optionalCatchAllMatch) {
      if (hasRemainingVisibleSegments(segments, i + 1)) return null;
      if (optionalCatchAllMatch[1].endsWith("+") || optionalCatchAllMatch[1].endsWith("*"))
        return null;
      isDynamic = true;
      params.push(optionalCatchAllMatch[1]);
      urlSegments.push(`:${optionalCatchAllMatch[1]}*`);
      continue;
    }

    const dynamicMatch = segment.match(/^\[([^\]]+)\]$/);
    if (dynamicMatch) {
      if (dynamicMatch[1].endsWith("+") || dynamicMatch[1].endsWith("*")) return null;
      isDynamic = true;
      params.push(dynamicMatch[1]);
      urlSegments.push(`:${dynamicMatch[1]}`);
      continue;
    }

    urlSegments.push(decodeRouteSegment(segment));
  }

  return { urlSegments, params, isDynamic };
}

function hasRemainingVisibleSegments(segments: readonly string[], startIndex: number): boolean {
  for (let i = startIndex; i < segments.length; i++) {
    if (!isInvisibleSegment(segments[i])) return true;
  }
  return false;
}

function joinRoutePattern(basePattern: string, subPath: string): string {
  if (!subPath) return basePattern;
  return basePattern === "/" ? `/${subPath}` : `${basePattern}/${subPath}`;
}
