import {
  APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_INTERCEPTION_KEY,
  APP_ROUTE_FALLBACK_ID_PREFIX,
  APP_ROUTE_HEAD_ID_PREFIX,
  APP_SLOT_BINDINGS_KEY,
  APP_STREAMING_METADATA_BODY_ID_PREFIX,
  AppElementsWire,
  normalizeAppElementsSlotBindings,
  type AppElements,
  type AppElementsSlotBinding,
} from "./app-elements.js";
import { rendersSiblingIntercept, type AppRouterState } from "./app-browser-state.js";
import { resolveActiveRoutePaths } from "./app-history-state.js";
import { isRouteMissInterceptionSource } from "./app-interception-context-header.js";
import { isNestedBfcacheSlotSegmentIdFor } from "./bfcache-identity.js";
import type {
  BrowserRouteManifest,
  BrowserRouteManifestInterception,
} from "../routing/browser-route-manifest.js";
import { matchRoutePattern } from "../routing/route-pattern.js";
import { normalizePathnameForRouteMatch, splitPathnameForRouteMatch } from "../routing/utils.js";
import { removeTrailingSlash, restoreBasePath, stripBasePath } from "../utils/base-path.js";
import { normalizePath } from "./normalize-path.js";

const SUPPLEMENTAL_REFRESH_TIMEOUT_MS = 10_000;

export type SupplementalRefreshDegradedReason = "aborted" | "failed" | "timeout";

export type SupplementalRefreshResult<T> =
  | { degraded: false; value: Awaited<T> }
  | {
      degraded: true;
      reason: SupplementalRefreshDegradedReason;
      value: Awaited<T>;
    };

export class SupplementalRefreshError extends Error {
  readonly reason: SupplementalRefreshDegradedReason;

  constructor(reason: SupplementalRefreshDegradedReason) {
    super(`[vinext] Supplemental parallel-route refresh ${reason}`);
    this.name = "SupplementalRefreshError";
    this.reason = reason;
  }
}

export function requireCompleteSupplementalRefresh<T>(
  result: SupplementalRefreshResult<T>,
): Awaited<T> {
  if (result.degraded) throw new SupplementalRefreshError(result.reason);
  return result.value;
}

export function resolveServerActionSupplementalRefresh<T>(
  result: SupplementalRefreshResult<T>,
  currentValue: Awaited<T>,
): { retry: boolean; value: Awaited<T> } {
  return result.degraded
    ? { retry: result.reason !== "aborted", value: currentValue }
    : { retry: false, value: result.value };
}

export type SupplementalRefreshHandle = {
  finish(): void;
  signal: AbortSignal;
};

/**
 * Whether a payload renders the whole intercepting route, which Next.js renders
 * alone: it keeps nothing of its source or of any other render but the mounted
 * slots it left out, filled from the render of the URL the client kept each from.
 */
function rendersWholeInterceptingRoute(elements: AppElements): boolean {
  return AppElementsWire.readMetadata(elements).wholeInterceptionSource !== null;
}

// The slots a payload left out for the client to keep: mounted slots that have
// only a default in the tree it renders.
function leftMountedSlotIds(elements: AppElements): string[] {
  return AppElementsWire.readMetadata(elements)
    .slotBindings.filter(
      (binding) => binding.state === "default" && !Object.hasOwn(elements, binding.slotId),
    )
    .map((binding) => binding.slotId);
}

/**
 * Whether a payload takes a fan-out's renders. The whole intercepting route
 * takes only the slots it left for the client to keep, which Next.js refetches
 * from the URL each was rendered at, as it does for any reused segment.
 */
export function takesSupplementalRefreshes(elements: AppElements): boolean {
  return !rendersWholeInterceptingRoute(elements) || leftMountedSlotIds(elements).length > 0;
}

/**
 * The URL each active slot of a state was rendered at, the one a fan-out
 * refetches it from: a page's own URL, or the URL a slot showing an intercept
 * was intercepted at (see resolvePersistedRefreshInterceptions).
 */
export function resolveKeptSlotPathnames(
  slotBindings: readonly AppElementsSlotBinding[],
): ReadonlyMap<string, string> {
  const pathnames = new Map<string, string>();
  for (const binding of slotBindings) {
    if (binding.state !== "active" || binding.activeRouteId == null) continue;
    const route = AppElementsWire.parseElementKey(binding.activeRouteId);
    if (route?.kind === "route") {
      pathnames.set(binding.slotId, binding.refreshPathname ?? route.path);
    }
  }
  return pathnames;
}

// The whole intercepting route keeps nothing of another render but the slots
// it left for the client to keep, each from the render of the URL the client
// kept it from, when the state names one: another URL may render the same slot
// for other params. An intercepted render supplies only the slot it intercepts.
function mergeLeftMountedSlots(
  currentElements: AppElements,
  refreshedElements: AppElements,
  keptSlotPathnames: ReadonlyMap<string, string> | null,
): AppElements {
  const refreshedMetadata = AppElementsWire.readMetadata(refreshedElements);
  const leftSlotIds = new Set(leftMountedSlotIds(currentElements));
  const interceptedSlotId = refreshedMetadata.interception?.slotId ?? null;
  const refreshedBindings = refreshedMetadata.slotBindings.filter(
    (binding) =>
      binding.state === "active" &&
      leftSlotIds.has(binding.slotId) &&
      (interceptedSlotId === null || binding.slotId === interceptedSlotId) &&
      (keptSlotPathnames === null ||
        (binding.refreshPathname !== undefined &&
          keptSlotPathnames.get(binding.slotId) === binding.refreshPathname)) &&
      Object.hasOwn(refreshedElements, binding.slotId),
  );
  if (refreshedBindings.length === 0) return currentElements;

  const currentMetadata = AppElementsWire.readMetadata(currentElements);
  const refreshedSlotIds = refreshedBindings.map((binding) => binding.slotId);
  const slotBindings = currentMetadata.slotBindings.filter(
    (binding) => !refreshedSlotIds.includes(binding.slotId),
  );
  slotBindings.push(...refreshedBindings);
  const merged: Record<string, AppElements[keyof AppElements]> = {
    ...currentElements,
    [APP_SLOT_BINDINGS_KEY]: normalizeAppElementsSlotBindings(slotBindings, {
      layoutIds: currentMetadata.layoutIds,
    }),
  };
  for (const slotId of refreshedSlotIds) merged[slotId] = refreshedElements[slotId];
  copySlotIdentities(merged, currentElements, refreshedElements, refreshedSlotIds);
  return merged;
}

export function mergeRefreshedParallelSlot(
  currentElements: AppElements,
  refreshedElements: AppElements,
  keptSlotPathnames: ReadonlyMap<string, string> | null = null,
): AppElements {
  if (rendersWholeInterceptingRoute(currentElements)) {
    return mergeLeftMountedSlots(currentElements, refreshedElements, keptSlotPathnames);
  }
  const refreshedMetadata = AppElementsWire.readMetadata(refreshedElements);
  const interception = refreshedMetadata.interception;
  if (interception === null) {
    const currentMetadata = AppElementsWire.readMetadata(currentElements);
    // The slot an intercepted payload shows its intercept in stays its own,
    // whatever the source matches there from its own URL.
    const interceptedSlotId = currentMetadata.interception?.slotId ?? null;
    const refreshedBindings = refreshedMetadata.slotBindings.filter(
      (binding) =>
        binding.state === "active" &&
        binding.slotId !== interceptedSlotId &&
        Object.hasOwn(refreshedElements, binding.slotId),
    );
    if (refreshedBindings.length === 0) {
      return supplyRetainedElements(currentElements, refreshedElements);
    }

    const suppliesSourceTree = refreshedBindings.some((binding) => {
      const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
      return parsedSlot?.kind === "slot" && parsedSlot.name === "children";
    });
    if (suppliesSourceTree) {
      const refreshedSlotIds = new Set(refreshedBindings.map((binding) => binding.slotId));
      const refreshedChildrenBindings = refreshedBindings.filter((binding) => {
        const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
        return parsedSlot?.kind === "slot" && parsedSlot.name === "children";
      });
      const retainedBindings = currentMetadata.slotBindings.filter((binding) => {
        const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
        return (
          binding.state === "active" &&
          parsedSlot?.kind === "slot" &&
          !refreshedSlotIds.has(binding.slotId) &&
          Object.hasOwn(currentElements, binding.slotId)
        );
      });
      // A route reached through a named parallel slot can describe its source
      // page as an unmatched children slot at a deeper layout address, while
      // the supplemental source response carries the same page at the root
      // children address. Promote that single unambiguous carrier so the
      // mounted layout reads the fresh source page rather than the unmatched
      // marker.
      const promotableChildrenBindings = currentMetadata.slotBindings.filter((binding) => {
        const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
        return (
          binding.state === "unmatched" &&
          parsedSlot?.kind === "slot" &&
          parsedSlot.name === "children" &&
          !refreshedSlotIds.has(binding.slotId)
        );
      });
      const promotedBindings: AppElementsSlotBinding[] =
        refreshedChildrenBindings.length === 1 && promotableChildrenBindings.length === 1
          ? [
              {
                ...promotableChildrenBindings[0],
                activeRouteId: refreshedChildrenBindings[0].activeRouteId,
                ...(refreshedChildrenBindings[0].refreshPathname !== undefined
                  ? { refreshPathname: refreshedChildrenBindings[0].refreshPathname }
                  : {}),
                state: "active",
              },
            ]
          : [];
      const retainedSlotIds = new Set(
        [...retainedBindings, ...promotedBindings].map((binding) => binding.slotId),
      );
      const slotBindings = refreshedMetadata.slotBindings.filter(
        (binding) => !retainedSlotIds.has(binding.slotId),
      );
      slotBindings.push(...retainedBindings, ...promotedBindings);
      const merged: Record<string, AppElements[keyof AppElements]> = {
        ...refreshedElements,
        ...(currentMetadata.interception === null
          ? {}
          : {
              [APP_INTERCEPTION_KEY]: currentMetadata.interception,
              [APP_INTERCEPTION_CONTEXT_KEY]: currentMetadata.interceptionContext,
              [AppElementsWire.keys.retainedElementIds]: currentMetadata.retainedElementIds,
            }),
        [APP_SLOT_BINDINGS_KEY]: normalizeAppElementsSlotBindings(slotBindings, {
          layoutIds: refreshedMetadata.layoutIds,
        }),
      };
      for (const binding of retainedBindings) {
        merged[binding.slotId] = currentElements[binding.slotId];
      }
      copySlotIdentities(
        merged,
        refreshedElements,
        currentElements,
        retainedBindings.map((binding) => binding.slotId),
      );
      if (promotedBindings.length === 1) {
        merged[promotedBindings[0].slotId] = refreshedElements[refreshedChildrenBindings[0].slotId];
      }
      // The layouts and templates the refreshed URL rendered stay its own, as
      // they would on a hard load of that URL: the source's render fills only
      // the ones it left out.
      keepRenderedLayoutElements(merged, currentElements);
      copyRefreshedBranchElements(merged, currentElements, {
        overwrite: currentMetadata.retainedElementIds.length > 0,
      });
      return merged;
    }

    const refreshedSlotIds = new Set(refreshedBindings.map((binding) => binding.slotId));
    const slotBindings = currentMetadata.slotBindings.filter(
      (binding) => !refreshedSlotIds.has(binding.slotId),
    );
    slotBindings.push(...refreshedBindings);
    const merged: Record<string, AppElements[keyof AppElements]> = {
      ...currentElements,
      [APP_SLOT_BINDINGS_KEY]: normalizeAppElementsSlotBindings(slotBindings, {
        layoutIds: currentMetadata.layoutIds,
      }),
    };
    for (const binding of refreshedBindings) {
      merged[binding.slotId] = refreshedElements[binding.slotId];
    }
    copySlotIdentities(
      merged,
      currentElements,
      refreshedElements,
      refreshedBindings.map((binding) => binding.slotId),
    );
    // An intercepted payload's own entries stay its own: the source's render
    // fills only the ones it left out.
    copyRefreshedBranchElements(merged, refreshedElements, {
      overwrite: currentMetadata.retainedElementIds.length === 0,
    });
    return supplyRetainedElements(merged, refreshedElements);
  }

  const refreshedSlot = refreshedElements[interception.slotId];
  if (refreshedSlot === undefined) return currentElements;

  const currentMetadata = AppElementsWire.readMetadata(currentElements);
  const refreshedBinding = refreshedMetadata.slotBindings.find(
    (binding) => binding.slotId === interception.slotId,
  );
  const slotBindings: AppElementsSlotBinding[] = currentMetadata.slotBindings.filter(
    (binding) => binding.slotId !== interception.slotId,
  );
  if (refreshedBinding) slotBindings.push(refreshedBinding);

  const merged: Record<string, AppElements[keyof AppElements]> = {
    ...currentElements,
    [interception.slotId]: refreshedSlot,
    [APP_SLOT_BINDINGS_KEY]: normalizeAppElementsSlotBindings(slotBindings, {
      layoutIds: currentMetadata.layoutIds,
    }),
  };
  copySlotIdentities(merged, currentElements, refreshedElements, [interception.slotId]);
  copyRefreshedBranchElements(merged, refreshedElements);
  return merged;
}

// Whether `sourceElements` is the render, from its own URL, of the source page
// the server proved the intercepted payload `currentElements` for.
function isInterceptionSourceRender(
  currentElements: AppElements,
  sourceElements: AppElements,
): boolean {
  const interception = AppElementsWire.readMetadata(currentElements).interception;
  const sourceMetadata = AppElementsWire.readMetadata(sourceElements);
  // The source render names its matched URL in its own route id, which renders
  // without an interception context.
  const sourceRoute = AppElementsWire.parseElementKey(sourceMetadata.routeId);
  return (
    interception !== null &&
    sourceMetadata.interception === null &&
    sourceRoute?.kind === "route" &&
    sourceRoute.interceptionContext === null &&
    sourceMetadata.routeId === interception.sourceRouteId &&
    sourceRoute.path === interception.sourceMatchedUrl
  );
}

// A refresh, traversal or server-action re-render of an intercepted state
// renders its source page from that page's own URL. The render goes beneath the
// intercept the server proved for that source only: a payload the server
// rendered without one, or for another source, commits as it was rendered.
export function mergeInterceptionSourceRefresh(
  currentElements: AppElements,
  sourceElements: AppElements,
  keptSlotPathnames: ReadonlyMap<string, string> | null = null,
): AppElements {
  return rendersWholeInterceptingRoute(currentElements) ||
    isInterceptionSourceRender(currentElements, sourceElements)
    ? mergeRefreshedParallelSlot(currentElements, sourceElements, keptSlotPathnames)
    : currentElements;
}

/**
 * The merge for a fan-out that renders the source page an intercepted state
 * names, its previousNextUrl, beside the other branches it keeps. That page's
 * render goes through mergeInterceptionSourceRefresh, every other branch
 * through mergeRefreshedParallelSlot. `track` marks a branch's render by the
 * path and search it was fetched from.
 */
export function createInterceptionSourceRefreshMerge(options: {
  basePath?: string;
  /**
   * The URL each slot of the state the fan-out refreshes was kept from (see
   * resolveKeptSlotPathnames), or null when it starts from another entry.
   */
  keptSlotPathnames?: ReadonlyMap<string, string> | null;
  previousNextUrl: string | null;
  refreshUrl: URL;
}): {
  merge: (current: AppElements, refreshed: AppElements) => AppElements;
  /**
   * Whether a payload takes the render fetched from this path. The source
   * page's goes beneath an intercept the server proved only, so a payload
   * without one, as a sibling intercept's, never waits for it. The whole
   * intercepting route takes only a render that can fill a slot it left.
   */
  takes: (pathAndSearch: string, primary: AppElements) => boolean;
  track: (pathAndSearch: string, elements: AppElements) => AppElements;
  /**
   * The fan-out's load of the branch fetched from this path, started beside
   * the payload. A payload that doesn't take it cancels that request and
   * merges nothing from it.
   */
  load: (
    pathAndSearch: string,
    primary: Promise<AppElements>,
    fetch: (signal: AbortSignal) => Promise<AppElements>,
  ) => (signal: AbortSignal) => Promise<AppElements>;
  /**
   * The load of a persisted intercept's render, fetched from the URL it was
   * intercepted at. The whole intercepting route takes it only to fill a slot
   * it left that shows that intercept.
   */
  loadIntercepted: (
    targetPathAndSearch: string,
    primary: Promise<AppElements>,
    fetch: (signal: AbortSignal) => Promise<AppElements>,
  ) => (signal: AbortSignal) => Promise<AppElements>;
} {
  const sourceUrl =
    options.previousNextUrl === null ? null : new URL(options.previousNextUrl, options.refreshUrl);
  const sourcePathAndSearch =
    sourceUrl === null ? null : `${sourceUrl.pathname}${sourceUrl.search}`;
  const basePath = options.basePath ?? "";
  const keptSlotPathnames = options.keptSlotPathnames ?? null;
  const sourceRenders = new WeakSet<AppElements>();
  // Whether the render fetched from this path can fill a slot the whole
  // intercepting route left: the render of the URL the client kept the slot
  // from or, for a fan-out that starts from another entry, which names no such
  // URL, the render of the source's.
  const fillsLeftSlot = (
    pathAndSearch: string,
    primary: AppElements,
    intercepted = false,
  ): boolean => {
    const leftSlotIds = leftMountedSlotIds(primary);
    if (leftSlotIds.length === 0) return false;
    if (keptSlotPathnames === null) return !intercepted && pathAndSearch === sourcePathAndSearch;
    const pathname = stripBasePath(new URL(pathAndSearch, options.refreshUrl).pathname, basePath);
    return leftSlotIds.some((slotId) => keptSlotPathnames.get(slotId) === pathname);
  };
  const takes = (pathAndSearch: string, primary: AppElements): boolean =>
    rendersWholeInterceptingRoute(primary)
      ? fillsLeftSlot(pathAndSearch, primary)
      : pathAndSearch !== sourcePathAndSearch ||
        AppElementsWire.readMetadata(primary).interception !== null;
  const track = (pathAndSearch: string, elements: AppElements): AppElements => {
    if (pathAndSearch === sourcePathAndSearch) sourceRenders.add(elements);
    return elements;
  };
  const loadIf =
    (
      takesPayload: (payload: AppElements) => boolean,
      finish: (elements: AppElements) => AppElements,
      primary: Promise<AppElements>,
      fetch: (signal: AbortSignal) => Promise<AppElements>,
    ) =>
    async (signal: AbortSignal): Promise<AppElements> => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      const request = fetch(controller.signal);
      void request.catch(() => {});
      try {
        let payload: AppElements;
        try {
          payload = await primary;
        } catch (error) {
          controller.abort();
          throw error;
        }
        if (!takesPayload(payload)) {
          controller.abort();
          return finish(payload);
        }
        return finish(await request);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    };
  return {
    load: (pathAndSearch, primary, fetch) =>
      loadIf(
        (payload) => takes(pathAndSearch, payload),
        (elements) => track(pathAndSearch, elements),
        primary,
        fetch,
      ),
    loadIntercepted: (targetPathAndSearch, primary, fetch) =>
      loadIf(
        (payload) =>
          !rendersWholeInterceptingRoute(payload) ||
          fillsLeftSlot(targetPathAndSearch, payload, true),
        (elements) => elements,
        primary,
        fetch,
      ),
    merge: (current, refreshed) =>
      sourceRenders.has(refreshed)
        ? mergeInterceptionSourceRefresh(current, refreshed, keptSlotPathnames)
        : keptSlotPathnames === null && rendersWholeInterceptingRoute(current)
          ? current
          : mergeRefreshedParallelSlot(current, refreshed, keptSlotPathnames),
    takes,
    track,
  };
}

// A payload for an intercepted route can leave the source page beneath it for
// the client to keep. A render of that page from its own URL supplies them,
// and nothing else: the intercepted payload's own entries stay its own.
export function supplyRetainedElements(
  currentElements: AppElements,
  refreshedElements: AppElements,
): AppElements {
  const currentMetadata = AppElementsWire.readMetadata(currentElements);
  if (currentMetadata.retainedElementIds.length === 0) return currentElements;
  const refreshedMetadata = AppElementsWire.readMetadata(refreshedElements);
  if (refreshedMetadata.routeId !== currentMetadata.routeId) return currentElements;
  // A streamed metadata body belongs to the head its render placed it beside,
  // so a payload that carries its own head takes no other render's body.
  const carriesHead = Object.hasOwn(
    currentElements,
    APP_ROUTE_HEAD_ID_PREFIX + currentMetadata.routeId,
  );
  const metadataBodyId = APP_STREAMING_METADATA_BODY_ID_PREFIX + currentMetadata.routeId;
  const suppliedIds = currentMetadata.retainedElementIds.filter(
    (id) =>
      !Object.hasOwn(currentElements, id) &&
      Object.hasOwn(refreshedElements, id) &&
      (id !== metadataBodyId || !carriesHead),
  );
  if (suppliedIds.length === 0) return currentElements;

  const merged: Record<string, AppElements[keyof AppElements]> = { ...currentElements };
  for (const id of suppliedIds) merged[id] = refreshedElements[id];
  const suppliedSlotIds = new Set(suppliedIds.filter((id) => AppElementsWire.isSlotId(id)));
  if (suppliedSlotIds.size > 0) {
    const slotBindings = currentMetadata.slotBindings.filter(
      (binding) => !suppliedSlotIds.has(binding.slotId),
    );
    slotBindings.push(
      ...refreshedMetadata.slotBindings.filter((binding) => suppliedSlotIds.has(binding.slotId)),
    );
    merged[APP_SLOT_BINDINGS_KEY] = normalizeAppElementsSlotBindings(slotBindings, {
      layoutIds: currentMetadata.layoutIds,
    });
  }
  copySlotIdentities(merged, currentElements, refreshedElements, suppliedIds);
  return merged;
}

// A slot's content and its BFCache segment entries are one unit. Keeping the
// base payload's entries (a default slot's, say) beside the slot's content
// would re-mint its ids and remount the client state a refresh keeps. The
// listed slots take their entries from slotElements, every other segment keeps
// baseElements' entries.
function copySlotIdentities(
  target: Record<string, AppElements[keyof AppElements]>,
  baseElements: AppElements,
  slotElements: AppElements,
  slotIds: readonly string[],
): void {
  const isSlotSegment = (id: string) =>
    slotIds.some((slotId) => id === slotId || isNestedBfcacheSlotSegmentIdFor(id, slotId));
  const isNestedSegment = (id: string) => !slotIds.includes(id) && isSlotSegment(id);
  for (const id of Object.keys(baseElements)) {
    if (isNestedSegment(id)) delete target[id];
  }
  for (const [id, element] of Object.entries(slotElements)) {
    if (isNestedSegment(id)) target[id] = element;
  }
  const identities: Record<string, string> = {};
  for (const [id, identity] of Object.entries(
    AppElementsWire.readMetadata(baseElements).bfcacheSegmentIdentities,
  )) {
    if (!isSlotSegment(id)) identities[id] = identity;
  }
  for (const [id, identity] of Object.entries(
    AppElementsWire.readMetadata(slotElements).bfcacheSegmentIdentities,
  )) {
    if (isSlotSegment(id)) identities[id] = identity;
  }
  if (Object.keys(identities).length > 0) target[APP_BFCACHE_SEGMENT_IDENTITIES_KEY] = identities;
  else delete target[APP_BFCACHE_SEGMENT_IDENTITIES_KEY];
}

// A layout or template and its BFCache segment entry are one unit, so the
// rendered payload's identity travels with its element.
function keepRenderedLayoutElements(
  target: Record<string, AppElements[keyof AppElements]>,
  renderedElements: AppElements,
): void {
  const renderedIdentities =
    AppElementsWire.readMetadata(renderedElements).bfcacheSegmentIdentities;
  const identities: Record<string, string> = {
    ...AppElementsWire.readMetadata(target).bfcacheSegmentIdentities,
  };
  for (const [elementId, element] of Object.entries(renderedElements)) {
    const kind = AppElementsWire.parseElementKey(elementId)?.kind;
    if (kind !== "layout" && kind !== "template") continue;
    target[elementId] = element;
    if (Object.hasOwn(renderedIdentities, elementId)) {
      identities[elementId] = renderedIdentities[elementId];
    } else {
      delete identities[elementId];
    }
  }
  if (Object.keys(identities).length > 0) target[APP_BFCACHE_SEGMENT_IDENTITIES_KEY] = identities;
  else delete target[APP_BFCACHE_SEGMENT_IDENTITIES_KEY];
}

function copyRefreshedBranchElements(
  target: Record<string, AppElements[keyof AppElements]>,
  refreshedElements: AppElements,
  options: { overwrite?: boolean } = {},
): void {
  for (const [elementId, element] of Object.entries(refreshedElements)) {
    const parsed = AppElementsWire.parseElementKey(elementId);
    // A route's head and its boundary fallbacks are their own entries, so
    // they travel with the route.
    const isHead = elementId.startsWith(APP_ROUTE_HEAD_ID_PREFIX);
    if (
      (parsed?.kind === "page" ||
        parsed?.kind === "route" ||
        isHead ||
        elementId.startsWith(APP_ROUTE_FALLBACK_ID_PREFIX)) &&
      (options.overwrite !== false || !Object.hasOwn(target, elementId))
    ) {
      target[elementId] = element;
      // The head's streamed body goes with it, or none when its render
      // placed none.
      if (isHead) {
        const bodyId =
          APP_STREAMING_METADATA_BODY_ID_PREFIX + elementId.slice(APP_ROUTE_HEAD_ID_PREFIX.length);
        if (Object.hasOwn(refreshedElements, bodyId)) target[bodyId] = refreshedElements[bodyId];
        else delete target[bodyId];
      }
    }
  }
}

export function resolvePersistedSourcePageRefreshes(options: {
  activeRoutePaths?: readonly string[];
  basePath: string;
  refreshUrl: URL;
  state: Pick<AppRouterState, "previousNextUrl" | "slotBindings"> &
    Partial<Pick<AppRouterState, "elements">>;
}): string[] {
  const sourceUrlsByPathname = new Map<string, URL>();
  const refreshRoutePathname = removeTrailingSlash(
    normalizePath(
      normalizePathnameForRouteMatch(stripBasePath(options.refreshUrl.pathname, options.basePath)),
    ),
  );
  // A state showing the whole intercepting route holds nothing of its source,
  // nor does one opened from an unmatched URL's not-found page, which renders
  // that route whole, nor a sibling intercept's, the intercepting route's own
  // page.
  if (
    options.state.previousNextUrl !== null &&
    !isRouteMissInterceptionSource(options.state.previousNextUrl, options.basePath) &&
    (options.state.elements === undefined ||
      (!rendersWholeInterceptingRoute(options.state.elements) &&
        !rendersSiblingIntercept(AppElementsWire.readMetadata(options.state.elements))))
  ) {
    const sourceUrl = new URL(options.state.previousNextUrl, options.refreshUrl);
    sourceUrlsByPathname.set(sourceUrl.pathname, sourceUrl);
  }

  // The browser pathname of the refresh, compared as it is with the refresh
  // pathnames bindings record, which are browser pathnames too.
  const refreshRequestPathname = removeTrailingSlash(
    stripBasePath(options.refreshUrl.pathname, options.basePath),
  );

  // Each path is a binding's refresh pathname, the URL of the navigation that
  // rendered the slot, or its route path when it has none. The slots the
  // current page rendered carry the refresh URL itself, so the last filter
  // below leaves them to the refresh request, as Next.js refetches only a
  // reused segment's URL that differs from the current one.
  const activeRoutePaths =
    options.activeRoutePaths ?? resolveActiveRoutePaths(options.state.slotBindings);
  for (const activeRoutePath of activeRoutePaths) {
    // A deeper children route can remain in the merged client tree after the
    // user navigates back to its ancestor for cache reuse. It is not a visible
    // parallel branch of that ancestor, so refreshing it would hold the real
    // refresh open and repeatedly replace the ancestor DOM. Persisted visible
    // branches are ancestors or siblings of the current route instead.
    if (
      isDescendantPathname(activeRoutePath, refreshRequestPathname) ||
      isDescendantPathname(activeRoutePath, refreshRoutePathname)
    ) {
      continue;
    }
    const pathname = restoreBasePath(activeRoutePath, options.basePath);
    if (sourceUrlsByPathname.has(pathname)) continue;
    const sourceUrl = new URL(pathname, options.refreshUrl);
    // History state is page-writable: never refetch another origin.
    if (sourceUrl.origin !== options.refreshUrl.origin) continue;
    sourceUrl.search = options.refreshUrl.search;
    sourceUrlsByPathname.set(pathname, sourceUrl);
  }

  const refreshPathAndSearch = `${options.refreshUrl.pathname}${options.refreshUrl.search}`;
  const resolved: string[] = [];
  for (const sourceUrl of sourceUrlsByPathname.values()) {
    const pathAndSearch = `${sourceUrl.pathname}${sourceUrl.search}`;
    if (pathAndSearch !== refreshPathAndSearch) resolved.push(pathAndSearch);
  }
  return resolved;
}

function isDescendantPathname(pathname: string, ancestor: string): boolean {
  return pathname !== ancestor && (ancestor === "/" || pathname.startsWith(ancestor + "/"));
}

export type PersistedRefreshInterception = {
  interception: BrowserRouteManifestInterception;
  interceptionContext: string;
  targetPathname: string;
};

function getMatchedUrlPathname(matchedUrl: string): string {
  return new URL(matchedUrl, "https://vinext.local").pathname;
}

export function resolvePersistedRefreshInterceptions(options: {
  basePath: string;
  refreshUrl: URL;
  requestInterceptionContext: string | null;
  routeManifest: BrowserRouteManifest | null;
  state: Pick<AppRouterState, "interception" | "slotBindings">;
}): PersistedRefreshInterception[] {
  const { basePath, refreshUrl, requestInterceptionContext, routeManifest, state } = options;
  if (routeManifest === null) return [];

  const refreshPathname = stripBasePath(refreshUrl.pathname, basePath);
  const refreshPathParts = splitPathnameForRouteMatch(refreshPathname);
  const resolved: PersistedRefreshInterception[] = [];

  for (const binding of state.slotBindings) {
    if (binding.state !== "active" || !binding.activeRouteId) continue;
    if (!binding.interceptionId || !binding.interceptionSourceMatchedUrl) continue;
    const activeRoute = AppElementsWire.parseElementKey(binding.activeRouteId);
    if (activeRoute?.kind !== "route") continue;
    const match = routeManifest.segmentGraph.interceptions.get(binding.interceptionId);
    if (!match) continue;

    const retainedInterception =
      state.interception?.slotId === binding.slotId &&
      matchRoutePattern(
        splitPathnameForRouteMatch(getMatchedUrlPathname(state.interception.targetMatchedUrl)),
        match.targetPatternParts,
      ) !== null
        ? state.interception
        : null;
    // The URL the slot was intercepted at, which the refresh asks for again
    // with the same interception context, as resolvePersistedSourcePageRefreshes
    // names the same slot. A matched or route path would be rewritten again,
    // or decoded once more.
    const targetPathname =
      binding.refreshPathname ?? retainedInterception?.targetMatchedUrl ?? activeRoute.path;
    const targetParts = splitPathnameForRouteMatch(getMatchedUrlPathname(targetPathname));
    const isPrimaryRefreshInterception =
      requestInterceptionContext !== null &&
      state.interception?.slotId === binding.slotId &&
      matchRoutePattern(refreshPathParts, match.targetPatternParts) !== null &&
      matchRoutePattern(targetParts, match.targetPatternParts) !== null;
    if (isPrimaryRefreshInterception) continue;

    const targetUrl = new URL(targetPathname, refreshUrl);
    targetUrl.pathname = restoreBasePath(targetUrl.pathname, basePath);
    targetUrl.search = refreshUrl.search;
    resolved.push({
      interception: match,
      interceptionContext:
        retainedInterception?.sourceMatchedUrl ?? binding.interceptionSourceMatchedUrl,
      targetPathname: `${targetUrl.pathname}${targetUrl.search}`,
    });
  }

  return resolved;
}

export function createSupplementalRefreshCoordinator(): {
  abortAll(): void;
  begin(options: {
    activeNavigationId: number;
    startedNavigationId: number;
  }): SupplementalRefreshHandle;
} {
  const controllers = new Set<AbortController>();
  return {
    abortAll() {
      for (const controller of controllers) controller.abort();
    },
    begin(options) {
      const controller = new AbortController();
      controllers.add(controller);
      if (options.activeNavigationId !== options.startedNavigationId) controller.abort();
      return {
        finish() {
          controllers.delete(controller);
        },
        signal: controller.signal,
      };
    },
  };
}

export async function resolveSupplementalRefreshes<T>(options: {
  merge: (current: Awaited<T>, supplemental: Awaited<T>) => Awaited<T>;
  /** Whether the primary takes the supplemental renders at all. */
  mergesInto?: (primary: Awaited<T>) => boolean;
  primary: Promise<T>;
  signal: AbortSignal;
  supplemental: ReadonlyArray<(signal: AbortSignal) => Promise<T>>;
  timeoutMs?: number;
}): Promise<SupplementalRefreshResult<T>> {
  if (options.supplemental.length === 0) {
    return { degraded: false, value: await options.primary };
  }

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) {
    abort();
  } else {
    options.signal.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Supplemental refresh timed out", "TimeoutError")),
    options.timeoutMs ?? SUPPLEMENTAL_REFRESH_TIMEOUT_MS,
  );

  try {
    if (controller.signal.aborted) {
      return { degraded: true, reason: "aborted", value: await options.primary };
    }
    const supplemental = Promise.all(options.supplemental.map((load) => load(controller.signal)));
    if (options.mergesInto) {
      // The primary decides first, so a supplemental render it doesn't take
      // can neither fail nor delay it.
      void supplemental.catch(() => {});
      const primary = await options.primary;
      if (!options.mergesInto(primary)) {
        controller.abort();
        return { degraded: false, value: primary };
      }
    }
    const [primary, supplementalValues] = await Promise.all([options.primary, supplemental]);
    let value = primary;
    for (const supplementalValue of supplementalValues) {
      value = options.merge(value, supplementalValue);
    }
    return { degraded: false, value };
  } catch {
    const reason: SupplementalRefreshDegradedReason = options.signal.aborted
      ? "aborted"
      : controller.signal.reason instanceof DOMException &&
          controller.signal.reason.name === "TimeoutError"
        ? "timeout"
        : "failed";
    controller.abort();
    return { degraded: true, reason, value: await options.primary };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}
