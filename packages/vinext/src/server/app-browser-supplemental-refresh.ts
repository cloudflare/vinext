import {
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_INTERCEPTION_KEY,
  APP_SLOT_BINDINGS_KEY,
  AppElementsWire,
  normalizeAppElementsSlotBindings,
  type AppElements,
  type AppElementsSlotBinding,
} from "./app-elements.js";
import type { AppRouterState } from "./app-browser-state.js";
import { addBasePathToPathname, stripBasePath } from "../utils/base-path.js";

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

export function mergeRefreshedParallelSlot(
  currentElements: AppElements,
  refreshedElements: AppElements,
): AppElements {
  const refreshedMetadata = AppElementsWire.readMetadata(refreshedElements);
  const interception = refreshedMetadata.interception;
  if (interception === null) {
    const refreshedBindings = refreshedMetadata.slotBindings.filter(
      (binding) => binding.state === "active" && Object.hasOwn(refreshedElements, binding.slotId),
    );
    if (refreshedBindings.length === 0) return currentElements;

    const currentMetadata = AppElementsWire.readMetadata(currentElements);
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
            }),
        [APP_SLOT_BINDINGS_KEY]: normalizeAppElementsSlotBindings(slotBindings, {
          layoutIds: refreshedMetadata.layoutIds,
        }),
      };
      for (const binding of retainedBindings) {
        merged[binding.slotId] = currentElements[binding.slotId];
      }
      if (promotedBindings.length === 1) {
        merged[promotedBindings[0].slotId] = refreshedElements[refreshedChildrenBindings[0].slotId];
      }
      copyRefreshedBranchElements(merged, currentElements, { overwrite: false });
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
    copyRefreshedBranchElements(merged, refreshedElements);
    return merged;
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
  copyRefreshedBranchElements(merged, refreshedElements);
  return merged;
}

function copyRefreshedBranchElements(
  target: Record<string, AppElements[keyof AppElements]>,
  refreshedElements: AppElements,
  options: { overwrite?: boolean } = {},
): void {
  for (const [elementId, element] of Object.entries(refreshedElements)) {
    const parsed = AppElementsWire.parseElementKey(elementId);
    if (
      (parsed?.kind === "page" || parsed?.kind === "route") &&
      (options.overwrite !== false || !Object.hasOwn(target, elementId))
    ) {
      target[elementId] = element;
    }
  }
}

export function resolvePersistedSourcePageRefreshes(options: {
  activeRoutePaths?: readonly string[];
  basePath: string;
  refreshUrl: URL;
  state: Pick<AppRouterState, "previousNextUrl" | "slotBindings">;
}): string[] {
  const sourceUrlsByPathname = new Map<string, URL>();
  const refreshRoutePathname = stripBasePath(options.refreshUrl.pathname, options.basePath);
  if (options.state.previousNextUrl !== null) {
    const sourceUrl = new URL(options.state.previousNextUrl, options.refreshUrl);
    sourceUrlsByPathname.set(sourceUrl.pathname, sourceUrl);
  }

  const activeRoutePaths =
    options.activeRoutePaths ??
    options.state.slotBindings.flatMap((binding) => {
      if (binding.state !== "active" || binding.activeRouteId == null) return [];
      const activeRoute = AppElementsWire.parseElementKey(binding.activeRouteId);
      return activeRoute?.kind === "route" && activeRoute.interceptionContext === null
        ? [activeRoute.path]
        : [];
    });
  for (const activeRoutePath of activeRoutePaths) {
    // A deeper children route can remain in the merged client tree after the
    // user navigates back to its ancestor for cache reuse. It is not a visible
    // parallel branch of that ancestor, so refreshing it would hold the real
    // refresh open and repeatedly replace the ancestor DOM. Persisted visible
    // branches are ancestors or siblings of the current route instead.
    if (
      activeRoutePath !== refreshRoutePathname &&
      (refreshRoutePathname === "/" || activeRoutePath.startsWith(refreshRoutePathname + "/"))
    ) {
      continue;
    }
    const pathname = addBasePathToPathname(activeRoutePath, options.basePath);
    if (sourceUrlsByPathname.has(pathname)) continue;
    const sourceUrl = new URL(pathname, options.refreshUrl);
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
    const supplemental = options.supplemental.map((load) => load(controller.signal));
    const [primary, supplementalValues] = await Promise.all([
      options.primary,
      Promise.all(supplemental),
    ]);
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
