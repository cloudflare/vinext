import {
  mergeMetadataEntries,
  mergeViewport,
  postProcessMetadata,
  resolveModuleMetadata,
  resolveModuleViewport,
  type Metadata,
  type MetadataMergeEntry,
  type Viewport,
} from "vinext/shims/metadata";
import { applyFileBasedMetadata } from "./file-based-metadata.js";
import type { AppPageParams } from "./app-page-boundary.js";
import { resolveAppPageSegmentParams } from "./app-page-params.js";
import type { MetadataFileRoute } from "./metadata-routes.js";

type AppPageSearchParams = Record<string, string | string[]>;

type AppPageHeadModule = Record<string, unknown>;

type AppPageHeadSource = {
  metadata: Metadata | null;
  routeSegments: readonly string[];
};

type AppPageHeadLayout<TModule extends AppPageHeadModule> = {
  module: TModule;
  treePosition: number;
};

type AppPageHeadParallelRoute<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  layoutModule?: TModule | null;
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  pageModule?: TModule | null;
  params?: AppPageParams | null;
  routeSegments?: readonly string[] | null;
};

type AppPageHeadSlot<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  layout?: TModule | null;
  page?: TModule | null;
};

type ResolveActiveParallelRouteHeadInputsOptions<
  TModule extends AppPageHeadModule = AppPageHeadModule,
> = {
  interceptLayouts?: readonly (TModule | null | undefined)[] | null;
  interceptPage?: TModule | null;
  interceptParams?: AppPageParams | null;
  interceptSlotKey?: string | null;
  params: AppPageParams;
  routeSegments: readonly string[];
  slots?: Record<string, AppPageHeadSlot<TModule>> | null;
};

type ResolveAppPageHeadOptions<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  fallbackOnFileMetadataError?: boolean;
  layoutModules: readonly (TModule | null | undefined)[];
  layoutTreePositions?: readonly number[] | null;
  metadataRoutes: readonly MetadataFileRoute[];
  pageModule?: TModule | null;
  parallelRoutes?: readonly AppPageHeadParallelRoute<TModule>[] | null;
  params: AppPageParams;
  routePath: string;
  routeSegments?: readonly string[] | null;
  searchParams?: URLSearchParams | null;
};

type ResolveAppPageHeadResult = {
  hasSearchParams: boolean;
  metadata: Metadata | null;
  pageSearchParams: AppPageSearchParams;
  viewport: Viewport;
};

type AppPageSearchParamsCollection = {
  hasSearchParams: boolean;
  pageSearchParams: AppPageSearchParams;
};

type ResolvedParallelRouteHead = {
  metadataResults: (Metadata | null)[];
  metadataSources: AppPageHeadSource[];
  viewportResults: (Viewport | null)[];
};

export function resolveActiveParallelRouteHeadInputs<TModule extends AppPageHeadModule>(
  options: ResolveActiveParallelRouteHeadInputsOptions<TModule>,
): AppPageHeadParallelRoute<TModule>[] {
  return Object.entries(options.slots ?? {}).map(([slotKey, slot]) => {
    if (options.interceptSlotKey === slotKey && options.interceptPage) {
      return {
        layoutModules: options.interceptLayouts ?? [],
        pageModule: options.interceptPage,
        params: options.interceptParams ?? options.params,
        routeSegments: options.routeSegments,
      };
    }

    return {
      layoutModules: slot.layout ? [slot.layout] : [],
      pageModule: slot.page,
      params: options.params,
      routeSegments: options.routeSegments,
    };
  });
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export function collectAppPageSearchParams(
  searchParams: URLSearchParams | null | undefined,
): AppPageSearchParamsCollection {
  const pageSearchParams: AppPageSearchParams = Object.create(null);
  let hasSearchParams = false;

  searchParams?.forEach((value, key) => {
    hasSearchParams = true;
    const currentValue = pageSearchParams[key];
    if (Array.isArray(currentValue)) {
      pageSearchParams[key] = [...currentValue, value];
      return;
    }
    if (currentValue !== undefined) {
      pageSearchParams[key] = [currentValue, value];
      return;
    }
    pageSearchParams[key] = value;
  });

  return { hasSearchParams, pageSearchParams };
}

function createMetadataSources(
  metadataResults: readonly (Metadata | null)[],
  routeSegments: readonly string[],
  layoutTreePositions: readonly number[],
  pageMetadata: Metadata | null,
  includePageSource: boolean,
): AppPageHeadSource[] {
  const metadataSources: AppPageHeadSource[] = metadataResults.map((metadata, index) => ({
    routeSegments: routeSegments.slice(0, layoutTreePositions[index] ?? 0),
    metadata,
  }));

  if (includePageSource) {
    metadataSources.push({
      routeSegments,
      metadata: pageMetadata,
    });
  }

  return metadataSources;
}

function createLayoutInputs<TModule extends AppPageHeadModule>(
  layoutModules: readonly (TModule | null | undefined)[],
  layoutTreePositions: readonly number[],
): AppPageHeadLayout<TModule>[] {
  const layoutInputs: AppPageHeadLayout<TModule>[] = [];

  for (let index = 0; index < layoutModules.length; index++) {
    const layoutModule = layoutModules[index];
    if (!isPresent(layoutModule)) {
      continue;
    }
    layoutInputs.push({
      module: layoutModule,
      treePosition: layoutTreePositions[index] ?? 0,
    });
  }

  return layoutInputs;
}

async function resolveLayoutMetadata<TModule extends AppPageHeadModule>(
  layoutInputs: readonly AppPageHeadLayout<TModule>[],
  params: AppPageParams,
  routeSegments: readonly string[],
): Promise<(Metadata | null)[]> {
  const layoutMetadataPromises: Promise<Metadata | null>[] = [];
  let accumulatedMetadata = Promise.resolve<Metadata>({});

  for (const layoutInput of layoutInputs) {
    const parentForLayout = accumulatedMetadata;
    const layoutParams = resolveAppPageSegmentParams(
      routeSegments,
      layoutInput.treePosition,
      params,
    );
    const metadataPromise = resolveModuleMetadata(
      layoutInput.module,
      layoutParams,
      undefined,
      parentForLayout,
    );
    layoutMetadataPromises.push(metadataPromise);
    void metadataPromise.catch(() => null);

    accumulatedMetadata = metadataPromise.then(async (metadataResult) => {
      if (metadataResult) {
        return mergeMetadataEntries([
          { metadata: await parentForLayout },
          { metadata: metadataResult },
        ]);
      }
      return parentForLayout;
    });
    void accumulatedMetadata.catch(() => null);
  }

  return Promise.all(layoutMetadataPromises);
}

async function resolveLayoutViewport<TModule extends AppPageHeadModule>(
  layoutInputs: readonly AppPageHeadLayout<TModule>[],
  params: AppPageParams,
  routeSegments: readonly string[],
): Promise<(Viewport | null)[]> {
  return Promise.all(
    layoutInputs.map((layoutInput) => {
      const layoutParams = resolveAppPageSegmentParams(
        routeSegments,
        layoutInput.treePosition,
        params,
      );
      return resolveModuleViewport(layoutInput.module, layoutParams);
    }),
  );
}

async function resolveParallelRouteHead<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
  fallbackParams: AppPageParams,
  fallbackRouteSegments: readonly string[],
  pageSearchParams: AppPageSearchParams,
  parent: Promise<Metadata>,
): Promise<ResolvedParallelRouteHead> {
  const params = parallelRoute.params ?? fallbackParams;
  const routeSegments = parallelRoute.routeSegments ?? fallbackRouteSegments;
  const metadataResults: (Metadata | null)[] = [];
  const viewportResults: (Viewport | null)[] = [];
  const metadataSources: AppPageHeadSource[] = [];
  let accumulatedMetadata = parent;
  const layoutModules = [...(parallelRoute.layoutModules ?? []), parallelRoute.layoutModule].filter(
    isPresent,
  );
  const layoutViewportPromises = layoutModules.map((layoutModule) =>
    resolveModuleViewport(layoutModule, params),
  );
  const pageViewportPromise = parallelRoute.pageModule
    ? resolveModuleViewport(parallelRoute.pageModule, params)
    : Promise.resolve(null);
  for (const layoutViewportPromise of layoutViewportPromises) {
    void layoutViewportPromise.catch(() => null);
  }
  void pageViewportPromise.catch(() => null);

  for (const layoutModule of layoutModules) {
    const layoutMetadata = await resolveModuleMetadata(
      layoutModule,
      params,
      undefined,
      accumulatedMetadata,
    );
    metadataResults.push(layoutMetadata);
    // Parallel route metadata sources are scoped to the active slot branch because
    // the route tree input does not carry per-layout segment positions inside that branch.
    metadataSources.push({ metadata: layoutMetadata, routeSegments });
    if (layoutMetadata) {
      const parentForLayout = accumulatedMetadata;
      accumulatedMetadata = parentForLayout.then(async (parentMetadata) =>
        mergeMetadataEntries([{ metadata: parentMetadata }, { metadata: layoutMetadata }]),
      );
      void accumulatedMetadata.catch(() => null);
    }
  }

  if (parallelRoute.pageModule) {
    const pageMetadata = await resolveModuleMetadata(
      parallelRoute.pageModule,
      params,
      pageSearchParams,
      accumulatedMetadata,
    );
    metadataResults.push(pageMetadata);
    // Keep the page source scoped to the same active slot branch as its layouts.
    metadataSources.push({ metadata: pageMetadata, routeSegments });
  }

  viewportResults.push(...(await Promise.all(layoutViewportPromises)));
  const pageViewport = await pageViewportPromise;
  if (parallelRoute.pageModule) {
    viewportResults.push(pageViewport);
  }

  return { metadataResults, metadataSources, viewportResults };
}

export async function resolveAppPageHead<TModule extends AppPageHeadModule>(
  options: ResolveAppPageHeadOptions<TModule>,
): Promise<ResolveAppPageHeadResult> {
  const routeSegments = options.routeSegments ?? [];
  const layoutTreePositions = options.layoutTreePositions ?? [];
  const layoutInputs = createLayoutInputs(options.layoutModules, layoutTreePositions);
  const layoutSourcePositions = layoutInputs.map((input) => input.treePosition);
  const { hasSearchParams, pageSearchParams } = collectAppPageSearchParams(options.searchParams);
  const layoutMetadataPromise = resolveLayoutMetadata(layoutInputs, options.params, routeSegments);
  const layoutViewportPromise = resolveLayoutViewport(layoutInputs, options.params, routeSegments);

  const layoutMetadataResultsForParent = layoutMetadataPromise.then((metadataResults) =>
    metadataResults.filter(isPresent),
  );
  void layoutMetadataResultsForParent.catch(() => null);
  const pageParentPromise = layoutMetadataResultsForParent.then((metadataResults) =>
    metadataResults.length > 0
      ? mergeMetadataEntries(metadataResults.map((metadata) => ({ metadata })))
      : {},
  );
  void pageParentPromise.catch(() => null);
  const pageMetadataPromise = options.pageModule
    ? resolveModuleMetadata(options.pageModule, options.params, pageSearchParams, pageParentPromise)
    : Promise.resolve(null);
  const pageViewportPromise = options.pageModule
    ? resolveModuleViewport(options.pageModule, options.params)
    : Promise.resolve(null);
  const parallelRouteHeadPromise = Promise.all(
    (options.parallelRoutes ?? []).map((parallelRoute) =>
      resolveParallelRouteHead(
        parallelRoute,
        options.params,
        routeSegments,
        pageSearchParams,
        pageParentPromise,
      ),
    ),
  );

  const [
    layoutMetadataResults,
    layoutViewportResults,
    pageMetadata,
    pageViewport,
    parallelRouteHeads,
  ] = await Promise.all([
    layoutMetadataPromise,
    layoutViewportPromise,
    pageMetadataPromise,
    pageViewportPromise,
    parallelRouteHeadPromise,
  ]);
  const parallelMetadataResults = parallelRouteHeads.flatMap((head) => head.metadataResults);
  const parallelViewportResults = parallelRouteHeads.flatMap((head) => head.viewportResults);
  const parallelMetadataSources = parallelRouteHeads.flatMap((head) => head.metadataSources);

  const metadataEntries: MetadataMergeEntry[] = [
    ...layoutMetadataResults.filter(isPresent).map((metadata) => ({ metadata })),
    ...(pageMetadata ? [{ isPage: true, metadata: pageMetadata }] : []),
    ...parallelMetadataResults
      .filter(isPresent)
      .map((metadata) => ({ contributesTitle: false, metadata })),
  ];
  const viewportList = [
    ...layoutViewportResults.filter(isPresent),
    ...(pageViewport ? [pageViewport] : []),
    ...parallelViewportResults.filter(isPresent),
  ];

  const resolvedMetadataBase =
    metadataEntries.length > 0 ? mergeMetadataEntries(metadataEntries) : null;
  const metadataSources = createMetadataSources(
    layoutMetadataResults,
    routeSegments,
    layoutSourcePositions,
    pageMetadata,
    Boolean(options.pageModule),
  );
  metadataSources.push(...parallelMetadataSources);
  let metadata = resolvedMetadataBase;

  try {
    metadata = await applyFileBasedMetadata(
      resolvedMetadataBase,
      options.routePath,
      options.params,
      options.metadataRoutes,
      {
        routeSegments,
        metadataSources,
      },
    );
  } catch (error) {
    if (!options.fallbackOnFileMetadataError) {
      throw error;
    }
    console.error(
      `[vinext] File-based metadata resolution failed while rendering error boundary for ${options.routePath}:`,
      error,
    );
  }

  if (metadata) {
    metadata = postProcessMetadata(metadata);
  }

  return {
    hasSearchParams,
    metadata,
    pageSearchParams,
    viewport: mergeViewport(viewportList),
  };
}
