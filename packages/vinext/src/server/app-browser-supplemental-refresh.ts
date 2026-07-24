import {
  APP_SLOT_BINDINGS_KEY,
  AppElementsWire,
  normalizeAppElementsSlotBindings,
  type AppElements,
  type AppElementsSlotBinding,
} from "./app-elements.js";
import type { AppRouterState } from "./app-browser-state.js";
import { addBasePathToPathname } from "../utils/base-path.js";

const APP_BROWSER_SUPPLEMENTAL_REFRESH_TIMEOUT_MS = 10_000;

export type SupplementalRefreshResult<T> = {
  degraded: boolean;
  value: Awaited<T>;
};

export type SupplementalRefreshHandle = {
  finish(): void;
  signal: AbortSignal;
};

export function mergeRefreshedInterceptedSlot(
  currentElements: AppElements,
  interceptedElements: AppElements,
): AppElements {
  const interceptedMetadata = AppElementsWire.readMetadata(interceptedElements);
  const interception = interceptedMetadata.interception;
  if (interception === null) {
    const sourcePageBinding = interceptedMetadata.slotBindings.find((binding) => {
      const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
      return (
        binding.state === "active" &&
        parsedSlot?.kind === "slot" &&
        parsedSlot.name === "children" &&
        Object.hasOwn(interceptedElements, binding.slotId)
      );
    });
    if (!sourcePageBinding) return currentElements;
    const currentMetadata = AppElementsWire.readMetadata(currentElements);
    const slotBindings = currentMetadata.slotBindings.filter(
      (binding) => binding.slotId !== sourcePageBinding.slotId,
    );
    slotBindings.push(sourcePageBinding);
    return {
      ...currentElements,
      [sourcePageBinding.slotId]: interceptedElements[sourcePageBinding.slotId],
      [APP_SLOT_BINDINGS_KEY]: normalizeAppElementsSlotBindings(slotBindings, {
        layoutIds: currentMetadata.layoutIds,
      }),
    };
  }
  const interceptedSlot = interceptedElements[interception.slotId];
  if (interceptedSlot === undefined) return currentElements;

  const currentMetadata = AppElementsWire.readMetadata(currentElements);
  const interceptedBinding = interceptedMetadata.slotBindings.find(
    (binding) => binding.slotId === interception.slotId,
  );
  const slotBindings: AppElementsSlotBinding[] = currentMetadata.slotBindings.filter(
    (binding) => binding.slotId !== interception.slotId,
  );
  // The supplemental payload is rendered for the same persisted slot owner,
  // so its ownerLayoutId is present in the primary payload's __layoutIds.
  // Keep the primary layout-id table while replacing only that slot binding.
  if (interceptedBinding) slotBindings.push(interceptedBinding);

  return {
    ...currentElements,
    [interception.slotId]: interceptedSlot,
    [APP_SLOT_BINDINGS_KEY]: slotBindings,
  };
}

export function resolvePersistedSourcePageRefresh(options: {
  basePath: string;
  refreshUrl: URL;
  state: Pick<AppRouterState, "previousNextUrl" | "slotBindings">;
}): string | null {
  let sourceUrl: URL;
  if (options.state.previousNextUrl !== null) {
    sourceUrl = new URL(options.state.previousNextUrl, options.refreshUrl);
  } else {
    const sourcePageBinding = options.state.slotBindings.find((binding) => {
      const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
      if (
        binding.state === "active" &&
        parsedSlot?.kind === "slot" &&
        parsedSlot.name === "children" &&
        binding.activeRouteId != null
      ) {
        const activeRoute = AppElementsWire.parseElementKey(binding.activeRouteId);
        if (
          activeRoute?.kind !== "route" ||
          addBasePathToPathname(activeRoute.path, options.basePath) === options.refreshUrl.pathname
        ) {
          return false;
        }
        return options.state.slotBindings.some(
          (candidate) =>
            candidate.state === "active" &&
            candidate.ownerLayoutId === binding.ownerLayoutId &&
            candidate.slotId !== binding.slotId &&
            candidate.activeRouteId != null &&
            candidate.activeRouteId !== binding.activeRouteId,
        );
      }
      return false;
    });
    const activeRoute = sourcePageBinding?.activeRouteId
      ? AppElementsWire.parseElementKey(sourcePageBinding.activeRouteId)
      : null;
    if (activeRoute?.kind !== "route") return null;
    sourceUrl = new URL(
      addBasePathToPathname(activeRoute.path, options.basePath),
      options.refreshUrl,
    );
    sourceUrl.search = options.refreshUrl.search;
  }
  if (
    sourceUrl.pathname === options.refreshUrl.pathname &&
    sourceUrl.search === options.refreshUrl.search
  ) {
    return null;
  }
  return `${sourceUrl.pathname}${sourceUrl.search}`;
}

export function resolveNavigationSourcePageRefresh(options: {
  basePath: string;
  navigationKind: "refresh" | "traverse";
  refreshUrl: URL;
  requestPreviousNextUrl: string | null;
  state: Pick<AppRouterState, "interception" | "previousNextUrl" | "slotBindings">;
  targetHistoryBfcacheIds: Readonly<Record<string, string>> | null;
}): string | null {
  if (options.navigationKind === "refresh") {
    return resolvePersistedSourcePageRefresh(options);
  }

  // A traversal restores the target history entry, so only that entry can
  // identify an intercepted source page. A non-intercepted parallel route may
  // recover its owned children source below, but an intercepted router state
  // being left must not influence a cache-miss response.
  if (options.requestPreviousNextUrl === null) {
    const sourcePageBinding = options.state.slotBindings.find((binding) => {
      const parsedSlot = AppElementsWire.parseElementKey(binding.slotId);
      if (
        binding.state !== "active" ||
        parsedSlot?.kind !== "slot" ||
        parsedSlot.name !== "children" ||
        binding.activeRouteId == null
      ) {
        return false;
      }
      const activeRoute = AppElementsWire.parseElementKey(binding.activeRouteId);
      if (activeRoute?.kind !== "route") return false;
      return Object.keys(options.targetHistoryBfcacheIds ?? {}).some((id) => {
        const targetSegment = AppElementsWire.parseElementKey(id);
        return targetSegment?.kind === "page" && targetSegment.path === activeRoute.path;
      });
    });
    const mayRecoverNonInterceptedParallelSource =
      options.state.previousNextUrl === null && options.state.interception === null;
    if (sourcePageBinding === undefined && !mayRecoverNonInterceptedParallelSource) return null;
    return resolvePersistedSourcePageRefresh({
      ...options,
      state: { previousNextUrl: null, slotBindings: options.state.slotBindings },
    });
  }
  const sourceUrl = new URL(options.requestPreviousNextUrl, options.refreshUrl);
  if (
    sourceUrl.pathname === options.refreshUrl.pathname &&
    sourceUrl.search === options.refreshUrl.search
  ) {
    return null;
  }
  return `${sourceUrl.pathname}${sourceUrl.search}`;
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

export function shouldScheduleSupplementalRefreshRecovery(options: {
  activeNavigationId: number;
  degraded: boolean;
  recoveryAttempt?: boolean;
  startedNavigationId: number;
}): boolean {
  return (
    options.degraded &&
    !options.recoveryAttempt &&
    options.activeNavigationId === options.startedNavigationId
  );
}

export function settleSuccessfulServerActionResult<T>(options: {
  navigation: Promise<unknown>;
  onNavigationFailure: () => void;
  value: T;
}): Promise<T> {
  void options.navigation.catch(() => {
    options.onNavigationFailure();
  });
  return Promise.resolve(options.value);
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
    options.timeoutMs ?? APP_BROWSER_SUPPLEMENTAL_REFRESH_TIMEOUT_MS,
  );

  try {
    if (controller.signal.aborted) {
      return { degraded: true, value: await options.primary };
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
    return {
      degraded: false,
      value,
    };
  } catch {
    controller.abort();
    return { degraded: true, value: await options.primary };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}
