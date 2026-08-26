import { getRequestExecutionContext } from "./request-context.js";

export const CACHEABILITY_REQUEST_STATE = Symbol.for("vinext.cacheabilityRequestState");

export type RouteCacheabilityOutcome = {
  cacheControl?: string;
  cacheable: boolean;
  classificationFailure?: boolean;
  dynamicUsage?: boolean;
  reason?: string;
  tags?: readonly string[];
};

export type RouteCacheabilityState = {
  captureDeadlineAt: number;
  complete?: (outcome: RouteCacheabilityOutcome) => void;
  completion?: Promise<RouteCacheabilityOutcome>;
  forcedDynamicReason?: string;
  mode: "identity" | "probe";
  outcome?: RouteCacheabilityOutcome;
  route?: {
    kind: "app-page";
    pattern: string;
  };
};

export function readRouteCacheabilityState(): RouteCacheabilityState | null {
  const context = getRequestExecutionContext();
  if (!context) return null;
  return (
    (Reflect.get(context, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState | undefined) ?? null
  );
}

export function beginRouteCacheability(kind: "app-page", pattern: string): boolean {
  const state = readRouteCacheabilityState();
  if (!state) return false;
  state.route = { kind, pattern };
  return true;
}

/** Prevent shared caching when request processing before route dispatch was request-specific. */
export function markRouteCacheabilityDynamic(reason: string): void {
  const state = readRouteCacheabilityState();
  if (!state) return;
  state.forcedDynamicReason = reason;
}

/** True only for an authenticated probe that must render the matched App Page. */
export function isRouteCacheabilityProbe(): boolean {
  return readRouteCacheabilityState()?.mode === "probe";
}

/** True for the authenticated routing pass that must not evaluate user components. */
export function isRouteCacheabilityIdentityProbe(): boolean {
  return readRouteCacheabilityState()?.mode === "identity";
}

/** True for every side-effect-free staged Worker observation request. */
export function isStagedCacheabilityProbeActive(): boolean {
  const mode = readRouteCacheabilityState()?.mode;
  return mode === "probe" || mode === "identity";
}

export function deferRouteCacheability(): ((outcome: RouteCacheabilityOutcome) => void) | null {
  const state = readRouteCacheabilityState();
  if (!state?.route || state.completion) return null;

  state.completion = new Promise<RouteCacheabilityOutcome>((resolve) => {
    state.complete = (outcome) => {
      const resolvedOutcome = state.forcedDynamicReason
        ? {
            cacheable: false,
            dynamicUsage: true,
            reason: state.forcedDynamicReason,
          }
        : outcome;
      state.outcome = resolvedOutcome;
      resolve(resolvedOutcome);
    };
  });
  return (outcome) => state.complete?.(outcome);
}

export function recordRouteCacheability(outcome: RouteCacheabilityOutcome): void {
  const state = readRouteCacheabilityState();
  if (!state?.route) return;
  const resolvedOutcome = state.forcedDynamicReason
    ? {
        cacheable: false,
        dynamicUsage: true,
        reason: state.forcedDynamicReason,
      }
    : outcome;
  state.outcome = resolvedOutcome;
  state.complete?.(resolvedOutcome);
}
