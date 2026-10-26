import {
  mergeViewport,
  resolveModuleViewport,
  type Metadata,
  type ResolvedViewport,
  type Viewport,
} from "vinext/shims/metadata";
import { isStaticGenerationAccessError } from "vinext/shims/internal/headers-state";
import { resolveAppPageParentHttpAccessBoundary, type AppPageParams } from "./app-page-boundary.js";
import { resolveAppPageSpecialError } from "./app-page-execution.js";
import {
  resolveOrderedAppPageMetadata,
  type ActiveParallelRouteHeadInput,
  type AppPageHeadModule,
  type ApplyAppPageFileBasedMetadata,
  type OrderedAppPageMetadataSource,
} from "./app-page-head.js";
import { createAppMetadataModuleRoute } from "./app-metadata-tracing.js";
import { resolveAppPageBranchParams, resolveAppPageSegmentParams } from "./app-page-params.js";
import type { MetadataFileRoute } from "./metadata-routes.js";

type HttpAccessFallbackMetadataPlanOptions<TModule extends AppPageHeadModule = AppPageHeadModule> =
  {
    boundaryModule?: TModule | null;
    boundaryParams: AppPageParams;
    boundaryRouteSegments?: readonly string[] | null;
    /** Whether active branches may replace the fallback with their local not-found convention. */
    branchNotFoundConventions?: boolean;
    errorConvention: "forbidden" | "not-found" | "unauthorized";
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
        moduleRoute: createAppMetadataModuleRoute(
          routeSegments.slice(0, treePosition),
          options.errorConvention,
        ),
        params: resolveAppPageSegmentParams(routeSegments, treePosition, options.params),
        routeSegments: routeSegments.slice(0, treePosition),
      },
    });
  }

  let activeBoundaryModule = options.boundaryModule;
  let activeBoundaryParams = options.boundaryParams;
  let activeBoundaryRouteSegments = options.boundaryRouteSegments ?? [];
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
        moduleRoute: createAppMetadataModuleRoute(
          activeBoundaryRouteSegments,
          options.errorConvention,
        ),
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
    const parallelModuleRoutePrefix = parallelRoute.moduleRoutePrefixSegments ?? [];
    const parallelModuleRouteSegments = parallelRoute.moduleRouteSegments ?? parallelRouteSegments;
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
          moduleRoute: createAppMetadataModuleRoute(
            [
              ...parallelModuleRoutePrefix,
              ...parallelModuleRouteSegments.slice(0, layoutTreePositions[index] ?? 0),
            ],
            options.errorConvention,
          ),
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
      activeBoundaryRouteSegments = branch.notFoundModuleRouteSegments ?? [
        ...parallelModuleRoutePrefix,
        ...parallelModuleRouteSegments,
      ];
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
        moduleRoute: createAppMetadataModuleRoute(
          activeBoundaryRouteSegments,
          options.errorConvention,
        ),
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

type RouteNotFoundHeadPlanRoute<TModule extends AppPageHeadModule> = {
  layouts?: readonly (TModule | null | undefined)[];
  layoutTreePositions?: readonly number[] | null;
  notFound?: TModule | null;
  notFounds?: readonly (TModule | null | undefined)[] | null;
  notFoundTreePosition?: number | null;
  routeSegments?: readonly string[] | null;
};

/**
 * The not-found head a route's own head falls back to. Like Next.js's
 * metadata tree, every HTTP access signal from generateMetadata() or
 * generateViewport() resolves through the not-found convention, whichever
 * signal the route's render threw.
 */
export function createRouteNotFoundHeadPlanOptions<TModule extends AppPageHeadModule>(options: {
  parallelBranches: readonly ActiveParallelRouteHeadInput<TModule>[];
  params: AppPageParams;
  primaryParallelBranch: ActiveParallelRouteHeadInput<TModule> | null;
  rootNotFoundModule?: TModule | null;
  route: RouteNotFoundHeadPlanRoute<TModule>;
}): HttpAccessFallbackMetadataPlanOptions<TModule> {
  const { route } = options;
  const routeSegments = route.routeSegments ?? [];
  const layoutModules = route.layouts ?? [];
  let boundaryModule = route.notFound ?? null;
  let boundaryTreePosition = boundaryModule ? route.notFoundTreePosition : null;
  if (!boundaryModule) {
    const parentBoundary = resolveAppPageParentHttpAccessBoundary({
      layoutIndex: layoutModules.length,
      rootNotFoundModule: options.rootNotFoundModule,
      routeNotFoundModules: route.notFounds,
      statusCode: 404,
    });
    boundaryModule = parentBoundary.module;
    boundaryTreePosition =
      parentBoundary.layoutIndex === null
        ? null
        : route.layoutTreePositions?.[parentBoundary.layoutIndex];
  }
  return {
    boundaryModule,
    boundaryParams:
      boundaryModule && boundaryTreePosition != null
        ? resolveAppPageSegmentParams(routeSegments, boundaryTreePosition, options.params)
        : {},
    boundaryRouteSegments: routeSegments.slice(0, boundaryTreePosition ?? 0),
    errorConvention: "not-found",
    layoutModules,
    layoutTreePositions: route.layoutTreePositions,
    parallelBranches: options.parallelBranches,
    params: options.params,
    primaryParallelBranch: options.primaryParallelBranch,
    routeSegments: route.routeSegments ?? null,
  };
}

/**
 * Settle each branch of a route's head on its own, as Next.js's MetadataTree
 * and ViewportTree do: an HTTP access signal from generateMetadata() keeps the
 * resolved viewport and resolves the metadata through the not-found
 * convention, and the same holds the other way round. Any other error leaves
 * that branch empty; the route's render reports it where it renders.
 *
 * A `dynamic = "error"` access error leaves its branch empty too, but
 * `accessError` keeps it, whether the route's head or the not-found head it
 * recovers through threw it: Next.js fails such a render even where its
 * metadata trees drop the error, so a fallback without the route's outlet
 * rethrows it.
 */
export function recoverAppPageRouteHead<TModule extends AppPageHeadModule>(
  head: { metadata: Promise<Metadata | null>; viewport: Promise<ResolvedViewport> },
  options: Omit<
    ResolveHttpAccessFallbackMetadataOptions<TModule>,
    keyof HttpAccessFallbackMetadataPlanOptions<TModule>
  > & {
    resolvePlanOptions: () => HttpAccessFallbackMetadataPlanOptions<TModule>;
  },
): {
  accessError: Promise<Error | null>;
  metadata: Promise<Metadata | null>;
  /** `null` when the branch failed: like Next.js's, the head then has no viewport tags. */
  viewport: Promise<Viewport | null>;
} {
  const { resolvePlanOptions, ...metadataOptions } = options;
  type Settled<T> = { accessError: Error | null; value: T };
  const settleEmpty = <T>(error: unknown, empty: T): Settled<T> => ({
    accessError: isStaticGenerationAccessError(error) ? error : null,
    value: empty,
  });
  const recover = <T>(
    branch: Promise<T>,
    recoverBranch: () => Promise<T>,
    empty: T,
  ): Promise<Settled<T>> =>
    branch.then(
      (value) => ({ accessError: null, value }),
      (error: unknown) =>
        resolveAppPageSpecialError(error)?.kind === "http-access-fallback"
          ? recoverBranch().then(
              (value) => ({ accessError: null, value }),
              (recoveryError: unknown) => settleEmpty(recoveryError, empty),
            )
          : settleEmpty(error, empty),
    );
  const metadata = recover<Metadata | null>(
    head.metadata,
    () => resolveHttpAccessFallbackMetadata({ ...metadataOptions, ...resolvePlanOptions() }),
    null,
  );
  // Next.js's Viewport renders null for a failed branch, not its defaults.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/metadata.tsx (createMetadataComponents)
  const viewport = recover<Viewport | null>(
    head.viewport,
    () => resolveHttpAccessFallbackViewport(resolvePlanOptions()),
    null,
  );
  return {
    accessError: Promise.all([metadata, viewport]).then(
      ([metadataResult, viewportResult]) =>
        metadataResult.accessError ?? viewportResult.accessError,
    ),
    metadata: metadata.then((result) => result.value),
    viewport: viewport.then((result) => result.value),
  };
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
