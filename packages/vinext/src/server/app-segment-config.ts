import type { FetchCacheMode } from "vinext/shims/fetch-cache";
import { APP_PAGE_INTERCEPTION_MARKER_TRAVERSALS } from "./app-page-interception-markers.js";
import { isEdgeApiRuntime } from "./edge-api-runtime.js";
import { getAppPageSegmentParamName } from "./app-page-params.js";

type AppRouteSegmentDynamic = "auto" | "error" | "force-dynamic" | "force-static";

type AppRouteSegmentConfigModule = {
  dynamic?: unknown;
  dynamicParams?: unknown;
  fetchCache?: unknown;
  generateStaticParams?: unknown;
  revalidate?: unknown;
  runtime?: unknown;
  unstable_dynamicStaleTime?: unknown;
};

type EffectiveAppPageSegmentConfig = {
  dynamicConfig?: AppRouteSegmentDynamic;
  dynamicParamsConfig?: boolean;
  dynamicStaleTimeSeconds?: number;
  fetchCache?: FetchCacheMode;
  revalidateSeconds: number | null;
  runtime?: "edge" | "experimental-edge" | "nodejs";
};

type ParallelAppPageSegmentConfigBranch = {
  configLayouts?: readonly (AppRouteSegmentConfigModule | null | undefined)[] | null;
  configLayoutTreePositions?: readonly number[] | null;
  /**
   * The slot's `default` module, which replaces an active slot page when a
   * sibling branch intercepts.
   */
  default?: AppRouteSegmentConfigModule | null;
  /** Whether the slot renders its `default` module instead of a matched page. */
  isDefault?: boolean;
  layout?: AppRouteSegmentConfigModule | null;
  /** The slot's name, which orders sibling slots in the loader tree. */
  name?: string;
  /** The main-tree position of the folder that owns the slot. */
  ownerTreePosition?: number | null;
  page?: AppRouteSegmentConfigModule | null;
  routeSegments?: readonly string[] | null;
};

/**
 * The route's implicit `children` slot. A route that only a nested slot page
 * materializes renders the owner's `default` (or nothing) as its children.
 */
type AppPageChildrenSlot = {
  ownerTreePath: string;
  state: "active" | "default" | "unmatched";
};

type ResolveAppPageSegmentConfigOptions = {
  layouts?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  layoutTreePositions?: readonly number[];
  page?: AppRouteSegmentConfigModule | null;
  parallelBranches?: readonly (ParallelAppPageSegmentConfigBranch | null | undefined)[];
  parallelPages?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  parallelSegments?: readonly (AppRouteSegmentConfigModule | null | undefined)[];
  routeSegments?: readonly string[];
};

const DYNAMIC_VALUES = new Set<unknown>(["auto", "error", "force-dynamic", "force-static"]);
const FETCH_CACHE_VALUES = new Set<unknown>([
  "auto",
  "default-cache",
  "default-no-store",
  "force-cache",
  "force-no-store",
  "only-cache",
  "only-no-store",
]);

function isRouteSegmentDynamic(value: unknown): value is AppRouteSegmentDynamic {
  return DYNAMIC_VALUES.has(value);
}

function isRouteSegmentFetchCache(value: unknown): value is FetchCacheMode {
  return FETCH_CACHE_VALUES.has(value);
}

function isRouteSegmentRuntime(value: unknown): value is EffectiveAppPageSegmentConfig["runtime"] {
  return value === "edge" || value === "experimental-edge" || value === "nodejs";
}

function resolveRevalidateSeconds(current: number | null, value: unknown): number | null {
  // revalidate = false means "cache indefinitely" in Next.js segment config.
  // Represent it as Infinity so downstream code can distinguish "never
  // revalidate" (Infinity) from "no config / unset" (null).
  if (value === false) {
    if (current === null) return Infinity;
    // Shortest-wins: any finite interval is shorter than Infinity.
    return current === Infinity ? Infinity : current;
  }

  if (typeof value !== "number") {
    return current;
  }

  if (current === null) {
    return value;
  }

  return value < current ? value : current;
}

function resolveDynamicStaleTimeSeconds(
  current: number | undefined,
  value: unknown,
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return current;
  }

  return current === undefined ? value : Math.min(current, value);
}

function isDynamicSegment(segment: string): boolean {
  // An intercepting folder keeps its marker: `(.)[photo]` is the `photo` param.
  // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/get-segment-param.tsx
  const marker = APP_PAGE_INTERCEPTION_MARKER_TRAVERSALS.find(({ prefix }) =>
    segment.startsWith(prefix),
  );
  const name = marker ? segment.slice(marker.prefix.length) : segment;
  return name.startsWith("[") && name.endsWith("]");
}

function resolveSegmentConfigOwnerPosition(
  routeSegments: readonly string[],
  treePosition: number,
): number {
  let ownerPosition = Math.min(treePosition - 1, routeSegments.length - 1);
  while (ownerPosition >= 0) {
    const segment = routeSegments[ownerPosition];
    if (!segment.startsWith("@") && !(segment.startsWith("(") && segment.endsWith(")"))) {
      break;
    }
    ownerPosition -= 1;
  }
  return ownerPosition;
}

function getParallelSegments(
  options: ResolveAppPageSegmentConfigOptions,
): readonly (AppRouteSegmentConfigModule | null | undefined)[] {
  if (!options.parallelBranches) return options.parallelSegments ?? [];
  return options.parallelBranches.flatMap((branch) =>
    branch ? [branch.layout, ...(branch.configLayouts ?? []), branch.page] : [],
  );
}

/** Resolve the effective `dynamic` mode using the same traversal semantics as rendering. */
export function resolveAppPageDynamicConfig(
  options: Pick<
    ResolveAppPageSegmentConfigOptions,
    "layouts" | "page" | "parallelBranches" | "parallelSegments"
  >,
): AppRouteSegmentDynamic | undefined {
  const segments = [...(options.layouts ?? []), options.page];
  const parallelSegments = getParallelSegments(options);
  let dynamicConfig: AppRouteSegmentDynamic | undefined;
  let hasForceDynamic = false;

  for (const segment of segments) {
    if (!isRouteSegmentDynamic(segment?.dynamic)) continue;
    if (segment.dynamic === "force-dynamic") hasForceDynamic = true;
    dynamicConfig = hasForceDynamic ? "force-dynamic" : segment.dynamic;
  }

  for (const segment of parallelSegments) {
    if (segment?.dynamic === "force-dynamic") {
      hasForceDynamic = true;
      dynamicConfig = "force-dynamic";
    } else if (dynamicConfig === undefined && isRouteSegmentDynamic(segment?.dynamic)) {
      dynamicConfig = segment.dynamic;
    }
  }

  return dynamicConfig;
}

function resolveDynamicParamsConfig(
  options: ResolveAppPageSegmentConfigOptions,
): boolean | undefined {
  const parallelSegments = getParallelSegments(options);
  const segments = [...(options.layouts ?? []), options.page, ...parallelSegments];
  let dynamicParamsConfig: boolean | undefined;

  for (const segment of segments) {
    if (segment?.dynamicParams === false) {
      dynamicParamsConfig = false;
    } else if (segment?.dynamicParams === true && dynamicParamsConfig !== false) {
      dynamicParamsConfig = true;
    }
  }

  if (dynamicParamsConfig !== false || !options.routeSegments) {
    return dynamicParamsConfig;
  }

  const routeSegments = options.routeSegments;
  let lastDynamicPosition = -1;
  for (let index = routeSegments.length - 1; index >= 0; index--) {
    if (isDynamicSegment(routeSegments[index])) {
      lastDynamicPosition = index;
      break;
    }
  }
  if (lastDynamicPosition < 0) return dynamicParamsConfig;

  const layouts = options.layouts ?? [];
  const layoutPositions = options.layoutTreePositions ?? [];
  let lastDynamicSegmentIsStaticOnly = false;
  let lastDynamicSegmentHasStaticParams = false;

  layouts.forEach((layout, index) => {
    const ownerPosition = resolveSegmentConfigOwnerPosition(
      routeSegments,
      layoutPositions[index] ?? 0,
    );
    if (ownerPosition !== lastDynamicPosition) return;
    if (layout?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
    if (typeof layout?.generateStaticParams === "function") {
      lastDynamicSegmentHasStaticParams = true;
    }
  });

  if (options.page?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
  if (typeof options.page?.generateStaticParams === "function") {
    lastDynamicSegmentHasStaticParams = true;
  }

  for (const branch of options.parallelBranches ?? []) {
    if (!branch) continue;
    const branchStartPosition = routeSegments.length - (branch.routeSegments?.length ?? 0);
    const checkSegment = (
      segment: AppRouteSegmentConfigModule | null | undefined,
      ownerPosition: number,
    ) => {
      if (ownerPosition !== lastDynamicPosition) return;
      if (segment?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
      if (typeof segment?.generateStaticParams === "function") {
        lastDynamicSegmentHasStaticParams = true;
      }
    };

    checkSegment(branch.layout, branchStartPosition - 1);
    branch.configLayouts?.forEach((layout, index) => {
      checkSegment(
        layout,
        branchStartPosition + (branch.configLayoutTreePositions?.[index] ?? 0) - 1,
      );
    });
    checkSegment(branch.page, branchStartPosition + (branch.routeSegments?.length ?? 0) - 1);
  }

  if (!options.parallelBranches) {
    for (const segment of parallelSegments) {
      if (segment?.dynamicParams === false) lastDynamicSegmentIsStaticOnly = true;
      if (typeof segment?.generateStaticParams === "function") {
        lastDynamicSegmentHasStaticParams = true;
      }
    }
  }

  return lastDynamicSegmentIsStaticOnly || lastDynamicSegmentHasStaticParams ? false : undefined;
}

function isCacheFetchCacheMode(value: FetchCacheMode): boolean {
  return value === "default-cache" || value === "force-cache" || value === "only-cache";
}

function describeFetchCacheConflict(value: FetchCacheMode): string {
  return `Route segment config has incompatible fetchCache values including "${value}".`;
}

/**
 * Resolve the route segment config that applies to an App page route.
 *
 * Next.js collects config from every segment in the loader tree and reduces it
 * into the effective route config. The generated vinext entry already knows
 * the concrete layout/page modules for a route, so it should only describe
 * those modules and delegate the behavior to this helper.
 */
export function resolveAppPageSegmentConfig(
  options: ResolveAppPageSegmentConfigOptions,
): EffectiveAppPageSegmentConfig {
  return applyAppPageFetchCacheDefault(reduceAppPageSegmentConfig(options));
}

function reduceAppPageSegmentConfig(
  options: ResolveAppPageSegmentConfigOptions,
): EffectiveAppPageSegmentConfig {
  const segments = [...(options.layouts ?? []), options.page];
  const parallelSegments = getParallelSegments(options);
  // Reduction strategies differ by field:
  // - dynamic: child segments override parents.
  // - dynamicParams: false is sticky across the route tree.
  // - fetchCache: force/only modes take route-level precedence and reject conflicts.
  // - revalidate: the shortest numeric interval wins.
  const dynamicConfig = resolveAppPageDynamicConfig(options);
  const config: EffectiveAppPageSegmentConfig = {
    ...(dynamicConfig === undefined ? {} : { dynamicConfig }),
    revalidateSeconds: null,
  };
  config.dynamicParamsConfig = resolveDynamicParamsConfig(options);
  let hasForceCache = false;
  let hasForceNoStore = false;
  let hasOnlyCache = false;
  let hasOnlyNoStore = false;
  let hasParentDefaultNoStore = false;

  const primaryRuntime = resolveAppPageStaticGenerationRuntime(
    segments.map((segment) => segment?.runtime),
  );
  if (primaryRuntime !== undefined) config.runtime = primaryRuntime;

  for (const segment of segments) {
    if (!segment) continue;

    if (isRouteSegmentFetchCache(segment.fetchCache)) {
      const fetchCache = segment.fetchCache;

      if (hasParentDefaultNoStore && (fetchCache === "auto" || isCacheFetchCacheMode(fetchCache))) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }

      if (fetchCache === "force-cache") hasForceCache = true;
      if (fetchCache === "force-no-store") hasForceNoStore = true;
      if (fetchCache === "only-cache") hasOnlyCache = true;
      if (fetchCache === "only-no-store") hasOnlyNoStore = true;

      const hasConflictingForces = hasForceCache && hasForceNoStore;
      const hasConflictingOnlyModes =
        !hasForceCache && !hasForceNoStore && hasOnlyCache && hasOnlyNoStore;
      if (hasConflictingForces || hasConflictingOnlyModes) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }

      if (fetchCache === "default-no-store") {
        hasParentDefaultNoStore = true;
      }

      if (hasForceCache) {
        config.fetchCache = "force-cache";
      } else if (hasForceNoStore) {
        config.fetchCache = "force-no-store";
      } else if (hasOnlyCache) {
        config.fetchCache = "only-cache";
      } else if (hasOnlyNoStore) {
        config.fetchCache = "only-no-store";
      } else {
        config.fetchCache = fetchCache;
      }
    }

    config.revalidateSeconds = resolveRevalidateSeconds(
      config.revalidateSeconds,
      segment.revalidate,
    );
  }

  for (const segment of parallelSegments) {
    if (!segment) continue;

    // Next.js traverses every parallel branch. Vinext's flattened route graph
    // does not preserve the exact breadth-first overwrite order, so primary
    // chain values remain authoritative when present. Slot-only values still
    // define the route, while sticky route-wide constraints aggregate across
    // every active branch.
    if (config.runtime === undefined && isRouteSegmentRuntime(segment.runtime)) {
      config.runtime = segment.runtime;
    }

    if (isRouteSegmentFetchCache(segment.fetchCache)) {
      const fetchCache = segment.fetchCache;
      if (hasParentDefaultNoStore && (fetchCache === "auto" || isCacheFetchCacheMode(fetchCache))) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }
      if (fetchCache === "force-cache") hasForceCache = true;
      if (fetchCache === "force-no-store") hasForceNoStore = true;
      if (fetchCache === "only-cache") hasOnlyCache = true;
      if (fetchCache === "only-no-store") hasOnlyNoStore = true;
      const hasConflictingForces = hasForceCache && hasForceNoStore;
      const hasConflictingOnlyModes =
        !hasForceCache && !hasForceNoStore && hasOnlyCache && hasOnlyNoStore;
      if (hasConflictingForces || hasConflictingOnlyModes) {
        throw new Error(describeFetchCacheConflict(fetchCache));
      }
      if (fetchCache === "default-no-store") {
        hasParentDefaultNoStore = true;
      }
      if (hasForceCache) config.fetchCache = "force-cache";
      else if (hasForceNoStore) config.fetchCache = "force-no-store";
      else if (hasOnlyCache) config.fetchCache = "only-cache";
      else if (hasOnlyNoStore) config.fetchCache = "only-no-store";
      else if (config.fetchCache === undefined) config.fetchCache = fetchCache;
    }

    config.revalidateSeconds = resolveRevalidateSeconds(
      config.revalidateSeconds,
      segment.revalidate,
    );
  }

  for (const segment of [options.page, ...(options.parallelPages ?? [])]) {
    if (!segment) continue;
    config.dynamicStaleTimeSeconds = resolveDynamicStaleTimeSeconds(
      config.dynamicStaleTimeSeconds,
      segment.unstable_dynamicStaleTime,
    );
  }

  if (config.dynamicConfig === "force-dynamic") {
    config.revalidateSeconds = 0;
  }

  return config;
}

function applyAppPageFetchCacheDefault(
  config: EffectiveAppPageSegmentConfig,
): EffectiveAppPageSegmentConfig {
  // Static-only dynamic modes supply fetchCache defaults unless a segment does.
  // `dynamic = "force-dynamic"` is handled at the fetch decision layer: it
  // defaults no-config fetches to no-store but must not override explicit
  // per-fetch cache/revalidate options.
  if (config.fetchCache === undefined) {
    if (config.dynamicConfig === "error") {
      config.fetchCache = "only-cache";
    }
  }

  return config;
}

export function resolveAppPageFetchCacheMode(
  options: ResolveAppPageSegmentConfigOptions,
): FetchCacheMode | null {
  return resolveAppPageSegmentConfig(options).fetchCache ?? null;
}

/**
 * Resolve the `fetchCache` segment config exported by a route handler module.
 *
 * Route handlers have no layout chain, so the module's own export applies
 * directly. Mirrors upstream's app-route module, which copies
 * `userland.fetchCache` into the work store before invoking the handler.
 */
export function resolveAppRouteHandlerFetchCacheMode(
  handler: Pick<AppRouteSegmentConfigModule, "fetchCache">,
): FetchCacheMode | null {
  return isRouteSegmentFetchCache(handler.fetchCache) ? handler.fetchCache : null;
}

export function isEdgeRuntime(runtime: string | undefined): boolean {
  return isEdgeApiRuntime(runtime);
}

/**
 * Resolve a `runtime` from a chain of segment values, outermost first: the
 * last valid value wins, as a child's value wins over its parent's.
 * `collectAppPageStaticGenerationRuntimes` supplies the value Next.js uses to
 * decide whether a page can be statically generated.
 */
export function resolveAppPageStaticGenerationRuntime(
  values: readonly unknown[],
): EffectiveAppPageSegmentConfig["runtime"] {
  let runtime: EffectiveAppPageSegmentConfig["runtime"];
  for (const value of values) {
    if (isRouteSegmentRuntime(value)) runtime = value;
  }
  return runtime;
}

/**
 * Where the children slot renders its `default` instead of a page: the
 * main-tree position of the folder that owns it. `null` when children renders
 * a page.
 */
function resolveChildrenDefaultTreePosition(
  childrenSlot: AppPageChildrenSlot | null | undefined,
): number | null {
  if (!childrenSlot || childrenSlot.state === "active") return null;
  return treePathDepth(childrenSlot.ownerTreePath);
}

function treePathDepth(treePath: string): number {
  return treePath.split("/").filter(Boolean).length;
}

/**
 * The `runtime` Next.js's default build (Turbopack) derives for an App page,
 * for `resolveAppPageStaticGenerationRuntime`. It reads the whole loader tree:
 * at each node the values of every parallel branch (children, matched slots
 * and slots that render `default`) merge, and a conflict fails the build; the
 * node's own layout, page or default module then fills in only an unset value.
 * So an edge slot page next to a Node children page makes the route edge.
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/segment_config.rs#L1323-L1357
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/next_app/app_page_entry.rs#L40-L41
 */
export function collectAppPageStaticGenerationRuntimes(
  options: Parameters<typeof collectAppPageStaticParamsWalkSegments>[0],
): unknown[] {
  const segments = collectAppPageStaticParamsWalkSegments(options);
  const isAt = (segment: AppPageStaticParamsWalkSegment, treePath: readonly number[]) =>
    segment.treePath.length === treePath.length &&
    treePath.every((index, depth) => segment.treePath[depth] === index);
  const resolveAt = (treePath: readonly number[]): EffectiveAppPageSegmentConfig["runtime"] => {
    let runtime: EffectiveAppPageSegmentConfig["runtime"];
    for (const segment of segments) {
      if (
        segment.treePath.length === treePath.length + 1 &&
        treePath.every((index, depth) => segment.treePath[depth] === index)
      ) {
        runtime = mergeParallelRuntime(runtime, resolveAt(segment.treePath));
      }
    }
    if (runtime !== undefined) return runtime;
    const own = segments.find((segment) => isAt(segment, treePath));
    const segmentModule = own?.identity[1] as AppRouteSegmentConfigModule | null | undefined;
    return resolveAppPageStaticGenerationRuntime([segmentModule?.runtime]);
  };
  return [resolveAt([])];
}

/**
 * Merge a parallel branch's runtime into its siblings'. Next.js fails the
 * build when two siblings set different values; the edge one is kept here,
 * since it keeps the route out of static generation either way.
 */
function mergeParallelRuntime(
  current: EffectiveAppPageSegmentConfig["runtime"],
  sibling: EffectiveAppPageSegmentConfig["runtime"],
): EffectiveAppPageSegmentConfig["runtime"] {
  if (current === undefined) return sibling;
  if (sibling === undefined || current === sibling) return current;
  return isEdgeRuntime(current) ? current : sibling;
}

/**
 * The modules and shape of an App page's loader tree, as the static
 * generation helpers read it.
 */
export type AppPageSegmentConfigTree = Pick<
  ResolveAppPageSegmentConfigOptions,
  "layoutTreePositions" | "layouts" | "page" | "parallelBranches" | "routeSegments"
> & { childrenSlot?: AppPageChildrenSlot | null };

type AppPageInterceptAttachment = AppPageSegmentConfigTree & {
  /** Whether the intercept replaces the source's page rather than a slot. */
  isSiblingPageIntercept: boolean;
  /** Index of the intercepted slot's branch in `parallelBranches`, or -1. */
  slotIndex: number;
};

function resolveAppPageInterceptedSlot(
  options: AppPageInterceptAttachment,
): ParallelAppPageSegmentConfigBranch | null {
  return options.slotIndex === -1 ? null : (options.parallelBranches?.[options.slotIndex] ?? null);
}

/**
 * Whether an attached intercept's branch adds a dynamic segment to the source
 * route's tree, whose params the intercepting tree then renders.
 */
export function hasAppPageInterceptDynamicSegment(
  interceptBranchSegments: readonly string[] | null | undefined,
): boolean {
  return (interceptBranchSegments ?? []).some(
    (segment) => getAppPageSegmentParamName(segment) !== null,
  );
}

/**
 * Whether an intercepting route is dynamic. Next.js's `isDynamicRoute`
 * classifies an intercepting app path by the route it intercepts, built from
 * its folders (`interceptTargetPatternParts`), not by its source route's
 * segments.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/is-dynamic.ts
 */
export function isAppPageInterceptTargetDynamic(
  interceptTargetPatternParts: readonly string[] | null | undefined,
): boolean {
  return (interceptTargetPatternParts ?? []).some((part) => part.startsWith(":"));
}

/**
 * Whether an intercept puts its branch into the source route's tree. A
 * sibling-page intercept always replaces the source's page; a slot intercept
 * needs the source to have the intercepted slot, and otherwise the source
 * renders unchanged (see `resolveAppPageInterceptTree`).
 */
export function isAppPageInterceptAttached(options: AppPageInterceptAttachment): boolean {
  return options.isSiblingPageIntercept || resolveAppPageInterceptedSlot(options) !== null;
}

/**
 * A direct intercepted RSC response renders the source route with the
 * intercepting branch in place of what it intercepts. Next.js serves it from
 * the intercepting route, an app path of its own whose loader tree holds the
 * source's layouts and that branch, and classifies that tree.
 *
 * - A slot intercept replaces the intercepted slot's branch, which holds the
 *   layouts of the slot's folders above the marker, then those at and below
 *   it. The children of the slot's folder are replaced too, by the folder's
 *   `default` module (or the built-in `default-null`) as a `__DEFAULT__`
 *   leaf, which drops the source's page and every folder below. vinext still
 *   renders the source's page, so `keepActiveSiblings` keeps it.
 * - A slot intercept whose slot the source route doesn't have renders nothing
 *   in its place: vinext renders the source route unchanged, so its tree stays.
 * - A sibling-page intercept replaces the source's page: its folders, layouts
 *   and page continue the main tree below the source page's folder.
 * - At each folder on the intercepting branch's path, every other slot is
 *   replaced by its `default` module alone, as a `__DEFAULT__` leaf without
 *   the slot's layouts. vinext still renders those slots' active pages, so
 *   `keepActiveSiblings` resolves the tree it renders instead.
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L1270-L1290
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L1414-L1473
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L1515-L1548
 */
export function resolveAppPageInterceptTree(
  options: AppPageInterceptAttachment & {
    interceptBranchSegments?: readonly string[] | null;
    interceptLayoutSegments?: readonly (readonly string[])[] | null;
    interceptLayouts?: readonly (AppRouteSegmentConfigModule | null | undefined)[] | null;
    /**
     * The `default` module of the folder that owns an intercepted slot, which
     * replaces that folder's children in the intercepting route's tree.
     */
    interceptOwnerDefault?: AppRouteSegmentConfigModule | null;
    interceptPage?: AppRouteSegmentConfigModule | null;
    /**
     * Whether other slots, and a slot intercept's children, keep the branches
     * vinext renders, not their defaults.
     */
    keepActiveSiblings?: boolean;
  },
): AppPageSegmentConfigTree {
  const interceptLayouts = options.interceptLayouts ?? [];
  const interceptLayoutDepths = interceptLayouts.map(
    (_, index) => options.interceptLayoutSegments?.[index]?.length ?? 0,
  );
  const tree: AppPageSegmentConfigTree = {
    childrenSlot: options.childrenSlot,
    layoutTreePositions: options.layoutTreePositions,
    layouts: options.layouts,
    page: options.page,
    parallelBranches: options.parallelBranches,
    routeSegments: options.routeSegments,
  };
  const sourceDepth = options.routeSegments?.length ?? 0;
  // Next.js swaps each non-intercepting sibling at or above the intercept's
  // folder for its default. Slots owned deeper sit inside the children it
  // replaces, so they drop out with them.
  const replaceSiblingsWithDefaults = (interceptOwner: number, interceptIndex: number) =>
    (options.parallelBranches ?? []).map((branch, index) => {
      if (!branch || index === interceptIndex || options.keepActiveSiblings) return branch;
      const owner = resolveParallelBranchOwnerPosition(branch, sourceDepth);
      if (owner > interceptOwner) return null;
      return {
        configLayouts: [],
        configLayoutTreePositions: [],
        isDefault: true,
        layout: null,
        name: branch.name,
        ownerTreePosition: owner,
        page: branch.isDefault ? branch.page : (branch.default ?? null),
        routeSegments: [],
      };
    });
  if (!options.isSiblingPageIntercept) {
    const slot = resolveAppPageInterceptedSlot(options);
    if (!slot) return tree;
    const interceptOwner = resolveParallelBranchOwnerPosition(slot, sourceDepth);
    const parallelBranches = replaceSiblingsWithDefaults(interceptOwner, options.slotIndex);
    parallelBranches[options.slotIndex] = {
      configLayouts: interceptLayouts,
      configLayoutTreePositions: interceptLayoutDepths,
      isDefault: false,
      layout: slot.layout ?? null,
      name: slot.name,
      ownerTreePosition: slot.ownerTreePosition,
      page: options.interceptPage ?? null,
      routeSegments: options.interceptBranchSegments ?? [],
    };
    if (options.keepActiveSiblings) return { ...tree, parallelBranches };
    // Next.js's `keys_to_replace` covers `children` as well. Without a
    // `default` of its own, an interception path's children get the
    // built-in `default-null`, which exports no config.
    const ownerSegments = (options.routeSegments ?? []).slice(0, interceptOwner);
    const ownerLayouts = (options.layouts ?? []).flatMap((layout, index) => {
      const position = options.layoutTreePositions?.[index] ?? 0;
      return position > interceptOwner ? [] : [{ layout, position }];
    });
    return {
      childrenSlot: { ownerTreePath: `/${ownerSegments.join("/")}`, state: "default" },
      layoutTreePositions: ownerLayouts.map(({ position }) => position),
      layouts: ownerLayouts.map(({ layout }) => layout),
      page: options.interceptOwnerDefault ?? null,
      parallelBranches,
      routeSegments: ownerSegments,
    };
  }
  const routeSegments = options.routeSegments ?? [];
  const layouts = options.layouts ?? [];
  return {
    ...tree,
    childrenSlot: null,
    layoutTreePositions: [
      ...layouts.map((_, index) => options.layoutTreePositions?.[index] ?? 0),
      ...interceptLayoutDepths.map((depth) => routeSegments.length + depth),
    ],
    layouts: [...layouts, ...interceptLayouts],
    page: options.interceptPage ?? null,
    parallelBranches: replaceSiblingsWithDefaults(sourceDepth, -1),
    routeSegments: [...routeSegments, ...(options.interceptBranchSegments ?? [])],
  };
}

type AppPageSegmentConfigModules = Pick<
  ResolveAppPageSegmentConfigOptions,
  "layouts" | "page" | "parallelBranches"
>;

// A route-wide `fetchCache` mode of either tree applies to a direct
// intercepted response, in this order: a `force-*` mode overrides an `only-*`
// one, as within a tree, and the no-store mode wins a conflict between trees.
const ROUTE_WIDE_FETCH_CACHE_MODES: readonly FetchCacheMode[] = [
  "force-no-store",
  "force-cache",
  "only-no-store",
  "only-cache",
];

/**
 * The segment config a direct intercepted RSC response renders under.
 * Next.js takes it from the segments its intercepting route renders
 * (`interceptTree`, from `resolveAppPageInterceptTree`), but vinext also
 * renders the active pages that tree swaps for defaults (`renderedTree`, with
 * `keepActiveSiblings`). Each tree is reduced on its own, since a slot's
 * `default` and its active page never render together, and the two policies
 * merge: the shortest revalidate, a `force-dynamic`, a `dynamicParams = false`
 * and a route-wide `fetchCache` mode from either tree apply, and the
 * intercepting route's own tree keeps precedence for the rest. The shortest
 * `unstable_dynamicStaleTime` of either tree's pages (a slot's `default`
 * included, as Next.js reads it) applies too.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/app-render/create-component-tree.tsx
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/app-render/app-render.tsx
 */
export function resolveAppPageInterceptSegmentConfig(
  interceptTree: AppPageSegmentConfigModules,
  renderedTree: AppPageSegmentConfigModules,
): EffectiveAppPageSegmentConfig {
  // The `dynamic = "error"` fetchCache default applies once, to the merged
  // `dynamic` mode, not to either tree's.
  const [intercept, rendered] = [interceptTree, renderedTree].map((tree) =>
    reduceAppPageSegmentConfig({
      layouts: tree.layouts,
      page: tree.page,
      parallelBranches: tree.parallelBranches,
      parallelPages: (tree.parallelBranches ?? []).map((branch) => branch?.page),
    }),
  );
  const dynamicConfig =
    intercept.dynamicConfig === "force-dynamic" || rendered.dynamicConfig === "force-dynamic"
      ? "force-dynamic"
      : (intercept.dynamicConfig ?? rendered.dynamicConfig);
  const dynamicParamsConfig =
    intercept.dynamicParamsConfig === false || rendered.dynamicParamsConfig === false
      ? false
      : (intercept.dynamicParamsConfig ?? rendered.dynamicParamsConfig);
  const dynamicStaleTimeSeconds = resolveDynamicStaleTimeSeconds(
    intercept.dynamicStaleTimeSeconds,
    rendered.dynamicStaleTimeSeconds,
  );
  const fetchCache =
    ROUTE_WIDE_FETCH_CACHE_MODES.find(
      (mode) => intercept.fetchCache === mode || rendered.fetchCache === mode,
    ) ??
    intercept.fetchCache ??
    rendered.fetchCache;
  const runtime = intercept.runtime ?? rendered.runtime;
  return applyAppPageFetchCacheDefault({
    ...(dynamicConfig === undefined ? {} : { dynamicConfig }),
    ...(dynamicParamsConfig === undefined ? {} : { dynamicParamsConfig }),
    ...(dynamicStaleTimeSeconds === undefined ? {} : { dynamicStaleTimeSeconds }),
    ...(fetchCache === undefined ? {} : { fetchCache }),
    revalidateSeconds: resolveRevalidateSeconds(
      intercept.revalidateSeconds,
      rendered.revalidateSeconds,
    ),
    ...(runtime === undefined ? {} : { runtime }),
  });
}

/**
 * The main-tree position of the folder that owns a slot, for a route whose
 * main tree is `routeDepth` folders deep.
 */
function resolveParallelBranchOwnerPosition(
  branch: ParallelAppPageSegmentConfigBranch,
  routeDepth: number,
): number {
  return Math.min(
    branch.ownerTreePosition ??
      routeDepth - (branch.isDefault ? 0 : (branch.routeSegments ?? []).length),
    routeDepth,
  );
}

/**
 * One segment of an App page's loader tree, as Next.js's build visits it when
 * it classifies the route.
 */
export type AppPageStaticParamsWalkSegment = {
  /** Whether the segment is a dynamic URL segment (`[slug]`, `[...slug]`). */
  dynamic: boolean;
  /** Whether the segment's layout (or page) exports `generateStaticParams`. */
  generateStaticParams: boolean;
  /**
   * The segment name and the file that supplies its module. Next.js visits
   * each distinct pair once, so a slot's layout-less `[slug]` folder that
   * repeats the main tree's does not count twice.
   */
  identity: readonly [name: string, file: unknown];
  /**
   * The segment's position in the loader tree: its index among its parent's
   * children at each level, from the root. The root layout's segment is `[]`.
   */
  treePath: readonly number[];
};

function compareTreePaths(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * Whether `generateStaticParams` is exported at or below the route's last
 * dynamic segment: by that segment's layout, a deeper layout, or the page.
 * Next.js classifies such a route as SSG (static generation with an on-demand
 * fallback). A dynamic-segment route without it is dynamic (ƒ) and is never
 * full-page cached.
 *
 * Port of Next.js's `lastDynamicSegmentHadGenerateStaticParams` walk: segments
 * are visited breadth-first, a dynamic segment without `generateStaticParams`
 * clears the flag, and any segment with it sets the flag.
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/static-paths/app.ts#L926-L935
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/segment-config/app/app-segments.ts#L72-L126
 */
export function lastDynamicSegmentHasGenerateStaticParams(
  segments: readonly AppPageStaticParamsWalkSegment[],
): boolean {
  const visited: AppPageStaticParamsWalkSegment["identity"][] = [];
  const ordered = [...segments].sort((a, b) => compareTreePaths(a.treePath, b.treePath));
  let hasGenerateStaticParams = false;

  for (const segment of ordered) {
    const [name, file] = segment.identity;
    if (visited.some(([seenName, seenFile]) => seenName === name && seenFile === file)) continue;
    visited.push(segment.identity);

    if (segment.dynamic && !segment.generateStaticParams) {
      hasGenerateStaticParams = false;
    } else if (segment.generateStaticParams) {
      hasGenerateStaticParams = true;
    }
  }

  return hasGenerateStaticParams;
}

const PAGE_SEGMENT_NAME = "__PAGE__";

function hasGenerateStaticParamsExport(
  segment: AppRouteSegmentConfigModule | null | undefined,
): boolean {
  return typeof segment?.generateStaticParams === "function";
}

const DEFAULT_SEGMENT_NAME = "__DEFAULT__";

/**
 * Turbopack reads a folder's subfolders from a `BTreeMap<RcStr, _>`, whose
 * keys compare as Rust `str`s: by UTF-8 bytes. That is Unicode code point
 * order, which JavaScript's `<` (UTF-16 code units) doesn't match above the
 * Basic Multilingual Plane.
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L188-L192
 * https://github.com/vercel/next.js/blob/v16.2.7/turbopack/crates/turbo-rcstr/src/lib.rs#L350-L354
 */
function compareFolderNames(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

/**
 * Collect the loader-tree segments of an App page route from its layout, page
 * and parallel-slot modules, for `lastDynamicSegmentHasGenerateStaticParams`.
 *
 * Children follow the loader tree Next.js's default build (Turbopack) makes:
 * `children` first, then every slot in folder-name order, whether it matched
 * a page or renders `default`. A default slot is a single `__DEFAULT__`
 * segment without the slot's layout.
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L1489-L1511
 * https://github.com/vercel/next.js/blob/v16.2.7/crates/next-core/src/app_structure.rs#L1515-L1548
 */
export function collectAppPageStaticParamsWalkSegments(
  options: Pick<
    ResolveAppPageSegmentConfigOptions,
    "layoutTreePositions" | "layouts" | "page" | "parallelBranches" | "routeSegments"
  > & { childrenSlot?: AppPageChildrenSlot | null },
): AppPageStaticParamsWalkSegment[] {
  // When children renders the owner's `default`, the route's deeper URL
  // segments come from a slot, and the main tree ends at the owner with a
  // `__DEFAULT__` segment in the children position.
  const childrenDefaultPosition = resolveChildrenDefaultTreePosition(options.childrenSlot);
  const routeSegments =
    childrenDefaultPosition === null
      ? (options.routeSegments ?? [])
      : (options.routeSegments ?? []).slice(0, childrenDefaultPosition);
  const layoutsByPosition = new Map<number, AppRouteSegmentConfigModule>();
  options.layouts?.forEach((layout, index) => {
    if (layout) layoutsByPosition.set(options.layoutTreePositions?.[index] ?? 0, layout);
  });

  const branchesByOwner = new Map<number, ParallelAppPageSegmentConfigBranch[]>();
  for (const branch of options.parallelBranches ?? []) {
    if (!branch) continue;
    const owner = resolveParallelBranchOwnerPosition(branch, routeSegments.length);
    branchesByOwner.set(owner, [...(branchesByOwner.get(owner) ?? []), branch]);
  }

  const segments: AppPageStaticParamsWalkSegment[] = [];
  let treePath: number[] = [];
  // A folder's segment takes its module from the folder's layout. The page is
  // a child segment of the deepest folder.
  for (let position = 0; position <= routeSegments.length + 1; position++) {
    if (position <= routeSegments.length) {
      const name = position === 0 ? "" : routeSegments[position - 1];
      const layout = layoutsByPosition.get(position);
      segments.push({
        dynamic: position > 0 && isDynamicSegment(name),
        generateStaticParams: hasGenerateStaticParamsExport(layout),
        identity: [name, layout],
        treePath,
      });
    } else {
      segments.push({
        dynamic: false,
        generateStaticParams: hasGenerateStaticParamsExport(options.page),
        identity: [PAGE_SEGMENT_NAME, options.page ?? undefined],
        treePath,
      });
      break;
    }

    // `children` takes index 0; the slots follow it.
    const slots = [...(branchesByOwner.get(position) ?? [])].sort((a, b) =>
      compareFolderNames(a.name ?? "", b.name ?? ""),
    );
    slots.forEach((branch, index) => {
      const slotPath = [...treePath, index + 1];
      if (branch.isDefault) {
        segments.push({
          dynamic: false,
          generateStaticParams: hasGenerateStaticParamsExport(branch.page),
          identity: [DEFAULT_SEGMENT_NAME, branch.page ?? undefined],
          treePath: slotPath,
        });
      } else {
        segments.push(...collectActiveSlotSegments(branch, slotPath));
      }
    });
    if (position === childrenDefaultPosition) {
      segments.push({
        dynamic: false,
        generateStaticParams: hasGenerateStaticParamsExport(options.page),
        identity: [DEFAULT_SEGMENT_NAME, options.page ?? undefined],
        treePath: [...treePath, 0],
      });
      break;
    }
    treePath = [...treePath, 0];
  }

  return segments;
}

function collectActiveSlotSegments(
  branch: ParallelAppPageSegmentConfigBranch,
  slotPath: readonly number[],
): AppPageStaticParamsWalkSegment[] {
  const branchSegments = branch.routeSegments ?? [];
  const configLayoutsByPosition = new Map<number, AppRouteSegmentConfigModule>();
  branch.configLayouts?.forEach((layout, index) => {
    if (layout) configLayoutsByPosition.set(branch.configLayoutTreePositions?.[index] ?? 0, layout);
  });

  const segments: AppPageStaticParamsWalkSegment[] = [
    {
      dynamic: false,
      generateStaticParams: hasGenerateStaticParamsExport(branch.layout),
      identity: [`@${branch.name ?? ""}`, branch.layout ?? undefined],
      treePath: slotPath,
    },
  ];
  // Each folder inside the slot has one child: the next folder, then the page.
  // A slot's root page inside a route group has no segments, but the group's
  // layout still has a tree position.
  const depth = Math.max(branchSegments.length, ...(branch.configLayoutTreePositions ?? []));
  let treePath = [...slotPath];
  for (let index = 0; index < depth; index++) {
    treePath = [...treePath, 0];
    const name = branchSegments[index];
    const layout = configLayoutsByPosition.get(index + 1);
    segments.push({
      dynamic: name !== undefined && isDynamicSegment(name),
      generateStaticParams: hasGenerateStaticParamsExport(layout),
      identity: [name ?? "", layout],
      treePath,
    });
  }
  segments.push({
    dynamic: false,
    generateStaticParams: hasGenerateStaticParamsExport(branch.page),
    identity: [PAGE_SEGMENT_NAME, branch.page ?? undefined],
    treePath: [...treePath, 0],
  });
  return segments;
}

/**
 * Whether an App page route exports `generateStaticParams` at or below its last
 * dynamic segment, read from its layout, page and parallel-slot modules.
 */
export function hasAppPageGenerateStaticParamsAtLastDynamicSegment(
  options: Parameters<typeof collectAppPageStaticParamsWalkSegments>[0],
): boolean {
  return lastDynamicSegmentHasGenerateStaticParams(collectAppPageStaticParamsWalkSegments(options));
}

/**
 * Whether any segment of an App page route's loader tree exports
 * `generateStaticParams`, read from its layout, page and parallel-slot
 * modules. Next.js collects every segment of the route's own loader tree, its
 * parallel routes included, and calls each segment's generator.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/segment-config/app/app-segments.ts#L72-L126
 */
export function hasAppPageAnyGenerateStaticParams(
  options: Parameters<typeof collectAppPageStaticParamsWalkSegments>[0],
): boolean {
  return collectAppPageStaticParamsWalkSegments(options).some(
    (segment) => segment.generateStaticParams,
  );
}

/**
 * Whether Next.js would classify an App page route as static or SSG from its
 * config alone. Only such routes are full-page cache candidates; every other
 * route renders per request with real values and is never ISR-cached.
 *
 * - `runtime = "edge"` disables static generation, whatever else the route
 *   sets.
 * - `dynamic = "force-dynamic"` and `revalidate = 0` are dynamic.
 * - `dynamic = "force-static"` and `dynamic = "error"` are static.
 * - Otherwise a route is static when it has no dynamic segments, or when
 *   `generateStaticParams` sits at or below its last dynamic segment.
 *
 * Next.js also treats a route as SSG when an ancestor's `generateStaticParams`
 * returns every pathname param (`hadAllParamsGenerated`). That depends on the
 * generator's output, which vinext doesn't compute per request, so such a
 * route is treated as dynamic here. Adding `generateStaticParams` to the last
 * dynamic segment (even returning `[]`) opts it in, on both.
 *
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/index.ts#L2333-L2408
 */
export function isAppPageStaticEligible(options: {
  dynamicConfig?: string;
  hasGenerateStaticParams: boolean;
  isDynamicRoute: boolean;
  isStaticGenerationEdgeRuntime: boolean;
  revalidateSeconds: number | null;
}): boolean {
  if (options.isStaticGenerationEdgeRuntime) return false;
  if (options.dynamicConfig === "force-dynamic" || options.revalidateSeconds === 0) return false;
  if (options.dynamicConfig === "force-static" || options.dynamicConfig === "error") return true;
  return !options.isDynamicRoute || options.hasGenerateStaticParams;
}
