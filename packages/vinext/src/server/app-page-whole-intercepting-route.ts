/**
 * The extent of a whole intercepting route (see app-page-element-builder.ts).
 * Next.js renders it as a loader tree of its own, which stops at the folder
 * holding the intercepted slot: the owner's `default` takes its children
 * there. The owner's page can sit in a route group below that folder, as
 * `club/(children)/page.tsx` beside `club/@modal` does, and the files of that
 * group (its layout, template, boundaries and the slots it owns) are not in
 * that tree, so the whole intercepting route neither renders nor loads them.
 */

type WholeInterceptingRouteSlot = {
  layoutIndex?: number;
  ownerTreePosition?: number | null;
};

type WholeInterceptingRouteShape = {
  layoutTreePositions?: readonly number[] | null;
  routeSegments?: readonly string[] | null;
  slots?: Readonly<Record<string, WholeInterceptingRouteSlot>> | null;
};

type RouteFiles = readonly unknown[] | null | undefined;
type TreePositions = readonly number[] | null | undefined;

/** The parts of a route a whole intercepting route trims. */
type TrimmableRoute = WholeInterceptingRouteShape & {
  childrenRouteSegments?: readonly string[] | null;
  childrenSlot?: { ownerTreePath: string } | null;
  error?: unknown;
  errorPaths?: RouteFiles;
  errorTreePositions?: TreePositions;
  errors?: RouteFiles;
  forbidden?: unknown;
  forbiddenTreePosition?: number | null;
  forbiddens?: RouteFiles;
  layouts?: RouteFiles;
  loading?: unknown;
  loadingTreePositions?: TreePositions;
  loadings?: RouteFiles;
  notFound?: unknown;
  notFoundTreePosition?: number | null;
  notFounds?: RouteFiles;
  segmentForbiddenTreePositions?: TreePositions;
  segmentForbiddens?: RouteFiles;
  segmentNotFoundTreePositions?: TreePositions;
  segmentNotFounds?: RouteFiles;
  segmentUnauthorizedTreePositions?: TreePositions;
  segmentUnauthorizeds?: RouteFiles;
  templateTreePositions?: TreePositions;
  templates?: RouteFiles;
  unauthorized?: unknown;
  unauthorizedTreePosition?: number | null;
  unauthorizeds?: RouteFiles;
};

/** The main-tree position of the folder that holds the intercepted slot. */
function resolveInterceptSlotOwnerTreePosition(
  route: WholeInterceptingRouteShape,
  interceptSlotKey: unknown,
): number | undefined {
  const slot = typeof interceptSlotKey === "string" ? route.slots?.[interceptSlotKey] : undefined;
  return slot?.ownerTreePosition ?? route.layoutTreePositions?.[slot?.layoutIndex ?? -1];
}

/**
 * The tree position a whole intercepting route stops its route at: the
 * owner's folder, when the route's own folder is below it. Otherwise the
 * route ends there already, and nothing of it is dropped.
 */
export function resolveWholeInterceptingRouteEnd(
  route: WholeInterceptingRouteShape,
  interceptSlotKey: unknown,
): number | undefined {
  const ownerTreePosition = resolveInterceptSlotOwnerTreePosition(route, interceptSlotKey);
  return ownerTreePosition !== undefined && (route.routeSegments?.length ?? 0) > ownerTreePosition
    ? ownerTreePosition
    : undefined;
}

/**
 * The entries of a root-to-leaf list at or above the owner's folder. They
 * lead the list, so the ones kept keep their indexes, which slots and other
 * lists aligned with it refer to.
 */
export function keepOwnerLevelEntries<T>(
  entries: readonly T[] | null | undefined,
  treePositions: readonly number[] | null | undefined,
  ownerTreePosition: number,
): readonly T[] | null | undefined {
  if (!entries) return entries;
  const belowIndex = entries.findIndex(
    (_, index) => (treePositions?.[index] ?? 0) > ownerTreePosition,
  );
  return belowIndex === -1 ? entries : entries.slice(0, belowIndex);
}

/** Whether a slot belongs to the owner's folder or one above it. */
export function isOwnerLevelSlot(
  route: WholeInterceptingRouteShape,
  slot: WholeInterceptingRouteSlot,
  ownerTreePosition: number,
): boolean {
  return (
    (slot.ownerTreePosition ?? route.layoutTreePositions?.[slot.layoutIndex ?? 0] ?? 0) <=
    ownerTreePosition
  );
}

/**
 * The route's nearest not-found, forbidden or unauthorized file for the
 * owner's folder: its own nearest one when that is at or above the folder,
 * else the deepest of its segment files that is.
 */
export function resolveOwnerLevelAccessFile<TModule>(
  file: TModule | null | undefined,
  fileTreePosition: number | null | undefined,
  segmentFiles: readonly (TModule | null | undefined)[] | null | undefined,
  segmentFileTreePositions: readonly number[] | null | undefined,
  ownerTreePosition: number,
): { file: TModule | null; treePosition: number | null } {
  if (fileTreePosition != null && fileTreePosition <= ownerTreePosition) {
    return { file: file ?? null, treePosition: fileTreePosition };
  }
  const positions = segmentFileTreePositions ?? [];
  for (let index = positions.length - 1; index >= 0; index--) {
    const segmentFile = segmentFiles?.[index];
    if (segmentFile && positions[index] <= ownerTreePosition) {
      return { file: segmentFile, treePosition: positions[index] };
    }
  }
  return { file: null, treePosition: null };
}

/**
 * The route as the whole intercepting route renders it: none of its entries
 * below the owner's folder, and the owner's folder as its last segment, whose
 * children the owner's `default` takes.
 */
export function trimRouteToInterceptSlotOwner<TRoute extends TrimmableRoute>(
  route: TRoute,
  interceptSlotKey: unknown,
): TRoute {
  const ownerTreePosition = resolveWholeInterceptingRouteEnd(route, interceptSlotKey);
  if (ownerTreePosition === undefined) return route;
  const routeSegments = route.routeSegments ?? [];
  const keep = <T>(
    entries: readonly T[] | null | undefined,
    treePositions: readonly number[] | null | undefined,
  ) => keepOwnerLevelEntries(entries, treePositions, ownerTreePosition);
  const layoutTreePositions = route.layoutTreePositions;
  const notFound = resolveOwnerLevelAccessFile(
    route.notFound,
    route.notFoundTreePosition,
    route.segmentNotFounds,
    route.segmentNotFoundTreePositions,
    ownerTreePosition,
  );
  const forbidden = resolveOwnerLevelAccessFile(
    route.forbidden,
    route.forbiddenTreePosition,
    route.segmentForbiddens,
    route.segmentForbiddenTreePositions,
    ownerTreePosition,
  );
  const unauthorized = resolveOwnerLevelAccessFile(
    route.unauthorized,
    route.unauthorizedTreePosition,
    route.segmentUnauthorizeds,
    route.segmentUnauthorizedTreePositions,
    ownerTreePosition,
  );
  // The route's own `loading` and `error` are those of its last segment,
  // which is now the owner's folder.
  const ownerFile = <T>(
    files: readonly T[] | null | undefined,
    treePositions: readonly number[] | null | undefined,
  ) => files?.[treePositions?.lastIndexOf(ownerTreePosition) ?? -1] ?? null;
  const childrenSlot = route.childrenSlot;
  return {
    ...route,
    childrenRouteSegments: route.childrenRouteSegments?.slice(0, ownerTreePosition) ?? null,
    // A children slot of a layout below the owner's folder isn't rendered.
    childrenSlot:
      childrenSlot &&
      childrenSlot.ownerTreePath.split("/").filter(Boolean).length <= ownerTreePosition
        ? childrenSlot
        : null,
    error: ownerFile(route.errorPaths, route.errorTreePositions),
    errorPaths: keep(route.errorPaths, route.errorTreePositions),
    errorTreePositions: keep(route.errorTreePositions, route.errorTreePositions),
    errors: keep(route.errors, layoutTreePositions),
    forbidden: forbidden.file,
    forbiddenTreePosition: forbidden.treePosition,
    forbiddens: keep(route.forbiddens, layoutTreePositions),
    layoutTreePositions: keep(layoutTreePositions, layoutTreePositions),
    layouts: keep(route.layouts, layoutTreePositions) ?? [],
    loading: ownerFile(route.loadings, route.loadingTreePositions),
    loadingTreePositions: keep(route.loadingTreePositions, route.loadingTreePositions),
    loadings: keep(route.loadings, route.loadingTreePositions),
    notFound: notFound.file,
    notFoundTreePosition: notFound.treePosition,
    notFounds: keep(route.notFounds, layoutTreePositions),
    routeSegments: routeSegments.slice(0, ownerTreePosition),
    segmentForbiddenTreePositions: keep(
      route.segmentForbiddenTreePositions,
      route.segmentForbiddenTreePositions,
    ),
    segmentForbiddens: keep(route.segmentForbiddens, route.segmentForbiddenTreePositions),
    segmentNotFoundTreePositions: keep(
      route.segmentNotFoundTreePositions,
      route.segmentNotFoundTreePositions,
    ),
    segmentNotFounds: keep(route.segmentNotFounds, route.segmentNotFoundTreePositions),
    segmentUnauthorizedTreePositions: keep(
      route.segmentUnauthorizedTreePositions,
      route.segmentUnauthorizedTreePositions,
    ),
    segmentUnauthorizeds: keep(route.segmentUnauthorizeds, route.segmentUnauthorizedTreePositions),
    slots: route.slots
      ? Object.fromEntries(
          Object.entries(route.slots).filter(([, slot]) =>
            isOwnerLevelSlot(route, slot, ownerTreePosition),
          ),
        )
      : route.slots,
    templateTreePositions: keep(route.templateTreePositions, route.templateTreePositions),
    templates: keep(route.templates, route.templateTreePositions),
    unauthorized: unauthorized.file,
    unauthorizedTreePosition: unauthorized.treePosition,
    unauthorizeds: keep(route.unauthorizeds, layoutTreePositions),
  };
}

/** The parts of a route the whole intercepting route's render shows. */
type RenderableWholeRoute = TrimmableRoute & {
  childrenSlot?: { ownerTreePath: string; state?: string } | null;
  page?: unknown;
};

/**
 * The route as the whole intercepting route renders it: trimmed to the
 * owner's folder, with the owner's `default` as its page, and every slot but
 * the intercepted one showing its default. Its `children` shows the owner
 * `default` too, so a children slot of the owner's layout is bound as a
 * default (or unmatched, with no owner default), like a slot sub-route's. One
 * of an ancestor layout still holds the owner's tree, and stays as it is. Its
 * render and the fallbacks of its errors both read this route, so neither
 * reads the owner's page or another slot's page, which it never loads.
 */
export function toWholeInterceptingRouteRender<TRoute extends RenderableWholeRoute>(
  route: TRoute,
  interceptSlotKey: unknown,
  ownerDefault: TRoute["page"],
): TRoute {
  const trimmed = trimRouteToInterceptSlotOwner(route, interceptSlotKey);
  const ownerTreePosition = resolveInterceptSlotOwnerTreePosition(trimmed, interceptSlotKey);
  const childrenSlot = trimmed.childrenSlot;
  const ownsChildrenSlot =
    !!childrenSlot &&
    childrenSlot.ownerTreePath.split("/").filter(Boolean).length === ownerTreePosition;
  return {
    ...trimmed,
    page: ownerDefault,
    ...(childrenSlot &&
      ownsChildrenSlot && {
        childrenSlot: { ...childrenSlot, state: ownerDefault ? "default" : "unmatched" },
      }),
    ...(trimmed.slots && {
      slots: Object.fromEntries(
        Object.entries(trimmed.slots).map(([slotKey, slot]) => [
          slotKey,
          slotKey === interceptSlotKey ? slot : toDefaultSlot(slot),
        ]),
      ),
    }),
  };
}

/**
 * A slot showing its default as Next.js's lone `__DEFAULT__` segment: none of
 * the layouts, loading, error and not-found files and segments of the branch
 * its page would take, the slot directory's own included.
 */
function toDefaultSlot<TSlot extends object>(slot: TSlot): TSlot {
  return {
    ...slot,
    configLayouts: null,
    configLayoutTreePositions: null,
    error: null,
    errors: null,
    errorTreePositions: null,
    layout: null,
    loading: null,
    loadings: null,
    loadingTreePositions: null,
    notFound: null,
    notFoundTreePosition: null,
    notFounds: null,
    notFoundTreePositions: null,
    page: null,
    routeSegments: null,
    slotParamNames: null,
    slotPatternParts: null,
  };
}
