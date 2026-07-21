import {
  mergeViewport,
  resolveModuleViewport,
  type Metadata,
  type ResolvedViewport,
} from "vinext/shims/metadata";
import type { AppPageParams } from "./app-page-boundary.js";
import {
  resolveOrderedAppPageMetadata,
  type ActiveParallelRouteHeadInput,
  type AppPageHeadModule,
  type ApplyAppPageFileBasedMetadata,
  type OrderedAppPageMetadataSource,
} from "./app-page-head.js";
import { resolveAppPageBranchParams, resolveAppPageSegmentParams } from "./app-page-params.js";
import type { MetadataFileRoute } from "./metadata-routes.js";

type HttpAccessFallbackMetadataPlanOptions<TModule extends AppPageHeadModule = AppPageHeadModule> =
  {
    boundaryModule?: TModule | null;
    boundaryParams: AppPageParams;
    /** Whether active branches may replace the fallback with their local not-found convention. */
    branchNotFoundConventions?: boolean;
    layoutModules: readonly (TModule | null | undefined)[];
    layoutTreePositions?: readonly number[] | null;
    parallelBranches?: readonly ActiveParallelRouteHeadInput<TModule>[] | null;
    params: AppPageParams;
    primaryParallelBranch?: ActiveParallelRouteHeadInput<TModule> | null;
    routeSegments?: readonly string[] | null;
  };

type ResolveHttpAccessFallbackMetadataOptions<
  TModule extends AppPageHeadModule = AppPageHeadModule,
> = HttpAccessFallbackMetadataPlanOptions<TModule> & {
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  basePath?: string;
  fallbackOnFileMetadataError?: boolean;
  metadataRoutes: readonly MetadataFileRoute[];
  routePath: string;
};

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Translate HTTP-access boundary semantics into the exact metadata source
 * order used by Next.js's loader-tree walk.
 *
 * The not-found convention is appended at every active leaf. A sibling
 * intercept is the primary leaf and therefore precedes the ordinary slot
 * branches; otherwise the convention also represents the primary page leaf.
 */
function createHttpAccessFallbackPlan<TModule extends AppPageHeadModule>(
  options: HttpAccessFallbackMetadataPlanOptions<TModule>,
  fallbackLeafMode: "final" | "snapshot",
): OrderedAppPageMetadataSource<TModule>[] {
  const routeSegments = options.routeSegments ?? [];
  const plan: (
    | { kind: "source"; source: OrderedAppPageMetadataSource<TModule> }
    | { kind: "fallback-leaf" }
  )[] = [];

  for (const [index, layoutModule] of options.layoutModules.entries()) {
    if (!isPresent(layoutModule)) continue;

    const treePosition = options.layoutTreePositions?.[index] ?? 0;
    plan.push({
      kind: "source",
      source: {
        includeWhenEmpty: true,
        module: layoutModule,
        params: resolveAppPageSegmentParams(routeSegments, treePosition, options.params),
        routeSegments: routeSegments.slice(0, treePosition),
      },
    });
  }

  let activeBoundaryModule = options.boundaryModule;
  let activeBoundaryParams = options.boundaryParams;
  let activeBoundaryRouteSegments = routeSegments;
  const appendFallbackLeaf = () => {
    if (fallbackLeafMode === "final") {
      plan.push({ kind: "fallback-leaf" });
      return;
    }
    if (!activeBoundaryModule) return;
    plan.push({
      kind: "source",
      source: {
        includeWhenEmpty: true,
        module: activeBoundaryModule,
        params: activeBoundaryParams,
        routeSegments: activeBoundaryRouteSegments,
      },
    });
  };

  if (!options.primaryParallelBranch) {
    appendFallbackLeaf();
  }

  const parallelBranches = [
    ...(options.primaryParallelBranch ? [options.primaryParallelBranch] : []),
    ...[...(options.parallelBranches ?? [])].sort(
      (left, right) => right.ownerTreePosition - left.ownerTreePosition,
    ),
  ];

  for (const branch of parallelBranches) {
    const parallelRoute = branch.head;
    const parallelParams = parallelRoute.params ?? options.params;
    const parallelRouteSegments = parallelRoute.routeSegments ?? routeSegments;
    const layoutModules = [
      ...(parallelRoute.layoutModules ?? []),
      parallelRoute.layoutModule,
    ].filter(isPresent);
    const layoutTreePositions = parallelRoute.layoutTreePositions ?? [];
    const layoutParams = parallelRoute.layoutParams ?? [];

    for (const [index, layoutModule] of layoutModules.entries()) {
      plan.push({
        kind: "source",
        source: {
          includeWhenEmpty: true,
          module: layoutModule,
          params:
            layoutParams[index] ??
            resolveAppPageBranchParams(
              parallelRouteSegments,
              layoutTreePositions[index] ?? 0,
              parallelParams,
            ),
          routeSegments: parallelRouteSegments,
        },
      });
    }
    if (options.branchNotFoundConventions !== false && branch.notFoundModule) {
      activeBoundaryModule = branch.notFoundModule;
      activeBoundaryParams = branch.notFoundParams ?? parallelParams;
      activeBoundaryRouteSegments = parallelRouteSegments;
    }
    appendFallbackLeaf();
  }

  return plan.flatMap((item) => {
    if (item.kind === "source") return [item.source];
    if (!activeBoundaryModule) return [];
    return [
      {
        includeWhenEmpty: true,
        module: activeBoundaryModule,
        params: activeBoundaryParams,
        routeSegments: activeBoundaryRouteSegments,
      },
    ];
  });
}

export function createHttpAccessFallbackMetadataPlan<TModule extends AppPageHeadModule>(
  options: HttpAccessFallbackMetadataPlanOptions<TModule>,
): OrderedAppPageMetadataSource<TModule>[] {
  return createHttpAccessFallbackPlan(options, "final");
}

export function resolveHttpAccessFallbackMetadata<TModule extends AppPageHeadModule>(
  options: ResolveHttpAccessFallbackMetadataOptions<TModule>,
): Promise<Metadata | null> {
  return resolveOrderedAppPageMetadata({
    applyFileBasedMetadata: options.applyFileBasedMetadata,
    basePath: options.basePath,
    fallbackOnFileMetadataError: options.fallbackOnFileMetadataError,
    metadataRoutes: options.metadataRoutes,
    params: options.params,
    routePath: options.routePath,
    routeSegments: options.routeSegments,
    sources: createHttpAccessFallbackMetadataPlan(options),
  });
}

export async function resolveHttpAccessFallbackViewport<TModule extends AppPageHeadModule>(
  options: HttpAccessFallbackMetadataPlanOptions<TModule>,
): Promise<ResolvedViewport> {
  let accumulatedViewport = Promise.resolve(mergeViewport([]));

  for (const source of createHttpAccessFallbackPlan(options, "snapshot")) {
    const parentForSource = accumulatedViewport;
    const viewportPromise = resolveModuleViewport(
      source.module,
      source.params,
      undefined,
      parentForSource,
    );
    void viewportPromise.catch(() => null);
    accumulatedViewport = Promise.all([parentForSource, viewportPromise]).then(
      ([parent, viewport]) => (viewport ? mergeViewport([parent, viewport]) : parent),
    );
    void accumulatedViewport.catch(() => null);
  }

  return accumulatedViewport;
}
