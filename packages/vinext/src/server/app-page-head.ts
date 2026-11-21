import {
  mergeMetadataEntries,
  mergeParentMetadataEntries,
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
  /**
   * Whether each layout is in its page's own loader-tree segment, from the
   * filesystem: route groups are segments, and an intercept's
   * `layoutTreePositions` don't count its page's. Unmarked layouts are above it.
   */
  layoutsBesidePage?: readonly boolean[] | null;
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
  /**
   * The active page's tree position below the slot root, route groups
   * included, in the coordinates of `configLayoutTreePositions`.
   */
  pageTreePosition?: number | null;
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
   * Rejects with the first own error, in loader-tree order, of an item of
   * `hiddenParallelRoutes` or of `outletParallelRouteIndex`, or with the
   * head's own failure when that outlet branch heads the route.
   */
  hiddenErrors: Promise<null>;
  metadata: Promise<Metadata | null>;
  /**
   * Rejects with the first own error, in loader-tree order, of every other
   * item, or with the head's own failure. Those errors never wait on the
   * outlet branch; what only the outlet branch settling makes known, a later
   * item's failed merge or its error after reading `parent`, counts after them.
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

/** A layout or page of the head's loader tree. */
type AppPageHeadSegment<TModule extends AppPageHeadModule> = {
  module: TModule;
  /** The route its generateMetadata() is traced under. */
  moduleRoute: string;
  /** Pages get `searchParams`; layouts don't. */
  page: boolean;
  /** A layout in the same loader-tree segment as its branch's page. */
  besidePage?: boolean;
  params: AppPageParams;
};

/** A branch's segments in loader-tree order: its layouts, then its page. */
type AppPageHeadBranch<TModule extends AppPageHeadModule> = {
  /** The route its metadata sources report. */
  routeSegments: readonly string[];
  segments: AppPageHeadSegment<TModule>[];
};

/**
 * A branch Next.js resolves but never shows. It starts in its slot's place,
 * `-1` for after every slot, after the first `sharedLayoutCount` of that
 * slot's layouts, which it shares.
 */
type AppPageHeadHiddenBranch<TModule extends AppPageHeadModule> = AppPageHeadBranch<TModule> & {
  parallelRouteIndex: number;
  sharedLayoutCount: number;
};

/** How metadata or viewport resolves a segment and merges its value. */
type AppPageHeadKind<TResolved, TValue> = {
  initial: TResolved;
  /**
   * `stashed` is everything resolved up to the last item that may set the
   * title template for this one: `resolved` itself, except for the page that
   * comes last (see {@link walkAppPageHead}).
   */
  merge: (resolved: TResolved, value: TValue, stashed: TResolved) => TResolved;
  resolve: (
    segment: AppPageHeadSegment<AppPageHeadModule>,
    parent: Promise<TResolved>,
  ) => Promise<TValue | null>;
};

/**
 * Whose errors an item's are: the route's, or the slot's, thrown inside the
 * slot by a hidden branch or the outlet branch.
 */
type AppPageHeadOwner = "route" | "slot";

type AppPageHeadItem<TResolved, TValue> = {
  /**
   * Rejects with the item's own error: its resolver's, but not one it took
   * from `parent`, or merging its value.
   */
  error: Promise<null>;
  /**
   * With `deferParentErrors`, `error` settles once the resolver settles or
   * reads `parent`, and this rejects with what is only known after `parent`:
   * merging its value, or its own error once it read `parent`.
   */
  deferredError: Promise<null> | null;
  /** Everything resolved before the item, with its value merged in. */
  resolved: Promise<TResolved>;
  result: Promise<TValue | null>;
};

/** Metadata or viewport, walked over the loader tree. */
type AppPageHeadWalk<TResolved, TValue> = {
  /** Every item's own error, in loader-tree order, hidden branches included. */
  errors: { error: Promise<null>; owner: AppPageHeadOwner }[];
  /** The route's items' errors known only after the outlet branch, in loader-tree order. */
  deferredErrors: Promise<null>[];
  /** Every shown item's value, merged in loader-tree order. */
  resolved: Promise<TResolved>;
  /** Each value of the route's segments. */
  route: Promise<TValue | null>[];
  /** Each value of each slot's segments. */
  slots: Promise<TValue | null>[][];
};

/** Whether each intercepting layout is in its intercepting page's own directory. */
export function resolveInterceptLayoutsBesidePage(
  layoutSegments: readonly (readonly string[])[] | null | undefined,
  branchSegments: readonly string[] | null | undefined,
): boolean[] {
  return (layoutSegments ?? []).map((segments) => segments.length === branchSegments?.length);
}

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
          layoutsBesidePage: [
            ...(slot.layout ? [false] : []),
            ...resolveInterceptLayoutsBesidePage(
              options.interceptLayoutSegments,
              options.interceptBranchSegments,
            ),
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
    const layoutTreePositions = [
      ...(slot.layout ? [0] : []),
      ...(slot.configLayoutTreePositions ?? []),
    ];
    const pageTreePosition = slot.pageTreePosition;
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
        ...(pageTreePosition == null
          ? {}
          : {
              layoutsBesidePage: layoutTreePositions.map(
                (treePosition) => treePosition >= pageTreePosition,
              ),
            }),
        layoutTreePositions,
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

/**
 * A segment's `parent` that records a rejection its resolver saw, through
 * `await` or any other `then()`, so that an error the resolver took from
 * `parent` can be told from its own, even when both are the same value.
 */
class ObservedParent<T> extends Promise<T> {
  static override get [Symbol.species]() {
    return Promise;
  }

  rejection: { error: unknown } | null = null;
  /** Whether the resolver read it, and what to call when it first does. */
  read = false;
  onRead: (() => void) | null = null;

  // A Promise subclass's then() is what `await` calls, which is the point.
  // oxlint-disable-next-line unicorn/no-thenable
  override then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (!this.read) {
      this.read = true;
      this.onRead?.();
    }
    return super.then(onFulfilled, (error: unknown) => {
      this.rejection = { error };
      if (onRejected) return onRejected(error);
      throw error;
    });
  }
}

function observeParent<T>(parent: Promise<T>): ObservedParent<T> {
  const observed = new ObservedParent<T>((resolveParent, rejectParent) => {
    parent.then(resolveParent, rejectParent);
  });
  // Handled without counting as the resolver's own read.
  void Promise.prototype.then.call(observed, undefined, () => null);
  return observed;
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

type MetadataTitle = Metadata["title"];

/** The walk's accumulated metadata, with its resolved titles as the shown strings. */
function toShownMetadata(accumulated: Metadata): Metadata {
  const shown = (title: MetadataTitle) =>
    typeof title === "object" && title ? title.absolute || undefined : title;
  const result = { ...accumulated };
  if (typeof accumulated.title === "object") result.title = shown(accumulated.title);
  if (accumulated.openGraph) {
    result.openGraph = { ...accumulated.openGraph, title: shown(accumulated.openGraph.title) };
  }
  if (accumulated.twitter) {
    result.twitter = { ...accumulated.twitter, title: shown(accumulated.twitter.title) };
  }
  return result;
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

function createRouteHeadBranch<TModule extends AppPageHeadModule>(
  layoutInputs: readonly AppPageHeadLayout<TModule>[],
  routeSegments: readonly string[],
  params: AppPageParams,
  pageModule: TModule | null | undefined,
): AppPageHeadBranch<TModule> {
  const segments: AppPageHeadSegment<TModule>[] = layoutInputs.map((layoutInput) => ({
    besidePage: layoutInput.treePosition >= routeSegments.length,
    module: layoutInput.module,
    moduleRoute: createAppMetadataModuleRoute(
      routeSegments.slice(0, layoutInput.treePosition),
      "layout",
    ),
    page: false,
    params: resolveAppPageSegmentParams(routeSegments, layoutInput.treePosition, params),
  }));
  if (pageModule) {
    segments.push({
      module: pageModule,
      moduleRoute: createAppMetadataModuleRoute(routeSegments, "page"),
      page: true,
      params,
    });
  }
  return { routeSegments, segments };
}

function createParallelRouteHeadBranch<TModule extends AppPageHeadModule>(
  parallelRoute: AppPageHeadParallelRoute<TModule>,
  fallbackParams: AppPageParams,
  fallbackRouteSegments: readonly string[],
): AppPageHeadBranch<TModule> {
  const params = parallelRoute.params ?? fallbackParams;
  const routeSegments = parallelRoute.routeSegments ?? fallbackRouteSegments;
  const moduleRoutePrefixSegments = parallelRoute.moduleRoutePrefixSegments ?? [];
  const moduleRouteSegments = parallelRoute.moduleRouteSegments ?? routeSegments;
  const layoutTreePositions = parallelRoute.layoutTreePositions ?? [];
  const layoutParams = parallelRoute.layoutParams ?? [];
  const segments = getParallelRouteModules(parallelRoute).map(
    (module, index): AppPageHeadSegment<TModule> => ({
      besidePage: parallelRoute.layoutsBesidePage?.[index] ?? false,
      module,
      moduleRoute: createAppMetadataModuleRoute(
        [
          ...moduleRoutePrefixSegments,
          ...moduleRouteSegments.slice(0, layoutTreePositions[index] ?? 0),
        ],
        "layout",
      ),
      page: false,
      params:
        layoutParams[index] ??
        resolveParallelLayoutParams(routeSegments, layoutTreePositions[index] ?? 0, params),
    }),
  );
  if (parallelRoute.pageModule) {
    segments.push({
      module: parallelRoute.pageModule,
      moduleRoute: createAppMetadataModuleRoute(
        [...moduleRoutePrefixSegments, ...moduleRouteSegments],
        "page",
      ),
      page: true,
      params,
    });
  }
  return { routeSegments, segments };
}

/** A hidden branch without the layouts it shares with its slot, which resolve once. */
function createHiddenHeadBranch<TModule extends AppPageHeadModule>(
  hidden: AppPageHiddenParallelRoute<TModule>,
  slot: AppPageHeadBranch<TModule> | undefined,
  fallbackParams: AppPageParams,
  fallbackRouteSegments: readonly string[],
): AppPageHeadHiddenBranch<TModule> {
  const branch = createParallelRouteHeadBranch(hidden.route, fallbackParams, fallbackRouteSegments);
  const sharedLayoutCount = slot
    ? Math.min(hidden.sharedLayoutCount, slot.segments.filter((segment) => !segment.page).length)
    : 0;
  return {
    parallelRouteIndex: slot ? hidden.parallelRouteIndex : -1,
    routeSegments: branch.routeSegments,
    segments: branch.segments.filter(
      (segment, index) => segment.page || index >= sharedLayoutCount,
    ),
    sharedLayoutCount,
  };
}

/**
 * Start an item with everything resolved before it as `parent`, and merge its
 * value into that once both settle. Like Next.js's getResult, the resolver
 * starts now; like its accumulateMetadata and accumulateViewport, the merge
 * waits for the items before it, and its failure is the item's own error.
 *
 * With `deferParentErrors`, `error` never waits on `parent`: what can only be
 * known after it goes to `deferredError` instead.
 */
function startAppPageHeadItem<TResolved, TValue>(
  kind: AppPageHeadKind<TResolved, TValue>,
  segment: AppPageHeadSegment<AppPageHeadModule>,
  parent: Promise<TResolved>,
  deferParentErrors = false,
  stashed: Promise<TResolved> = parent,
): AppPageHeadItem<TResolved, TValue> {
  const observedParent = observeParent(parent);
  const parentRead = new Promise<null>((resolve) => {
    observedParent.onRead = () => resolve(null);
  });
  const result = kind.resolve(segment, observedParent);
  void result.catch(() => null);
  const resolved = parent.then((resolvedParent) =>
    stashed.then((resolvedStashed) =>
      result.then((value) =>
        value ? kind.merge(resolvedParent, value, resolvedStashed) : resolvedParent,
      ),
    ),
  );
  void resolved.catch(() => null);
  // Once its value resolved, a failed merge is the item's own error, unless
  // the items before it failed first. Without a value there's nothing to
  // merge, so it doesn't wait for them.
  const mergeError = result.then(
    (value) =>
      value
        ? parent.then(
            () => resolved.then(() => null),
            () => null,
          )
        : null,
    () => null,
  );
  // A resolver's error counts unless it took it from `parent`.
  const ownError = result.then(
    () => null,
    (error: unknown) => {
      const rejection = observedParent.rejection;
      if (rejection && Object.is(rejection.error, error)) return null;
      throw error;
    },
  );
  void mergeError.catch(() => null);
  void ownError.catch(() => null);
  if (!deferParentErrors) {
    const error = ownError.then(() => mergeError);
    void error.catch(() => null);
    return { deferredError: null, error, resolved, result };
  }
  // Whether the resolver read `parent` before it settled. Until it does, its
  // error is its own, so it counts in place; once it does, it may wait on
  // `parent`, so its error is deferred with its merge.
  const readFirst = result.then(
    () => observedParent.read,
    () => observedParent.read,
  );
  const error = Promise.race([parentRead, readFirst.then((read) => (read ? null : ownError))]);
  const deferredError = readFirst.then((read) =>
    read ? ownError.then(() => mergeError) : mergeError,
  );
  void error.catch(() => null);
  void deferredError.catch(() => null);
  return { deferredError, error, resolved, result };
}

/**
 * Start metadata or viewport for every item, then merge their values one at
 * a time, in loader-tree order, as Next.js's prerenderMetadata and
 * accumulateMetadata (and their viewport twins) do. Next.js walks the tree
 * depth first, `children` before the named slots: the route's layouts and
 * page, then each slot's. A hidden branch starts in its slot's place, after
 * the layouts they share, from everything resolved there, and its values stay
 * out of the shown head.
 *
 * The items of a hidden branch and of the slot at `outletIndex` are the
 * slot's. Like Next.js, which throws only the first error, an error of theirs
 * counts only once everything before their branch resolved: one before it
 * belongs to that earlier item, and never also throws inside the slot.
 *
 * The route's errors never wait on the outlet branch, whose resolvers may
 * never settle. A route item after it counts its resolver's error in place
 * until the resolver reads `parent`; what is only known after `parent`, a
 * failed merge or an error after reading it, is deferred until every route
 * error in place is known.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts
 */
function walkAppPageHead<TModule extends AppPageHeadModule, TResolved, TValue>(
  kind: AppPageHeadKind<TResolved, TValue>,
  route: AppPageHeadBranch<TModule>,
  slots: readonly AppPageHeadBranch<TModule>[],
  hiddenBranches: readonly AppPageHeadHiddenBranch<TModule>[],
  outletIndex: number,
): AppPageHeadWalk<TResolved, TValue> {
  const errors: AppPageHeadWalk<TResolved, TValue>["errors"] = [];
  const deferredErrors: Promise<null>[] = [];
  let resolved: Promise<TResolved> = Promise.resolve(kind.initial);
  // The branch parent the slot's items' errors wait for, or null for the route's.
  let slotBranchParent: Promise<TResolved> | null = null;
  // Whether the shown chain has passed an item of the outlet branch.
  let afterOutlet = false;
  // Next.js's last two items, the last branch's page and its segment, never
  // set the title template (`i < metadataItems.length - 2`), so that page's
  // title gets the template from before a layout beside it.
  const lastBranch = slots.at(-1) ?? route;
  const lastPage = lastBranch.segments.at(-1)?.page ? lastBranch.segments.at(-1) : undefined;
  const lastPageLayout = lastPage && lastBranch.segments.at(-2);
  let beforeLastPageLayout: Promise<TResolved> | undefined;
  const start = (
    segment: AppPageHeadSegment<TModule>,
    parent: Promise<TResolved>,
    stashed?: Promise<TResolved>,
  ) => {
    const item = startAppPageHeadItem(
      kind,
      segment,
      parent,
      !slotBranchParent && afterOutlet,
      stashed,
    );
    if (item.deferredError) deferredErrors.push(item.deferredError);
    if (slotBranchParent) {
      const error = slotBranchParent.then(
        () => item.error,
        () => null,
      );
      void error.catch(() => null);
      errors.push({ error, owner: "slot" });
    } else {
      errors.push({ error: item.error, owner: "route" });
    }
    return item;
  };
  const startShown = (segment: AppPageHeadSegment<TModule>) => {
    if (segment === lastPageLayout && segment.besidePage) beforeLastPageLayout = resolved;
    const item = start(segment, resolved, segment === lastPage ? beforeLastPageLayout : undefined);
    resolved = item.resolved;
    return item.result;
  };
  const startHidden = (parallelRouteIndex: number, sharedLayoutCount: number) => {
    for (const hidden of hiddenBranches) {
      if (
        hidden.parallelRouteIndex !== parallelRouteIndex ||
        hidden.sharedLayoutCount !== sharedLayoutCount
      ) {
        continue;
      }
      const shownBranchParent = slotBranchParent;
      slotBranchParent = resolved;
      let parent = resolved;
      for (const segment of hidden.segments) parent = start(segment, parent).resolved;
      slotBranchParent = shownBranchParent;
    }
  };

  const routeResults = route.segments.map(startShown);
  const slotResults = slots.map((slot, index) => {
    slotBranchParent = index === outletIndex ? resolved : null;
    let layoutCount = 0;
    const results = slot.segments.map((segment) => {
      startHidden(index, layoutCount);
      if (!segment.page) layoutCount++;
      return startShown(segment);
    });
    if (!slot.segments.at(-1)?.page) startHidden(index, layoutCount);
    slotBranchParent = null;
    if (index === outletIndex && results.length > 0) afterOutlet = true;
    return results;
  });
  startHidden(-1, 0);

  return { deferredErrors, errors, resolved, route: routeResults, slots: slotResults };
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
        entries.length > 0 ? mergeParentMetadataEntries(entries) : {},
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
  const parallelRoutes = options.parallelRoutes ?? [];
  const route = createRouteHeadBranch(
    layoutInputs,
    routeSegments,
    options.params,
    options.pageModule,
  );
  const slots = parallelRoutes.map((parallelRoute) =>
    createParallelRouteHeadBranch(parallelRoute, options.params, routeSegments),
  );
  const hiddenBranches = (options.hiddenParallelRoutes ?? []).map((hidden) =>
    createHiddenHeadBranch(hidden, slots[hidden.parallelRouteIndex], options.params, routeSegments),
  );
  const outletIndex =
    options.outletParallelRouteIndex != null && options.outletParallelRouteIndex in slots
      ? options.outletParallelRouteIndex
      : -1;
  const segmentSearchParams = (segment: AppPageHeadSegment<AppPageHeadModule>) =>
    segment.page ? pageSearchParams : undefined;
  const segmentSearchParamsObserver = (segment: AppPageHeadSegment<AppPageHeadModule>) =>
    segment.page ? options.searchParamsObserver : undefined;
  const metadataWalk = walkAppPageHead<TModule, Metadata, Metadata>(
    {
      initial: {},
      merge: (resolved, metadata, stashed) => {
        try {
          // `stashed` is everything resolved up to the last item that may set
          // the title templates. Merged after it as a page entry, `resolved`
          // keeps its values but hands `metadata` the templates of `stashed`,
          // even for a value it cleared, such as `openGraph: null`.
          return mergeParentMetadataEntries(
            resolved === stashed
              ? [{ metadata: resolved }, { metadata }]
              : [{ metadata: stashed }, { isPage: true, metadata: resolved }, { metadata }],
          );
        } catch (error) {
          throw tagAppPageMetadataError(error);
        }
      },
      resolve: (segment, parent) =>
        resolveModuleMetadata(
          segment.moduleRoute,
          segment.module,
          segment.params,
          segmentSearchParams(segment),
          parent,
          segmentSearchParamsObserver(segment),
        ),
    },
    route,
    slots,
    hiddenBranches,
    outletIndex,
  );
  const viewportWalk = walkAppPageHead<TModule, ResolvedViewport, Viewport>(
    {
      initial: mergeViewport([]),
      merge: (resolved, viewport) => mergeViewport([resolved, viewport]),
      resolve: (segment, parent) =>
        resolveModuleViewport(
          segment.module,
          segment.params,
          segmentSearchParams(segment),
          parent,
          segmentSearchParamsObserver(segment),
        ),
    },
    route,
    slots,
    hiddenBranches,
    outletIndex,
  );
  const hasDynamicMetadata = hasAppPageDynamicMetadata(options);

  const metadata = metadataWalk.resolved.then(async (accumulated) => {
    const [routeResults, slotResults] = await Promise.all([
      Promise.all(metadataWalk.route),
      Promise.all(metadataWalk.slots.map((results) => Promise.all(results))),
    ]);
    const layoutMetadataResults = routeResults.slice(0, layoutInputs.length);
    const pageMetadata = options.pageModule ? (routeResults[layoutInputs.length] ?? null) : null;

    // The walk merged every shown item once, in loader-tree order, and
    // Turbopack (Next.js 16's default bundler) always puts `children` before
    // the named slots, so a slot page's title, like every other field,
    // overrides the page's. Webpack builds can order slots first; vinext
    // follows Turbopack.
    //
    // Next.js's accumulateMetadata lets every loader-tree item but the last two
    // set the title template (`i < metadataItems.length - 2`). Each slot adds at
    // least two items, its directory and its page or default, so with a slot
    // after it a page's template wraps later titles: the route's page's, and
    // every slot page's but the last slot's. The last branch's page and a
    // layout beside it are the last two, which the walk handles.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/metadata/resolve-metadata.ts (accumulateMetadata)
    // https://github.com/vercel/next.js/blob/canary/crates/next-core/src/app_structure.rs
    const hasMetadata = [...routeResults, ...slotResults.flat()].some(isPresent);
    const metadataSources = createMetadataSources(
      layoutMetadataResults,
      routeSegments,
      layoutSourcePositions,
      pageMetadata,
      Boolean(options.pageModule),
    );
    // Each slot's sources are scoped to its own branch, because the route tree
    // input does not carry per-layout segment positions inside it.
    metadataSources.push(
      ...slotResults.flatMap((results, index) =>
        results.map((entry) => ({ metadata: entry, routeSegments: slots[index].routeSegments })),
      ),
    );
    return finalizeAppPageMetadata(
      hasMetadata ? toShownMetadata(accumulated) : null,
      metadataSources,
      options,
    );
  });
  const viewport = viewportWalk.resolved;

  // Both branches begin eagerly. If a caller observes one rejection first,
  // keep the sibling branch from becoming an unhandled rejection while the
  // request switches to its error response.
  void metadata.catch(() => null);
  void viewport.catch(() => null);
  // The head's own failures once every item merged, such as file-based
  // metadata's. Next.js throws them from its single MetadataOutlet, in the
  // page that heads the route: the outlet branch's when there is one.
  const metadataHeadError = metadataWalk.resolved.then(
    () => metadata.then(() => null),
    () => null,
  );
  const headErrorOwner: AppPageHeadOwner = outletIndex === -1 ? "route" : "slot";
  // Each owner's items' own errors in loader-tree order, a hidden branch's in
  // its slot's place, then the route's deferred ones. Like Next.js's
  // MetadataOutlet, the first of metadata's and viewport's errors to settle
  // fails the outlet.
  const errorsOf = (owner: AppPageHeadOwner) => {
    const walkErrors = (walk: AppPageHeadWalk<unknown, unknown>, headErrors: Promise<null>[]) =>
      allInOrder([
        ...walk.errors.flatMap((item) => (item.owner === owner ? [item.error] : [])),
        ...headErrors,
      ]).then(() => (owner === "route" ? allInOrder(walk.deferredErrors) : null));
    return Promise.all([
      walkErrors(metadataWalk, headErrorOwner === owner ? [metadataHeadError] : []),
      walkErrors(viewportWalk, []),
    ]).then(() => null);
  };
  const hiddenErrors = errorsOf("slot");
  void hiddenErrors.catch(() => null);
  // The route's errors never wait on the outlet branch's resolvers, whose
  // generateMetadata() or generateViewport() may never settle, and leave out
  // an error a later slot took from it through `parent`.
  const routeErrors = errorsOf("route");
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
