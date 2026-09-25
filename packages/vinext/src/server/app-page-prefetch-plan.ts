import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  APP_RSC_RENDER_MODE_PREFETCH_EMPTY,
  APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";

// Which parts of a route an App page render mode includes, shared by route
// wiring (which builds the payload) and the probes that run ahead of a
// response's headers. This module has no runtime dependency on either, so both
// can import it.

type AppPagePrefetchModule = Readonly<{ default?: unknown }>;

export type AppPageLoadingEntry<TModule extends AppPagePrefetchModule = AppPagePrefetchModule> = {
  loadingModule?: TModule | null | undefined;
  treePosition: number;
};

type AppPagePrefetchRouteLoadings<TModule extends AppPagePrefetchModule> = Readonly<{
  loading?: TModule | null;
  loadings?: readonly (TModule | null | undefined)[] | null;
  loadingTreePositions?: readonly number[] | null;
}>;

type AppPagePrefetchSlot<TModule extends AppPagePrefetchModule> = Readonly<{
  loading?: TModule | null;
  loadings?: readonly (TModule | null | undefined)[] | null;
  loadingTreePositions?: readonly number[] | null;
  name?: string;
  ownerTreePosition?: number | null;
}>;

type AppPagePrefetchSlotOverride<TModule extends AppPagePrefetchModule> = Readonly<{
  loadingModules?: readonly (TModule | null | undefined)[] | null;
  loadingTreePositions?: readonly number[] | null;
}>;

type AppPagePrefetchRoute<TModule extends AppPagePrefetchModule> =
  AppPagePrefetchRouteLoadings<TModule> &
    Readonly<{
      routeSegments?: readonly string[] | null;
      slots?: Readonly<Record<string, AppPagePrefetchSlot<TModule> | null | undefined>> | null;
    }>;

export function createAppPageLoadingEntries<TModule extends AppPagePrefetchModule>(
  route: AppPagePrefetchRouteLoadings<TModule>,
): AppPageLoadingEntry<TModule>[] {
  return (route.loadings ?? []).flatMap((loadingModule, index) => {
    if (!loadingModule) return [];
    const treePosition = route.loadingTreePositions?.[index];
    if (treePosition === undefined) return [];
    return [{ loadingModule, treePosition }];
  });
}

function getPrefetchLoadingEntry<TModule extends AppPagePrefetchModule>(
  route: AppPagePrefetchRouteLoadings<TModule> &
    Readonly<{ routeSegments?: readonly string[] | null }>,
): AppPageLoadingEntry<TModule> | null {
  let rootEntry: AppPageLoadingEntry<TModule> | null = null;
  let firstNestedEntry: AppPageLoadingEntry<TModule> | null = null;
  for (const [index, loadingModule] of (route.loadings ?? []).entries()) {
    if (!loadingModule?.default) continue;
    const treePosition = route.loadingTreePositions?.[index];
    if (treePosition === undefined) continue;
    if (treePosition === 0) {
      rootEntry ??= { loadingModule, treePosition };
    } else if (firstNestedEntry === null || treePosition < firstNestedEntry.treePosition) {
      firstNestedEntry = { loadingModule, treePosition };
    }
  }
  // The root layout is already shared for a client-side prefetch. Prefer the
  // first loading boundary below it, falling back to the root loading UI only
  // when no nested boundary exists.
  if (firstNestedEntry) return firstNestedEntry;
  if (rootEntry) return rootEntry;

  // Legacy/eager route fixtures may only expose the leaf loading field.
  return route.loading?.default
    ? { loadingModule: route.loading, treePosition: route.routeSegments?.length ?? 0 }
    : null;
}

export function createAppPageSlotLoadingEntries<TModule extends AppPagePrefetchModule>(
  slot: AppPagePrefetchSlot<TModule>,
  override: AppPagePrefetchSlotOverride<TModule> | null,
): AppPageLoadingEntry<TModule>[] {
  const entries: AppPageLoadingEntry<TModule>[] = [];
  const slotLoadingModules =
    (slot.loadings?.length ?? 0) > 0 ? slot.loadings! : slot.loading ? [slot.loading] : [];
  const slotLoadingTreePositions =
    (slot.loadingTreePositions?.length ?? 0) > 0 ? slot.loadingTreePositions! : [0];

  for (const [index, loadingModule] of slotLoadingModules.entries()) {
    const treePosition = slotLoadingTreePositions[index];
    if (!loadingModule?.default || treePosition === undefined) continue;
    // An interception replaces the slot's normal active branch. Only the slot
    // root is necessarily shared; nested normal-branch loadings belong to a
    // sibling subtree and must not wrap the intercepting page.
    if (override && treePosition !== 0) continue;
    entries.push({ loadingModule, treePosition });
  }

  for (const [index, loadingModule] of (override?.loadingModules ?? []).entries()) {
    const treePosition = override?.loadingTreePositions?.[index];
    if (!loadingModule?.default || treePosition === undefined) continue;
    entries.push({ loadingModule, treePosition });
  }

  return entries;
}

export function getFirstLoadingEntry<TModule extends AppPagePrefetchModule>(
  entries: readonly AppPageLoadingEntry<TModule>[],
): AppPageLoadingEntry<TModule> | null {
  return entries.reduce<AppPageLoadingEntry<TModule> | null>(
    (first, entry) => (first === null || entry.treePosition < first.treePosition ? entry : first),
    null,
  );
}

export type AppPagePrefetchPlan<TModule extends AppPagePrefetchModule> = Readonly<{
  /** A `prefetch-empty` render includes no layout, template, page or slot. */
  isPrefetchEmpty: boolean;
  isPrefetchLoadingShell: boolean;
  /** The route loading boundary a loading-shell prefetch stops at. */
  prefetchLoadingEntry: AppPageLoadingEntry<TModule> | null;
  prefetchSlotLoadingEntries: readonly { ownerTreePosition: number }[];
  /** Whether a loading-shell prefetch includes the route segment at this position. */
  includesTreePosition(treePosition: number): boolean;
  /** Whether the payload includes a parallel slot at all. */
  includesSlot(ownerTreePosition: number, targetTreePosition: number): boolean;
  /**
   * The loading boundary a loading-shell prefetch renders for an included slot
   * in place of its page, or null when the shell omits the slot. A slot owned
   * at the route's cutoff renders the route's loading UI and none of its
   * branch layouts.
   */
  resolveSlotLoadingEntry(
    ownerTreePosition: number,
    slotLoadingEntries: readonly AppPageLoadingEntry<TModule>[],
  ): { entry: AppPageLoadingEntry<TModule> | null; isOwnedAtRoutePrefetchCutoff: boolean };
}>;

export function resolveAppPagePrefetchPlan<TModule extends AppPagePrefetchModule>(options: {
  renderMode: AppRscRenderMode | undefined;
  resolveSlotOverride: (
    slotKey: string,
    slotName: string,
  ) => AppPagePrefetchSlotOverride<TModule> | null | undefined;
  route: AppPagePrefetchRoute<TModule>;
}): AppPagePrefetchPlan<TModule> {
  const renderMode = options.renderMode ?? APP_RSC_RENDER_MODE_NAVIGATION;
  const isPrefetchEmpty = renderMode === APP_RSC_RENDER_MODE_PREFETCH_EMPTY;
  const isPrefetchLoadingShell = renderMode === APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL;
  const prefetchLoadingEntry = isPrefetchLoadingShell
    ? getPrefetchLoadingEntry(options.route)
    : null;
  const prefetchSlotLoadingEntries = isPrefetchLoadingShell
    ? Object.entries(options.route.slots ?? {}).flatMap(([slotKey, slot]) => {
        if (!slot) return [];
        const override = options.resolveSlotOverride(slotKey, slot.name ?? slotKey) ?? null;
        const firstLoadingEntry = getFirstLoadingEntry(
          createAppPageSlotLoadingEntries(slot, override),
        );
        return firstLoadingEntry ? [{ ownerTreePosition: slot.ownerTreePosition ?? 0 }] : [];
      })
    : [];
  // The children spine must reach every slot owner whose branch has a loading
  // boundary. A loading on the spine itself stops traversal first, matching
  // Next.js's per-parallel-route pre-PPR component-tree walk.
  const prefetchCutoffTreePosition = isPrefetchLoadingShell
    ? (prefetchLoadingEntry?.treePosition ??
      prefetchSlotLoadingEntries.reduce(
        (deepest, entry) => Math.max(deepest, entry.ownerTreePosition),
        0,
      ))
    : null;
  const includesTreePosition = (treePosition: number): boolean =>
    prefetchCutoffTreePosition === null || treePosition <= prefetchCutoffTreePosition;
  return {
    isPrefetchEmpty,
    isPrefetchLoadingShell,
    prefetchLoadingEntry,
    prefetchSlotLoadingEntries,
    includesTreePosition,
    includesSlot(ownerTreePosition, targetTreePosition) {
      if (isPrefetchEmpty) return false;
      if (!isPrefetchLoadingShell) return true;
      return prefetchLoadingEntry
        ? ownerTreePosition <= prefetchLoadingEntry.treePosition
        : includesTreePosition(targetTreePosition);
    },
    resolveSlotLoadingEntry(ownerTreePosition, slotLoadingEntries) {
      const isOwnedAtRoutePrefetchCutoff =
        isPrefetchLoadingShell &&
        prefetchLoadingEntry !== null &&
        ownerTreePosition === prefetchLoadingEntry.treePosition;
      return {
        entry: isOwnedAtRoutePrefetchCutoff
          ? prefetchLoadingEntry
          : isPrefetchLoadingShell
            ? getFirstLoadingEntry(slotLoadingEntries)
            : null,
        isOwnedAtRoutePrefetchCutoff,
      };
    },
  };
}
