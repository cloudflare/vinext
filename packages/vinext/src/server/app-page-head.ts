import {
  mergeMetadataEntries,
  mergeViewport,
  postProcessMetadata,
  resolveModuleMetadata as _resolveModuleMetadata,
  resolveModuleViewport,
  type Metadata,
  type MetadataMergeEntry,
  type Viewport,
} from "vinext/shims/metadata";
import { runWithFetchDedupe } from "vinext/shims/fetch-cache";
import type { ThenableParamsObserver } from "vinext/shims/thenable-params";
import type { AppPageParams } from "./app-page-boundary.js";
import { tagAppPageMetadataError } from "./app-page-execution.js";
import { resolveAppPageBranchParams, resolveAppPageSegmentParams } from "./app-page-params.js";
import type { MetadataFileRoute } from "./metadata-routes.js";

/**
 * Wrapped {@link _resolveModuleMetadata} that tags any thrown error with the
 * `APP_PAGE_METADATA_ERROR_MARKER` symbol. The marker lets downstream special-
 * error handling distinguish a `generateMetadata()` redirect/notFound from a
 * page-component redirect/notFound, which matters because metadata is
 * suspended/streamed in Next.js. Its redirects no longer become a plain
 * HTTP 307: RSC navigation rides inside the flight payload (200), streaming
 * document SSR gets an HTML refresh meta tag (200), and html-limited bots
 * get a blocking 307 — whereas page redirects still emit a 307 for SSR.
 * See https://github.com/cloudflare/vinext/issues/1347
 * and Next.js test/e2e/app-dir/metadata-streaming.
 */
async function resolveModuleMetadata(
  ...args: Parameters<typeof _resolveModuleMetadata>
): Promise<Metadata | null> {
  try {
    return await _resolveModuleMetadata(...args);
  } catch (error) {
    throw tagAppPageMetadataError(error);
  }
}

export type AppPageSearchParams = Record<string, string | string[]>;

export type AppPageHeadModule = Record<string, unknown>;

export type ApplyAppPageFileBasedMetadata =
  typeof import("./file-based-metadata.js").applyFileBasedMetadata;

type AppPageHeadSource = {
  metadata: Metadata | null;
  routeSegments: readonly string[];
};

export type OrderedAppPageMetadataSource<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  /** Preserve an empty result as the most specific file-metadata source. */
  includeWhenEmpty?: boolean;
  module: TModule;
  params: AppPageParams;
  routeSegments: readonly string[];
  searchParams?: AppPageSearchParams;
  searchParamsObserver?: ThenableParamsObserver;
};

type AppPageHeadLayout<TModule extends AppPageHeadModule> = {
  module: TModule;
  treePosition: number;
};

export type AppPageHeadParallelRoute<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  layoutParams?: readonly AppPageParams[] | null;
  layoutModule?: TModule | null;
  layoutModules?: readonly (TModule | null | undefined)[] | null;
  layoutTreePositions?: readonly number[] | null;
  pageModule?: TModule | null;
  params?: AppPageParams | null;
  routeSegments?: readonly string[] | null;
};

export type ActiveParallelRouteHeadInput<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  head: AppPageHeadParallelRoute<TModule>;
  notFoundModule?: TModule | null;
  notFoundParams?: AppPageParams | null;
  ownerTreePosition: number;
};

type AppPageHeadSlot<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  configLayouts?: readonly (TModule | null | undefined)[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  layout?: TModule | null;
  layoutIndex?: number;
  notFound?: TModule | null;
  notFoundTreePosition?: number | null;
  page?: TModule | null;
  routeSegments?: readonly string[] | null;
};

type ResolveActiveParallelRouteHeadInputsOptions<
  TModule extends AppPageHeadModule = AppPageHeadModule,
> = {
  interceptLayouts?: readonly (TModule | null | undefined)[] | null;
  interceptBranchSegments?: readonly string[] | null;
  interceptLayoutSegments?: readonly (readonly string[])[] | null;
  interceptPage?: TModule | null;
  interceptNotFoundBranchSegments?: readonly string[] | null;
  interceptNotFound?: TModule | null;
  interceptNotFoundTreePosition?: number | null;
  interceptParams?: AppPageParams | null;
  interceptSlotKey?: string | null;
  interceptSourcePageSegments?: readonly string[] | null;
  layoutTreePositions?: readonly number[] | null;
  params: AppPageParams;
  routeSegments: readonly string[];
  slotParams?: Readonly<Record<string, AppPageParams>> | null;
  slots?: Record<string, AppPageHeadSlot<TModule>> | null;
};

type ResolveAppPageHeadOptions<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  /**
   * Configured next.config `basePath`. Threaded into `applyFileBasedMetadata`
   * so file-based metadata route URLs (icon, opengraph-image, manifest, ...)
   * emitted in <head> are prefixed with the basePath. Empty string when no
   * basePath is configured.
   */
  basePath?: string;
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
  searchParamsObserver?: ThenableParamsObserver;
};

type AppPageMetadataOutputOptions = {
  applyFileBasedMetadata?: ApplyAppPageFileBasedMetadata;
  basePath?: string;
  fallbackOnFileMetadataError?: boolean;
  metadataRoutes: readonly MetadataFileRoute[];
  params: AppPageParams;
  routePath: string;
  routeSegments?: readonly string[] | null;
};

export type ResolveOrderedAppPageMetadataOptions<
  TModule extends AppPageHeadModule = AppPageHeadModule,
> = AppPageMetadataOutputOptions & {
  sources: readonly OrderedAppPageMetadataSource<TModule>[];
};

export type ResolveAppPageHeadResult = {
  hasDynamicMetadata: boolean;
  hasSearchParams: boolean;
  metadata: Metadata | null;
  pageSearchParams: AppPageSearchParams;
  viewport: Viewport;
};

export type PreparedAppPageHead = Omit<ResolveAppPageHeadResult, "metadata" | "viewport"> & {
  metadata: Promise<Metadata | null>;
  viewport: Promise<Viewport>;
};

type AppPageSearchParamsCollection = {
  hasSearchParams: boolean;
  pageSearchParams: AppPageSearchParams;
};

type ResolvedParallelRouteMetadata = {
  metadataResults: (Metadata | null)[];
  metadataSources: AppPageHeadSource[];
};

export function resolveActiveParallelRouteHeadInputs<TModule extends AppPageHeadModule>(
  options: ResolveActiveParallelRouteHeadInputsOptions<TModule>,
): ActiveParallelRouteHeadInput<TModule>[] {
  return Object.entries(options.slots ?? {}).map(([slotKey, slot]) => {
    const ownerTreePosition = options.layoutTreePositions?.[slot.layoutIndex ?? 0] ?? 0;
    const ownerParams = resolveAppPageSegmentParams(
      options.routeSegments,
      ownerTreePosition,
      options.params,
    );
    const slotParams = options.slotParams?.[slotKey] ?? options.params;
    const notFoundParams = slot.notFound
      ? {
          ...ownerParams,
          ...resolveParallelLayoutParams(
            slot.routeSegments ?? options.routeSegments,
            slot.notFoundTreePosition ?? 0,
            slotParams,
          ),
        }
      : null;
    if (options.interceptSlotKey === slotKey && options.interceptPage) {
      const interceptLayouts = options.interceptLayouts ?? [];
      // A slot's ordinary active page may have a not-found convention on a
      // sibling branch that is unrelated to the intercept. Only the slot-root
      // convention is a common ancestor when intercept discovery did not find
      // a nearer convention on the actual intercept branch.
      const inheritedSlotNotFound =
        slot.notFoundTreePosition === 0 ? (slot.notFound ?? null) : null;
      const interceptNotFound = options.interceptNotFound ?? inheritedSlotNotFound;
      const interceptNotFoundParams = interceptNotFound
        ? {
            ...ownerParams,
            ...resolveParallelLayoutParams(
              options.interceptNotFoundBranchSegments ??
                options.interceptBranchSegments ??
                options.routeSegments,
              options.interceptNotFound
                ? (options.interceptNotFoundTreePosition ?? 0)
                : (slot.notFoundTreePosition ?? 0),
              options.interceptParams ?? options.params,
            ),
          }
        : null;
      return {
        head: {
          layoutModules: [slot.layout, ...interceptLayouts].filter(isPresent),
          layoutParams: [
            ...(slot.layout ? [ownerParams] : []),
            ...interceptLayouts.filter(isPresent).map((_, index) => {
              const segments = options.interceptLayoutSegments?.[index] ?? [];
              return {
                ...ownerParams,
                ...resolveParallelLayoutParams(
                  options.interceptBranchSegments ?? segments,
                  segments.length,
                  options.interceptParams ?? options.params,
                ),
              };
            }),
          ],
          layoutTreePositions: [
            ...(slot.layout ? [0] : []),
            ...interceptLayouts.filter(isPresent).map(() => options.routeSegments.length),
          ],
          pageModule: options.interceptPage,
          params: options.interceptParams ?? options.params,
          routeSegments: options.interceptSourcePageSegments ?? options.routeSegments,
        },
        ...(interceptNotFound
          ? { notFoundModule: interceptNotFound, notFoundParams: interceptNotFoundParams }
          : {}),
        ownerTreePosition,
      };
    }

    return {
      head: {
        layoutModules: [slot.layout, ...(slot.configLayouts ?? [])].filter(isPresent),
        layoutParams: [
          ...(slot.layout ? [ownerParams] : []),
          ...(slot.configLayoutTreePositions ?? []).map((treePosition) => ({
            ...ownerParams,
            ...resolveParallelLayoutParams(
              slot.routeSegments ?? options.routeSegments,
              treePosition,
              options.slotParams?.[slotKey] ?? options.params,
            ),
          })),
        ],
        layoutTreePositions: [
          ...(slot.layout ? [0] : []),
          ...(slot.configLayoutTreePositions ?? []),
        ],
        pageModule: slot.page,
        params: slotParams,
        routeSegments: slot.routeSegments ?? options.routeSegments,
      },
      ...(slot.notFound ? { notFoundModule: slot.notFound, notFoundParams } : {}),
      ownerTreePosition,
    };
  });
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function resolveParallelLayoutParams(
  routeSegments: readonly string[],
  treePosition: number,
  params: AppPageParams,
): AppPageParams {
  return resolveAppPageBranchParams(routeSegments, treePosition, params);
}

function hasGenerateMetadata(module: AppPageHeadModule | null | undefined): boolean {
  return typeof module?.generateMetadata === "function";
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

async function finalizeAppPageMetadata(
  metadata: Metadata | null,
  metadataSources: readonly AppPageHeadSource[],
  options: AppPageMetadataOutputOptions,
): Promise<Metadata | null> {
  let resolvedMetadata = metadata;
  if (options.applyFileBasedMetadata && options.metadataRoutes.length > 0) {
    try {
      resolvedMetadata = await options.applyFileBasedMetadata(
        metadata,
        options.routePath,
        options.params,
        options.metadataRoutes,
        {
          routeSegments: options.routeSegments ?? [],
          metadataSources,
          basePath: options.basePath ?? "",
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
  }

  return resolvedMetadata ? postProcessMetadata(resolvedMetadata) : null;
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

function getParallelRouteModules<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
): TModule[] {
  return [...(parallelRoute.layoutModules ?? []), parallelRoute.layoutModule].filter(isPresent);
}

function parallelRouteHasDynamicMetadata<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
): boolean {
  return (
    getParallelRouteModules(parallelRoute).some(hasGenerateMetadata) ||
    hasGenerateMetadata(parallelRoute.pageModule)
  );
}

async function resolveParallelRouteMetadata<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
  fallbackParams: AppPageParams,
  fallbackRouteSegments: readonly string[],
  pageSearchParams: AppPageSearchParams,
  parent: Promise<Metadata>,
  searchParamsObserver?: ThenableParamsObserver,
): Promise<ResolvedParallelRouteMetadata> {
  const params = parallelRoute.params ?? fallbackParams;
  const routeSegments = parallelRoute.routeSegments ?? fallbackRouteSegments;
  const metadataResults: (Metadata | null)[] = [];
  const metadataSources: AppPageHeadSource[] = [];
  let accumulatedMetadata = parent;
  const layoutModules = getParallelRouteModules(parallelRoute);
  const layoutTreePositions = parallelRoute.layoutTreePositions ?? [];
  const layoutParams = parallelRoute.layoutParams ?? [];

  for (const [index, layoutModule] of layoutModules.entries()) {
    const currentLayoutParams =
      layoutParams[index] ??
      resolveParallelLayoutParams(routeSegments, layoutTreePositions[index] ?? 0, params);
    const layoutMetadata = await resolveModuleMetadata(
      layoutModule,
      currentLayoutParams,
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
      searchParamsObserver,
    );
    metadataResults.push(pageMetadata);
    // Keep the page source scoped to the same active slot branch as its layouts.
    metadataSources.push({ metadata: pageMetadata, routeSegments });
  }

  return { metadataResults, metadataSources };
}

async function resolveParallelRouteViewport<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
  fallbackParams: AppPageParams,
  fallbackRouteSegments: readonly string[],
  pageSearchParams: AppPageSearchParams,
  searchParamsObserver?: ThenableParamsObserver,
): Promise<(Viewport | null)[]> {
  const params = parallelRoute.params ?? fallbackParams;
  const routeSegments = parallelRoute.routeSegments ?? fallbackRouteSegments;
  const layoutModules = getParallelRouteModules(parallelRoute);
  const layoutTreePositions = parallelRoute.layoutTreePositions ?? [];
  const layoutParams = parallelRoute.layoutParams ?? [];
  const layoutViewportPromise = Promise.all(
    layoutModules.map((layoutModule, index) =>
      resolveModuleViewport(
        layoutModule,
        layoutParams[index] ??
          resolveParallelLayoutParams(routeSegments, layoutTreePositions[index] ?? 0, params),
      ),
    ),
  );
  const pageViewportPromise = parallelRoute.pageModule
    ? resolveModuleViewport(
        parallelRoute.pageModule,
        params,
        pageSearchParams,
        searchParamsObserver,
      )
    : Promise.resolve(null);
  const [layoutViewports, pageViewport] = await Promise.all([
    layoutViewportPromise,
    pageViewportPromise,
  ]);

  return parallelRoute.pageModule ? [...layoutViewports, pageViewport] : layoutViewports;
}

/**
 * Resolve an explicit metadata-source sequence.
 *
 * Route-specific conventions own source selection and ordering. This resolver
 * only supplies each source with its accumulated parent, merges the results,
 * and applies file-based metadata at the end.
 */
export function resolveOrderedAppPageMetadata<TModule extends AppPageHeadModule>(
  options: ResolveOrderedAppPageMetadataOptions<TModule>,
): Promise<Metadata | null> {
  return runWithFetchDedupe(async () => {
    const metadataPromises: Promise<Metadata | null>[] = [];
    let accumulatedEntriesPromise = Promise.resolve<MetadataMergeEntry[]>([]);

    for (const source of options.sources) {
      const parentPromise = accumulatedEntriesPromise.then((entries) =>
        entries.length > 0 ? mergeMetadataEntries(entries) : {},
      );
      const metadataPromise = resolveModuleMetadata(
        source.module,
        source.params,
        source.searchParams,
        parentPromise,
        source.searchParamsObserver,
      );
      metadataPromises.push(metadataPromise);
      void metadataPromise.catch(() => null);

      accumulatedEntriesPromise = Promise.all([accumulatedEntriesPromise, metadataPromise]).then(
        ([entries, metadata]) => (metadata ? [...entries, { metadata }] : entries),
      );
      void accumulatedEntriesPromise.catch(() => null);
    }

    const [metadataEntries, metadataResults] = await Promise.all([
      accumulatedEntriesPromise,
      Promise.all(metadataPromises),
    ]);
    const metadataSources = options.sources.flatMap((source, index) => {
      const metadata = metadataResults[index] ?? null;
      return metadata || source.includeWhenEmpty
        ? [{ metadata, routeSegments: source.routeSegments }]
        : [];
    });

    return finalizeAppPageMetadata(
      metadataEntries.length > 0 ? mergeMetadataEntries(metadataEntries) : null,
      metadataSources,
      options,
    );
  });
}

export async function resolveAppPageHead<TModule extends AppPageHeadModule>(
  options: ResolveAppPageHeadOptions<TModule>,
): Promise<ResolveAppPageHeadResult> {
  const prepared = prepareAppPageHead(options);
  const [metadata, viewport] = await Promise.all([prepared.metadata, prepared.viewport]);
  return { ...prepared, metadata, viewport };
}

/**
 * Start metadata and viewport resolution without coupling their completion.
 *
 * Live document renders can place the metadata promise behind Suspense while
 * still waiting for viewport tags before the shell is emitted. Blocking
 * callers use {@link resolveAppPageHead} and observe the same result as before.
 */
export function prepareAppPageHead<TModule extends AppPageHeadModule>(
  options: ResolveAppPageHeadOptions<TModule>,
): PreparedAppPageHead {
  return runWithFetchDedupe(() => prepareAppPageHeadInner(options));
}

function prepareAppPageHeadInner<TModule extends AppPageHeadModule>(
  options: ResolveAppPageHeadOptions<TModule>,
): PreparedAppPageHead {
  const routeSegments = options.routeSegments ?? [];
  const layoutTreePositions = options.layoutTreePositions ?? [];
  const layoutInputs = createLayoutInputs(options.layoutModules, layoutTreePositions);
  const layoutSourcePositions = layoutInputs.map((input) => input.treePosition);
  const primaryHasDynamicMetadata =
    layoutInputs.some((input) => hasGenerateMetadata(input.module)) ||
    hasGenerateMetadata(options.pageModule);
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
    ? resolveModuleMetadata(
        options.pageModule,
        options.params,
        pageSearchParams,
        pageParentPromise,
        options.searchParamsObserver,
      )
    : Promise.resolve(null);
  const pageViewportPromise = options.pageModule
    ? resolveModuleViewport(
        options.pageModule,
        options.params,
        pageSearchParams,
        options.searchParamsObserver,
      )
    : Promise.resolve(null);
  const parallelRoutes = options.parallelRoutes ?? [];
  const parallelRouteMetadataPromise = Promise.all(
    parallelRoutes.map((parallelRoute) =>
      resolveParallelRouteMetadata(
        parallelRoute,
        options.params,
        routeSegments,
        pageSearchParams,
        pageParentPromise,
        options.searchParamsObserver,
      ),
    ),
  );
  const parallelRouteViewportPromise = Promise.all(
    parallelRoutes.map((parallelRoute) =>
      resolveParallelRouteViewport(
        parallelRoute,
        options.params,
        routeSegments,
        pageSearchParams,
        options.searchParamsObserver,
      ),
    ),
  );
  const hasDynamicMetadata =
    primaryHasDynamicMetadata || parallelRoutes.some(parallelRouteHasDynamicMetadata);

  const metadata = Promise.all([
    layoutMetadataPromise,
    pageMetadataPromise,
    parallelRouteMetadataPromise,
  ]).then(async ([layoutMetadataResults, pageMetadata, parallelRouteMetadata]) => {
    const parallelMetadataResults = parallelRouteMetadata.flatMap((head) => head.metadataResults);
    const parallelMetadataSources = parallelRouteMetadata.flatMap((head) => head.metadataSources);

    // Active parallel slot metadata is suppressed from contributing the primary
    // <title> when the matched page already provides one. This preserves Next.js
    // behavior where slot pages (typically modals/sidebars rendered alongside the
    // main page) don't clobber the page title. When the route has no children
    // page providing a title (e.g. a parallel layout that doesn't render
    // `{children}`, or a parent that only has `default.tsx`), the slot page's
    // title is the most specific signal and is allowed to contribute — matching
    // Next.js's loader-tree walk which appends slot metadata items in tree order
    // with no title suppression.
    // Reference: https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
    const primaryPageHasTitle = pageMetadata != null && pageMetadata.title !== undefined;
    const metadataEntries: MetadataMergeEntry[] = [
      ...layoutMetadataResults.filter(isPresent).map((entry) => ({ metadata: entry })),
      ...(pageMetadata ? [{ isPage: true, metadata: pageMetadata }] : []),
      ...parallelMetadataResults
        .filter(isPresent)
        .map((entry) => ({ contributesTitle: !primaryPageHasTitle, metadata: entry })),
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
    return finalizeAppPageMetadata(resolvedMetadataBase, metadataSources, options);
  });
  const viewport = Promise.all([
    layoutViewportPromise,
    pageViewportPromise,
    parallelRouteViewportPromise,
  ]).then(([layoutViewportResults, pageViewport, parallelRouteViewports]) =>
    mergeViewport([
      ...layoutViewportResults.filter(isPresent),
      ...(pageViewport ? [pageViewport] : []),
      ...parallelRouteViewports.flat().filter(isPresent),
    ]),
  );

  // Both branches begin eagerly. If a caller observes one rejection first,
  // keep the sibling branch from becoming an unhandled rejection while the
  // request switches to its error response.
  void metadata.catch(() => null);
  void viewport.catch(() => null);

  return {
    hasDynamicMetadata,
    hasSearchParams,
    metadata,
    pageSearchParams,
    viewport,
  };
}
