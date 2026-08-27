import { getRequestExecutionContext } from "./request-context.js";

export const CACHEABILITY_REQUEST_STATE = Symbol.for("vinext.cacheabilityRequestState");

export const CACHEABILITY_POLICY_HEADERS = [
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
] as const;

type CacheabilityPolicyHeader = (typeof CACHEABILITY_POLICY_HEADERS)[number];

export type RouteCacheabilityOutcome = {
  cacheControl?: string;
  cacheable: boolean;
  classificationFailure?: boolean;
  dynamicUsage?: boolean;
  reason?: string;
  tags?: readonly string[];
};

export type RouteCacheabilityState = {
  admission?: {
    manifest?: unknown;
    policy: "deny" | "manifest" | "runtime";
    representation?: string;
    requestKey?: string;
    routePathname?: string;
  };
  /** Optional admission budget override used by focused runtime tests. */
  captureBudget?: { maxBytes: number; reservedBytes: number };
  captureDeadlineAt: number;
  complete?: (outcome: RouteCacheabilityOutcome) => void;
  completion?: Promise<RouteCacheabilityOutcome>;
  completedResponseBody?: boolean;
  explicitConfigCachePolicy?: boolean;
  explicitResponseCachePolicy?: boolean;
  finalResponseVetoReason?: string;
  forcedDynamicReason?: string;
  /** A route-config decision that applies to every concrete identity for this pattern. */
  patternDynamicReason?: string;
  frameworkResponseCachePolicy?: Partial<Record<CacheabilityPolicyHeader, string>>;
  mode: "admit" | "identity" | "probe";
  outcome?: RouteCacheabilityOutcome;
  preserveResponseCachePolicy?: boolean;
  /** Cache-key behavior declared by the active CDN adapter. */
  responseVary?: "verbatim";
  probeBailout?: {
    kind: "private-cache";
    outcome: RouteCacheabilityOutcome;
  };
  route?: {
    kind: "app-page" | "app-route" | "pages-page";
    pattern: string;
  };
};

/** Preserve the existing policy when hybrid routing hands the request to Pages Router. */
export function preserveRouteCacheabilityResponsePolicy(): void {
  const state = readRouteCacheabilityState();
  if (!state || state.mode !== "admit") return;
  if (state.route?.kind === "pages-page") return;
  state.preserveResponseCachePolicy = true;
}

export function readRouteCacheabilityState(): RouteCacheabilityState | null {
  const context = getRequestExecutionContext();
  if (!context) return null;
  return (
    (Reflect.get(context, CACHEABILITY_REQUEST_STATE) as RouteCacheabilityState | undefined) ?? null
  );
}

export function beginRouteCacheability(
  kind: "app-page" | "app-route" | "pages-page",
  pattern: string,
): boolean {
  const state = readRouteCacheabilityState();
  if (!state) return false;
  state.route = { kind, pattern };
  if (kind === "pages-page") {
    // App routing preserves an independently handled Pages response while the
    // request is in transit. Once Pages classification begins, this layer owns
    // admission and must fail unlisted or request-specific identities closed.
    state.preserveResponseCachePolicy = false;
  }
  return true;
}

/** Prevent shared caching when request processing before route dispatch was request-specific. */
export function markRouteCacheabilityDynamic(reason: string): void {
  const state = readRouteCacheabilityState();
  if (!state) return;
  state.forcedDynamicReason = reason;
}

/** Mark an effective route configuration that makes the whole pattern dynamic. */
export function markRouteCacheabilityPatternDynamic(reason: string): void {
  const state = readRouteCacheabilityState();
  if (!state) return;
  state.patternDynamicReason = reason;
}

/** Read a request-specific routing veto without making the route globally dynamic. */
export function getRouteCacheabilityDynamicReason(): string | null {
  return readRouteCacheabilityState()?.forcedDynamicReason ?? null;
}

/** Reuse the active request's bounded response-capture envelope when available. */
export function getRouteCacheabilityCaptureOptions(): Pick<
  RouteCacheabilityState,
  "captureBudget" | "captureDeadlineAt"
> | null {
  const state = readRouteCacheabilityState();
  return state
    ? { captureBudget: state.captureBudget, captureDeadlineAt: state.captureDeadlineAt }
    : null;
}

/** Keep a completed response private without treating it as static-to-dynamic. */
export function markRouteCacheabilityFinalResponseUncacheable(reason: string): void {
  const state = readRouteCacheabilityState();
  if (!state || state.mode !== "admit") return;
  state.finalResponseVetoReason ??= reason;
}

/** Record that next.config explicitly owns the final response cache policy. */
export function markRouteCacheabilityExplicitConfigPolicy(): void {
  const state = readRouteCacheabilityState();
  if (!state) return;
  state.explicitConfigCachePolicy = true;
}

/** Record a public cache policy supplied by the Route Handler itself. */
export function markRouteCacheabilityExplicitResponsePolicy(): void {
  const state = readRouteCacheabilityState();
  if (!state || state.mode !== "admit") return;
  state.explicitResponseCachePolicy = true;
}

/** Record that the response body reached clean EOF and is now a replay stream. */
export function markRouteCacheabilityResponseBodyComplete(): void {
  const state = readRouteCacheabilityState();
  if (!state) return;
  state.completedResponseBody = true;
}

/** Record framework-owned policy so admission can identify policy added later. */
export function captureRouteCacheabilityResponsePolicy(headers: Headers): void {
  const state = readRouteCacheabilityState();
  if (!state || state.mode !== "admit") return;

  const policy: Partial<Record<CacheabilityPolicyHeader, string>> = {};
  for (const name of CACHEABILITY_POLICY_HEADERS) {
    const value = headers.get(name);
    if (value !== null) policy[name] = value;
  }
  // Framework response shaping has more than one trusted phase. In
  // particular, the App Page renderer can leave Cache-Control absent before
  // the outer response finalizer applies the adapter's provisional no-store
  // default. Keep the latest trusted snapshot; configurable response headers
  // run after the final capture and remain visible to the strict admission
  // comparison below.
  state.frameworkResponseCachePolicy = policy;
}

/** True only for an authenticated probe that must render the matched App Page. */
export function isRouteCacheabilityProbe(): boolean {
  return readRouteCacheabilityState()?.mode === "probe";
}

/** True when the outer Worker must decide cache admission after clean EOF. */
export function isRouteCacheabilityEvaluation(): boolean {
  const mode = readRouteCacheabilityState()?.mode;
  return mode === "probe" || mode === "admit";
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

export function recordRouteCacheabilityProbeBailout(
  kind: "private-cache",
  outcome: RouteCacheabilityOutcome,
): void {
  const state = readRouteCacheabilityState();
  if (state?.mode !== "probe" || !state.route) return;
  state.probeBailout = { kind, outcome };
  state.outcome = outcome;
  state.complete?.(outcome);
}
