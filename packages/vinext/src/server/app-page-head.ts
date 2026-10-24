import {
  mergeMetadataEntries,
  mergeViewport,
  postProcessMetadata,
  resolveModuleMetadata as _resolveModuleMetadata,
  resolveModuleViewport,
  type Metadata,
  type MetadataMergeEntry,
  type ResolvedViewport,
  type Viewport,
} from "vinext/shims/metadata";
import { runWithFetchDedupe } from "vinext/shims/fetch-cache";
import type { ThenableParamsObserver } from "vinext/shims/thenable-params";
import type { AppPageParams } from "./app-page-boundary.js";
import { tagAppPageMetadataError } from "./app-page-execution.js";
import { createAppMetadataModuleRoute, traceGenerateMetadata } from "./app-metadata-tracing.js";
import { resolveAppPageBranchParams, resolveAppPageSegmentParams } from "./app-page-params.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import { compareFolderNames } from "../utils/compare.js";
import { searchParamsToRecord } from "../utils/query.js";

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
  moduleRoute: string,
  ...args: Parameters<typeof _resolveModuleMetadata>
): Promise<Metadata | null> {
  try {
    return await (typeof args[0].generateMetadata === "function"
      ? traceGenerateMetadata(moduleRoute, () => _resolveModuleMetadata(...args))
      : _resolveModuleMetadata(...args));
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
  moduleRoute: string;
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
  moduleRoutePrefixSegments?: readonly string[] | null;
  moduleRouteSegments?: readonly string[] | null;
  pageModule?: TModule | null;
  params?: AppPageParams | null;
  routeSegments?: readonly string[] | null;
};

export type ActiveParallelRouteHeadInput<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  head: AppPageHeadParallelRoute<TModule>;
  notFoundModule?: TModule | null;
  notFoundModuleRouteSegments?: readonly string[] | null;
  notFoundParams?: AppPageParams | null;
  ownerTreePosition: number;
  /** The `slots` key of the slot this branch renders in. */
  slotKey?: string;
};

/**
 * A branch whose head Next.js resolves but never shows: a slot intercept's
 * layouts and page beside the source page. It renders in the slot at
 * `parallelRouteIndex` of `parallelRoutes` and shares that slot's first
 * `sharedLayoutCount` layouts, which resolve once for both.
 */
export type AppPageHiddenParallelRoute<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  parallelRouteIndex: number;
  route: AppPageHeadParallelRoute<TModule>;
  sharedLayoutCount: number;
};

type AppPageHeadSlot<TModule extends AppPageHeadModule = AppPageHeadModule> = {
  configLayouts?: readonly (TModule | null | undefined)[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  layout?: TModule | null;
  layoutIndex?: number;
  name?: string | null;
  notFound?: TModule | null;
  notFoundTreePosition?: number | null;
  /** Directory depth of the folder holding the `@slot` directory. */
  ownerTreePosition?: number | null;
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
  /**
   * Branches whose head Next.js resolves but never shows, such as a slot
   * intercept beside the source page. Their own generateMetadata() and
   * generateViewport() run once, after every branch before them in the loader
   * tree, and their errors reach `hiddenErrors` rather than the head.
   */
  hiddenParallelRoutes?: readonly AppPageHiddenParallelRoute<TModule>[] | null;
  layoutModules: readonly (TModule | null | undefined)[];
  layoutTreePositions?: readonly number[] | null;
  metadataRoutes: readonly MetadataFileRoute[];
  /**
   * The index in `parallelRoutes` of a shown branch whose own errors reach
   * `hiddenErrors` rather than `routeErrors`, such as a slot intercept that
   * heads the route: Next.js throws them in that page's own segment.
   */
  outletParallelRouteIndex?: number | null;
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
  viewport: ResolvedViewport;
};

export type PreparedAppPageHead = Omit<ResolveAppPageHeadResult, "metadata" | "viewport"> & {
  /**
   * Rejects with the first error, in loader-tree order, from
   * `hiddenParallelRoutes`, or from `outletParallelRouteIndex`'s own resolvers
   * and the head's own failures.
   */
  hiddenErrors: Promise<null>;
  metadata: Promise<Metadata | null>;
  /**
   * Rejects with the first error, in loader-tree order, of the other branches
   * of `metadata` and `viewport`. It never waits on the outlet branch.
   */
  routeErrors: Promise<null>;
  viewport: Promise<ResolvedViewport>;
};

/**
 * A route's head as one render prepared it, for a later render to reuse. Each
 * branch already settled its own signals, so neither rejects.
 */
export type AppPagePreparedRouteHead = {
  /** The `dynamic = "error"` access error either branch dropped, which still fails the render. */
  accessError: Promise<Error | null>;
  metadata: Promise<Metadata | null>;
  /** Where that render places generateMetadata()'s tags: "body" streams them. */
  metadataPlacement: "body" | "head";
  /** `null` when its resolution failed, so the head has no viewport tags. */
  viewport: Promise<Viewport | null>;
};

/**
 * A special-error fallback for a signal the matched route's render threw keeps
 * the route's own head: the head that render prepared, or, when it never
 * started one, a fresh resolution with that render's query and placement.
 */
export type AppPageFallbackRouteHead = {
  /** Whether metadata's `searchParams` reads count as dynamic usage, as in the render. */
  observeSearchParams: boolean;
  prepared: AppPagePreparedRouteHead | null;
  /** The query the render read: a rewrite's, or none for a static render. */
  searchParams: URLSearchParams;
  /** Whether the render streams generated metadata into the body. */
  streamMetadata: boolean;
};

type AppPageSearchParamsCollection = {
  hasSearchParams: boolean;
  pageSearchParams: AppPageSearchParams;
};

type ResolvedParallelRouteMetadata = {
  metadataEntries: { isPage: boolean; metadata: Metadata | null }[];
  metadataSources: AppPageHeadSource[];
};

type PreparedParallelRouteMetadata = {
  /** Everything before the branch's next sibling in the loader tree. */
  accumulated: Promise<Metadata>;
  /** The branch's parent after each of its layouts: `[0]` is its own parent. */
  layoutParents: Promise<Metadata>[];
  /** Each of the branch's own generateMetadata() results. */
  resolvers: Promise<unknown>[];
  result: Promise<ResolvedParallelRouteMetadata>;
};

type PreparedViewportBranch = {
  /** The branch's parent after each of its layouts: `[0]` is its own parent. */
  layoutParents: Promise<ResolvedViewport>[];
  resolvedViewport: Promise<ResolvedViewport>;
  /** Each of the branch's own generateViewport() results. */
  resolvers: Promise<unknown>[];
  viewportResults: Promise<(Viewport | null)[]>;
};

export function resolveActiveParallelRouteHeadInputs<TModule extends AppPageHeadModule>(
  options: ResolveActiveParallelRouteHeadInputsOptions<TModule>,
): ActiveParallelRouteHeadInput<TModule>[] {
  const slotEntries = Object.entries(options.slots ?? {});
  const inputs = slotEntries.map(([slotKey, slot]) => {
    const ownerTreePosition = options.layoutTreePositions?.[slot.layoutIndex ?? 0] ?? 0;
    const ownerRouteSegments = options.routeSegments.slice(0, ownerTreePosition);
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
      const interceptRouteSegments = options.interceptSourcePageSegments ?? options.routeSegments;
      const interceptNotFoundRouteSegments = options.interceptNotFound
        ? (options.interceptNotFoundBranchSegments ?? interceptRouteSegments).slice(
            0,
            options.interceptNotFoundTreePosition ?? 0,
          )
        : [
            ...ownerRouteSegments,
            ...(slot.routeSegments ?? []).slice(0, slot.notFoundTreePosition ?? 0),
          ];
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
          routeSegments: interceptRouteSegments,
        },
        ...(interceptNotFound
          ? {
              notFoundModule: interceptNotFound,
              notFoundModuleRouteSegments: interceptNotFoundRouteSegments,
              notFoundParams: interceptNotFoundParams,
            }
          : {}),
        ownerTreePosition,
        slotKey,
      };
    }

    const slotRouteSegments = slot.routeSegments ?? options.routeSegments;
    const moduleRouteSegments = slot.routeSegments ?? [];
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
        ...(ownerRouteSegments.length > 0 ? { moduleRoutePrefixSegments: ownerRouteSegments } : {}),
        ...(slot.routeSegments ? {} : { moduleRouteSegments }),
        routeSegments: slotRouteSegments,
      },
      // An unmatched slot renders its default.tsx as Next.js's `__DEFAULT__`
      // segment, which carries none of the slot directory's files, so the
      // slot's not-found never supplies the fallback's head.
      ...(slot.notFound && slot.page
        ? {
            notFoundModule: slot.notFound,
            notFoundModuleRouteSegments: [
              ...ownerRouteSegments,
              ...moduleRouteSegments.slice(0, slot.notFoundTreePosition ?? 0),
            ],
            notFoundParams,
          }
        : {}),
      ownerTreePosition,
      slotKey,
    };
  });
  // Next.js walks the loader tree depth first, `children` before the named
  // slots, so the slots of a deeper directory come first. That is the slot's
  // own directory, not the layout that renders it: app/(group)/@zeta without a
  // (group) layout shares the root layout with app/@alpha, yet the walk
  // finishes (group) before root's own slots. Turbopack orders one directory's
  // slots by name.
  // https://github.com/vercel/next.js/blob/canary/crates/next-core/src/app_structure.rs
  return inputs
    .map((input, index) => {
      const [slotKey, slot] = slotEntries[index];
      return {
        directoryDepth: slot.ownerTreePosition ?? input.ownerTreePosition,
        input,
        name: slot.name ?? slotKey,
      };
    })
    .sort(
      (left, right) =>
        right.directoryDepth - left.directoryDepth || compareFolderNames(left.name, right.name),
    )
    .map(({ input }) => input);
}

/**
 * Whether a slot intercept keeps the source route's head. Next.js's client
 * renders the head of the first leaf on a children-first walk of its router
 * tree that skips `default` segments, and a slot intercept keeps the leaves
 * before its slot from the source route. When one of them is a page, such as
 * the source page in `children`, the source head stays; otherwise the walk
 * reaches the intercept's leaf, headed by the intercepting render.
 * `sourceParallelRoutes` are the source route's own slot branches, in the
 * walk's order (resolveActiveParallelRouteHeadInputs).
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/router-reducer/reducers/find-head-in-cache.ts
 */
export function slotInterceptKeepsSourceHead(options: {
  interceptSlotKey: string;
  /** The source route; its `children` is a page unless it renders a default. */
  route: { childrenSlot?: { state: string } | null; page?: unknown };
  sourceParallelRoutes: readonly ActiveParallelRouteHeadInput[];
}): boolean {
  const { route } = options;
  if (route.page != null && (route.childrenSlot?.state ?? "active") === "active") return true;
  const interceptIndex = options.sourceParallelRoutes.findIndex(
    (input) => input.slotKey === options.interceptSlotKey,
  );
  return options.sourceParallelRoutes
    .slice(0, interceptIndex === -1 ? undefined : interceptIndex)
    .some((input) => input.head.pageModule != null);
}

/**
 * Like Promise.all, but awaits the already-started promises one at a time, so
 * the first rejection in this order wins, not the first to settle. Next.js's
 * accumulateMetadata and accumulateViewport await their loader-tree items this
 * way, so an earlier segment's signal beats a later one's. Each promise is
 * handled up front, so none rejects unhandled.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
 */
async function allInOrder<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
): Promise<T> {
  for (const promise of promises) void promise.catch(() => null);
  const results: unknown[] = [];
  for (const promise of promises) results.push(await promise);
  return results as unknown as T;
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
  const pageSearchParams = searchParamsToRecord(searchParams);
  return { hasSearchParams: Object.keys(pageSearchParams).length > 0, pageSearchParams };
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
      createAppMetadataModuleRoute(routeSegments.slice(0, layoutInput.treePosition), "layout"),
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

  return allInOrder(layoutMetadataPromises);
}

function resolveLayoutViewport<TModule extends AppPageHeadModule>(
  layoutInputs: readonly AppPageHeadLayout<TModule>[],
  params: AppPageParams,
  routeSegments: readonly string[],
): Omit<PreparedViewportBranch, "layoutParents" | "resolvers"> {
  const viewportPromises: Promise<Viewport | null>[] = [];
  let accumulatedViewport = Promise.resolve(mergeViewport([]));

  for (const layoutInput of layoutInputs) {
    const parentForLayout = accumulatedViewport;
    const layoutParams = resolveAppPageSegmentParams(
      routeSegments,
      layoutInput.treePosition,
      params,
    );
    const viewportPromise = resolveModuleViewport(
      layoutInput.module,
      layoutParams,
      undefined,
      parentForLayout,
    );
    viewportPromises.push(viewportPromise);
    void viewportPromise.catch(() => null);

    accumulatedViewport = mergeResolvedViewport(parentForLayout, viewportPromise);
    void accumulatedViewport.catch(() => null);
  }

  return {
    resolvedViewport: accumulatedViewport,
    viewportResults: allInOrder(viewportPromises),
  };
}

function mergeResolvedViewport(
  parent: Promise<ResolvedViewport>,
  viewport: Promise<Viewport | null>,
): Promise<ResolvedViewport> {
  return Promise.all([parent, viewport]).then(([resolvedParent, resolvedViewport]) =>
    resolvedViewport ? mergeViewport([resolvedParent, resolvedViewport]) : resolvedParent,
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

/** `parent` with `metadata` merged over it, as the next segment's parent. */
function mergeParentMetadata(
  parent: Promise<Metadata>,
  metadata: Promise<Metadata | null>,
): Promise<Metadata> {
  const merged = Promise.all([parent, metadata]).then(([parentMetadata, ownMetadata]) =>
    ownMetadata
      ? mergeMetadataEntries([{ metadata: parentMetadata }, { metadata: ownMetadata }])
      : parentMetadata,
  );
  void merged.catch(() => null);
  return merged;
}

/** A branch without its first `count` layouts, which another branch resolves. */
function withoutLeadingLayouts<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
  count: number,
): AppPageHeadParallelRoute<TModule> {
  if (count === 0) return parallelRoute;
  return {
    ...parallelRoute,
    layoutModule: null,
    layoutModules: getParallelRouteModules(parallelRoute).slice(count),
    layoutParams: parallelRoute.layoutParams?.slice(count) ?? null,
    layoutTreePositions: parallelRoute.layoutTreePositions?.slice(count) ?? null,
  };
}

/**
 * Start a parallel branch's metadata. Like Next.js, which calls every
 * generateMetadata() up front and hands each the metadata resolved before it
 * in the loader tree, each module starts now with its parent as a promise.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
 */
function prepareParallelRouteMetadata<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
  fallbackParams: AppPageParams,
  fallbackRouteSegments: readonly string[],
  pageSearchParams: AppPageSearchParams,
  parent: Promise<Metadata>,
  searchParamsObserver?: ThenableParamsObserver,
): PreparedParallelRouteMetadata {
  const params = parallelRoute.params ?? fallbackParams;
  const routeSegments = parallelRoute.routeSegments ?? fallbackRouteSegments;
  const moduleRoutePrefixSegments = parallelRoute.moduleRoutePrefixSegments ?? [];
  const moduleRouteSegments = parallelRoute.moduleRouteSegments ?? routeSegments;
  const layoutMetadataPromises: Promise<Metadata | null>[] = [];
  const layoutParents = [parent];
  let accumulatedMetadata = parent;
  const layoutModules = getParallelRouteModules(parallelRoute);
  const layoutTreePositions = parallelRoute.layoutTreePositions ?? [];
  const layoutParams = parallelRoute.layoutParams ?? [];

  for (const [index, layoutModule] of layoutModules.entries()) {
    const currentLayoutParams =
      layoutParams[index] ??
      resolveParallelLayoutParams(routeSegments, layoutTreePositions[index] ?? 0, params);
    const layoutMetadata = resolveModuleMetadata(
      createAppMetadataModuleRoute(
        [
          ...moduleRoutePrefixSegments,
          ...moduleRouteSegments.slice(0, layoutTreePositions[index] ?? 0),
        ],
        "layout",
      ),
      layoutModule,
      currentLayoutParams,
      undefined,
      accumulatedMetadata,
    );
    void layoutMetadata.catch(() => null);
    layoutMetadataPromises.push(layoutMetadata);
    accumulatedMetadata = mergeParentMetadata(accumulatedMetadata, layoutMetadata);
    layoutParents.push(accumulatedMetadata);
  }

  const pageMetadataPromise = parallelRoute.pageModule
    ? resolveModuleMetadata(
        createAppMetadataModuleRoute(
          [...moduleRoutePrefixSegments, ...moduleRouteSegments],
          "page",
        ),
        parallelRoute.pageModule,
        params,
        pageSearchParams,
        accumulatedMetadata,
        searchParamsObserver,
      )
    : null;
  if (pageMetadataPromise) {
    void pageMetadataPromise.catch(() => null);
    accumulatedMetadata = mergeParentMetadata(accumulatedMetadata, pageMetadataPromise);
  }

  const result = allInOrder([
    allInOrder(layoutMetadataPromises),
    pageMetadataPromise ?? Promise.resolve(null),
  ]).then(([layoutResults, pageMetadata]) => {
    const metadataEntries = [
      ...layoutResults.map((metadata) => ({ isPage: false, metadata })),
      ...(pageMetadataPromise ? [{ isPage: true, metadata: pageMetadata }] : []),
    ];
    return {
      metadataEntries,
      // Parallel route metadata sources are scoped to the active slot branch
      // because the route tree input does not carry per-layout segment
      // positions inside that branch.
      metadataSources: metadataEntries.map(({ metadata }) => ({ metadata, routeSegments })),
    };
  });
  void result.catch(() => null);

  return {
    accumulated: accumulatedMetadata,
    layoutParents,
    resolvers: [...layoutMetadataPromises, ...(pageMetadataPromise ? [pageMetadataPromise] : [])],
    result,
  };
}

function resolveParallelRouteViewport<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
  fallbackParams: AppPageParams,
  fallbackRouteSegments: readonly string[],
  pageSearchParams: AppPageSearchParams,
  parent: Promise<ResolvedViewport>,
  searchParamsObserver?: ThenableParamsObserver,
): PreparedViewportBranch {
  const params = parallelRoute.params ?? fallbackParams;
  const routeSegments = parallelRoute.routeSegments ?? fallbackRouteSegments;
  const layoutModules = getParallelRouteModules(parallelRoute);
  const layoutTreePositions = parallelRoute.layoutTreePositions ?? [];
  const layoutParams = parallelRoute.layoutParams ?? [];
  const viewportPromises: Promise<Viewport | null>[] = [];
  const layoutParents = [parent];
  let accumulatedViewport = parent;

  for (const [index, layoutModule] of layoutModules.entries()) {
    const parentForLayout = accumulatedViewport;
    const viewportPromise = resolveModuleViewport(
      layoutModule,
      layoutParams[index] ??
        resolveParallelLayoutParams(routeSegments, layoutTreePositions[index] ?? 0, params),
      undefined,
      parentForLayout,
    );
    viewportPromises.push(viewportPromise);
    void viewportPromise.catch(() => null);
    accumulatedViewport = mergeResolvedViewport(parentForLayout, viewportPromise);
    void accumulatedViewport.catch(() => null);
    layoutParents.push(accumulatedViewport);
  }

  if (parallelRoute.pageModule) {
    const parentForPage = accumulatedViewport;
    const viewportPromise = resolveModuleViewport(
      parallelRoute.pageModule,
      params,
      pageSearchParams,
      parentForPage,
      searchParamsObserver,
    );
    viewportPromises.push(viewportPromise);
    void viewportPromise.catch(() => null);
    accumulatedViewport = mergeResolvedViewport(parentForPage, viewportPromise);
    void accumulatedViewport.catch(() => null);
  }

  return {
    layoutParents,
    resolvedViewport: accumulatedViewport,
    resolvers: viewportPromises,
    viewportResults: allInOrder(viewportPromises),
  };
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
        source.moduleRoute,
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
  return {
    hasDynamicMetadata: prepared.hasDynamicMetadata,
    hasSearchParams: prepared.hasSearchParams,
    metadata,
    pageSearchParams: prepared.pageSearchParams,
    viewport,
  };
}

/**
 * Whether any segment of the page's head exports `generateMetadata()`. Known
 * from the modules alone, so callers can place the head before resolving it.
 */
export function hasAppPageDynamicMetadata<TModule extends AppPageHeadModule>(
  options: Pick<
    ResolveAppPageHeadOptions<TModule>,
    "hiddenParallelRoutes" | "layoutModules" | "pageModule" | "parallelRoutes"
  >,
): boolean {
  return (
    options.layoutModules.some(hasGenerateMetadata) ||
    hasGenerateMetadata(options.pageModule) ||
    (options.parallelRoutes ?? []).some(parallelRouteHasDynamicMetadata) ||
    (options.hiddenParallelRoutes ?? []).some((hidden) =>
      parallelRouteHasDynamicMetadata(hidden.route),
    )
  );
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
  const { hasSearchParams, pageSearchParams } = collectAppPageSearchParams(options.searchParams);
  const layoutMetadataPromise = resolveLayoutMetadata(layoutInputs, options.params, routeSegments);
  const layoutViewport = resolveLayoutViewport(layoutInputs, options.params, routeSegments);
  const layoutViewportPromise = layoutViewport.viewportResults;

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
        createAppMetadataModuleRoute(routeSegments, "page"),
        options.pageModule,
        options.params,
        pageSearchParams,
        pageParentPromise,
        options.searchParamsObserver,
      )
    : Promise.resolve(null);
  const parallelRoutes = options.parallelRoutes ?? [];
  // Next.js resolves the loader tree depth first, `children` before the named
  // slots, and hands each generateMetadata() everything resolved before it, so
  // a slot's parent holds the page's metadata and every earlier slot's.
  let parallelParentMetadata = options.pageModule
    ? mergeParentMetadata(pageParentPromise, pageMetadataPromise)
    : pageParentPromise;
  const parallelMetadataParents: Promise<Metadata>[] = [];
  const preparedParallelMetadata = parallelRoutes.map((parallelRoute) => {
    parallelMetadataParents.push(parallelParentMetadata);
    const prepared = prepareParallelRouteMetadata(
      parallelRoute,
      options.params,
      routeSegments,
      pageSearchParams,
      parallelParentMetadata,
      options.searchParamsObserver,
    );
    parallelParentMetadata = prepared.accumulated;
    return prepared;
  });
  const parallelRouteMetadataPromise = allInOrder(
    preparedParallelMetadata.map((prepared) => prepared.result),
  );
  const preparedParallelViewports: PreparedViewportBranch[] = [];
  const parallelRouteViewportPromises: Promise<(Viewport | null)[]>[] = [];
  let accumulatedViewport = layoutViewport.resolvedViewport;
  const pageParentViewport = accumulatedViewport;
  const pageViewportPromise = options.pageModule
    ? resolveModuleViewport(
        options.pageModule,
        options.params,
        pageSearchParams,
        pageParentViewport,
        options.searchParamsObserver,
      )
    : Promise.resolve(null);
  if (options.pageModule) {
    accumulatedViewport = mergeResolvedViewport(pageParentViewport, pageViewportPromise);
    void accumulatedViewport.catch(() => null);
  }
  const parallelViewportParents: Promise<ResolvedViewport>[] = [];
  for (const parallelRoute of parallelRoutes) {
    parallelViewportParents.push(accumulatedViewport);
    const parallelViewport = resolveParallelRouteViewport(
      parallelRoute,
      options.params,
      routeSegments,
      pageSearchParams,
      accumulatedViewport,
      options.searchParamsObserver,
    );
    preparedParallelViewports.push(parallelViewport);
    parallelRouteViewportPromises.push(parallelViewport.viewportResults);
    accumulatedViewport = parallelViewport.resolvedViewport;
  }
  const parallelRouteViewportPromise = allInOrder(parallelRouteViewportPromises);
  // Next.js accumulates metadata in loader-tree order, so a branch's own error
  // counts only once everything before it resolved: one its parent rejects
  // with first, such as the source page's, belongs to that earlier branch,
  // and the branch's result, which then goes unread, is handled here.
  const gateOnParent = (parent: Promise<unknown>, result: Promise<unknown>): Promise<null> => {
    void result.catch(() => null);
    return parent.then(
      () => result.then(() => null),
      () => null,
    );
  };
  // The errors the outlet's own resolvers threw rather than took from its
  // parent, recorded as they reject: `routeErrors` checks against them without
  // waiting on the outlet, whose generateMetadata() may never settle.
  const outletIndex = options.outletParallelRouteIndex ?? -1;
  const outletOwnErrors = new Set<unknown>();
  const outletBranch =
    outletIndex in preparedParallelMetadata
      ? {
          metadata: preparedParallelMetadata[outletIndex],
          metadataParent: parallelMetadataParents[outletIndex],
          viewport: preparedParallelViewports[outletIndex],
          viewportParent: parallelViewportParents[outletIndex],
        }
      : null;
  if (outletBranch) {
    for (const [parent, resolvers] of [
      [outletBranch.metadataParent, outletBranch.metadata.resolvers],
      [outletBranch.viewportParent, outletBranch.viewport.resolvers],
    ] as const) {
      let parentRejection: { error: unknown } | null = null;
      void parent.then(null, (error: unknown) => {
        parentRejection = { error };
      });
      for (const resolver of resolvers) {
        void resolver.then(null, (error: unknown) => {
          if (parentRejection?.error !== error) outletOwnErrors.add(error);
        });
      }
    }
  }
  // The branches whose own errors throw in their slot, in loader-tree order: a
  // hidden branch continues its slot's branch from the layouts they share,
  // which resolve once, as in Next.js's single loader tree.
  const slotOwnedBranches = [
    ...(options.hiddenParallelRoutes ?? []).map((hidden) => {
      const slotMetadata = preparedParallelMetadata[hidden.parallelRouteIndex];
      const slotViewport = preparedParallelViewports[hidden.parallelRouteIndex];
      const sharedLayoutCount =
        slotMetadata && slotViewport
          ? Math.min(hidden.sharedLayoutCount, slotMetadata.layoutParents.length - 1)
          : 0;
      const parallelRoute = withoutLeadingLayouts(hidden.route, sharedLayoutCount);
      const metadataParent =
        slotMetadata?.layoutParents[sharedLayoutCount] ?? parallelParentMetadata;
      const viewportParent = slotViewport?.layoutParents[sharedLayoutCount] ?? accumulatedViewport;
      return {
        metadata: gateOnParent(
          metadataParent,
          prepareParallelRouteMetadata(
            parallelRoute,
            options.params,
            routeSegments,
            pageSearchParams,
            metadataParent,
            options.searchParamsObserver,
          ).result,
        ),
        parallelRouteIndex:
          slotMetadata && slotViewport ? hidden.parallelRouteIndex : parallelRoutes.length,
        viewport: gateOnParent(
          viewportParent,
          resolveParallelRouteViewport(
            parallelRoute,
            options.params,
            routeSegments,
            pageSearchParams,
            viewportParent,
            options.searchParamsObserver,
          ).viewportResults,
        ),
      };
    }),
    ...(outletBranch
      ? [
          {
            metadata: gateOnParent(outletBranch.metadataParent, outletBranch.metadata.result),
            parallelRouteIndex: outletIndex,
            viewport: gateOnParent(
              outletBranch.viewportParent,
              outletBranch.viewport.viewportResults,
            ),
          },
        ]
      : []),
  ].sort((left, right) => left.parallelRouteIndex - right.parallelRouteIndex);
  const hasDynamicMetadata = hasAppPageDynamicMetadata(options);

  const metadataBranches = allInOrder([
    layoutMetadataPromise,
    pageMetadataPromise,
    parallelRouteMetadataPromise,
  ]);
  const metadata = metadataBranches.then(
    async ([layoutMetadataResults, pageMetadata, parallelRouteMetadata]) => {
      const parallelMetadataSources = parallelRouteMetadata.flatMap((head) => head.metadataSources);

      // Next.js merges metadata in loader-tree order, and Turbopack (Next.js 16's
      // default bundler) always puts `children` before the named slots, so a slot
      // page's title, like every other field, overrides the page's. Webpack builds
      // can order slots first; vinext follows Turbopack.
      //
      // Next.js's accumulateMetadata lets every loader-tree item but the last two
      // set the title template (`i < metadataItems.length - 2`). Each slot adds at
      // least two items, its directory and its page or default, so with a slot
      // after it a page's template wraps later titles: the route's page's, and
      // every slot page's but the last slot's. `isPage` marks the pages among the
      // last two items. Layouts keep vinext's own rule (see Known limitations).
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts (accumulateMetadata)
      // https://github.com/vercel/next.js/blob/canary/crates/next-core/src/app_structure.rs
      const lastParallelRouteIndex = parallelRouteMetadata.length - 1;
      const metadataEntries: MetadataMergeEntry[] = [
        ...layoutMetadataResults.filter(isPresent).map((entry) => ({ metadata: entry })),
        ...(pageMetadata
          ? [{ ...(lastParallelRouteIndex === -1 ? { isPage: true } : {}), metadata: pageMetadata }]
          : []),
        ...parallelRouteMetadata.flatMap((head, index) =>
          head.metadataEntries.flatMap(({ isPage, metadata: entry }) =>
            entry
              ? [
                  {
                    ...(isPage && index === lastParallelRouteIndex ? { isPage } : {}),
                    metadata: entry,
                  },
                ]
              : [],
          ),
        ),
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
    },
  );
  const viewport = allInOrder([
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
  // The head's own failures, such as file-based metadata's, once every branch
  // resolved. Next.js throws them from its single MetadataOutlet, in the page
  // that heads the route: the outlet branch's when there is one.
  const metadataOwnErrors = metadataBranches.then(
    () => metadata.then(() => null),
    () => null,
  );
  // Like Next.js's MetadataOutlet, the first of metadata's and viewport's
  // errors to settle fails the outlet, each taken in loader-tree order.
  const hiddenErrors = Promise.all([
    allInOrder([
      ...slotOwnedBranches.map((branch) => branch.metadata),
      ...(outletBranch ? [metadataOwnErrors] : []),
    ]),
    allInOrder(slotOwnedBranches.map((branch) => branch.viewport)),
  ]).then(() => null);
  void hiddenErrors.catch(() => null);
  // The route's errors are every other branch's, in loader-tree order. They
  // never wait on the outlet branch, whose generateMetadata() or
  // generateViewport() may never settle, and skip an error a later branch took
  // from it through `parent`.
  const firstRouteError = async (branches: readonly Promise<unknown>[]): Promise<null> => {
    for (const branch of branches) void branch.catch(() => null);
    for (const branch of branches) {
      try {
        await branch;
      } catch (error) {
        if (!outletOwnErrors.has(error)) throw error;
      }
    }
    return null;
  };
  const routeErrors = Promise.all([
    firstRouteError([
      layoutMetadataPromise,
      pageMetadataPromise,
      ...preparedParallelMetadata.flatMap((prepared, index) =>
        index === outletIndex ? [] : prepared.resolvers,
      ),
      ...(outletBranch ? [] : [metadataOwnErrors]),
    ]),
    firstRouteError([
      layoutViewportPromise,
      pageViewportPromise,
      ...preparedParallelViewports.flatMap((prepared, index) =>
        index === outletIndex ? [] : prepared.resolvers,
      ),
    ]),
  ]).then(() => null);
  void routeErrors.catch(() => null);

  return {
    hasDynamicMetadata,
    hasSearchParams,
    hiddenErrors,
    metadata,
    pageSearchParams,
    routeErrors,
    viewport,
  };
}
