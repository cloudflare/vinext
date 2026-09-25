import type { FetchCacheMode } from "vinext/shims/fetch-cache";
import { isEdgeApiRuntime } from "./edge-api-runtime.js";

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
  return segment.startsWith("[") && segment.endsWith("]");
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
 * Resolve the `runtime` Next.js uses to decide whether a page can be statically
 * generated: the page's own value wins, then the nearest layout's. Parallel
 * slots do not take part. `values` lists the root layout first and the page
 * last, the order `getStaticInfoIncludingLayouts` reduces them in.
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/get-static-info-including-layouts.ts
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
  return childrenSlot.ownerTreePath.split("/").filter(Boolean).length;
}

/**
 * The `runtime` values of an App page's file and the layouts above it, root
 * first, for `resolveAppPageStaticGenerationRuntime`. A route that only a
 * nested slot page materializes is built from that slot page, so its layouts
 * include the slot's.
 */
export function collectAppPageStaticGenerationRuntimes(
  options: Pick<ResolveAppPageSegmentConfigOptions, "layouts" | "page" | "parallelBranches"> & {
    childrenSlot?: AppPageChildrenSlot | null;
  },
): unknown[] {
  const layoutRuntimes = (options.layouts ?? []).map((layout) => layout?.runtime);
  const childrenDefaultPosition = resolveChildrenDefaultTreePosition(options.childrenSlot);
  if (childrenDefaultPosition === null) return [...layoutRuntimes, options.page?.runtime];

  const slotPage = (options.parallelBranches ?? [])
    .filter(
      (branch): branch is ParallelAppPageSegmentConfigBranch =>
        !!branch && !branch.isDefault && branch.ownerTreePosition === childrenDefaultPosition,
    )
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))[0];
  if (!slotPage) return [...layoutRuntimes, options.page?.runtime];
  return [
    ...layoutRuntimes,
    slotPage.layout?.runtime,
    ...(slotPage.configLayouts ?? []).map((layout) => layout?.runtime),
    slotPage.page?.runtime,
  ];
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
 * Collect the loader-tree segments of an App page route from its layout, page
 * and parallel-slot modules, for `lastDynamicSegmentHasGenerateStaticParams`.
 *
 * Children follow Next.js's loader tree order: slots with a matched page come
 * first (sorted by name), then `children`, then slots that render `default`.
 * A default slot is a single `__DEFAULT__` segment without the slot's layout.
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/webpack/loaders/next-app-loader/index.ts#L733-L790
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
    const owner = Math.min(
      branch.ownerTreePosition ??
        routeSegments.length - (branch.isDefault ? 0 : (branch.routeSegments ?? []).length),
      routeSegments.length,
    );
    branchesByOwner.set(owner, [...(branchesByOwner.get(owner) ?? []), branch]);
  }

  const segments: AppPageStaticParamsWalkSegment[] = [];
  let treePath: number[] = [];
  // A folder's segment takes its module from the folder's layout. The page is
  // a child segment of the deepest folder.
  for (let position = 0; position <= routeSegments.length + 1; position++) {
    const owned = branchesByOwner.get(position) ?? [];
    const active = owned
      .filter((branch) => !branch.isDefault)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    const defaults = owned.filter((branch) => branch.isDefault);

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

    active.forEach((branch, rank) => {
      segments.push(...collectActiveSlotSegments(branch, [...treePath, rank]));
    });
    if (position === childrenDefaultPosition) {
      segments.push({
        dynamic: false,
        generateStaticParams: hasGenerateStaticParamsExport(options.page),
        identity: [DEFAULT_SEGMENT_NAME, options.page ?? undefined],
        treePath: [...treePath, active.length],
      });
    }
    defaults.forEach((branch, index) => {
      segments.push({
        dynamic: false,
        generateStaticParams: hasGenerateStaticParamsExport(branch.page),
        identity: [DEFAULT_SEGMENT_NAME, branch.page ?? undefined],
        treePath: [...treePath, active.length + 1 + index],
      });
    });
    if (position === childrenDefaultPosition) break;
    treePath = [...treePath, active.length];
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
  let treePath = [...slotPath];
  branchSegments.forEach((name, index) => {
    treePath = [...treePath, 0];
    const layout = configLayoutsByPosition.get(index + 1);
    segments.push({
      dynamic: isDynamicSegment(name),
      generateStaticParams: hasGenerateStaticParamsExport(layout),
      identity: [name, layout],
      treePath,
    });
  });
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
