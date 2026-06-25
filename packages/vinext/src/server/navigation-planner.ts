import {
  matchRoutePattern,
  matchRoutePatternPrefix,
  matchRoutePatternWithOptionalDynamicSegments,
} from "../routing/route-pattern.js";
import { splitPathnameForRouteMatch } from "../routing/utils.js";
import { stripBasePath } from "../utils/base-path.js";
import type {
  RouteManifest,
  RouteManifestInterception,
  RouteManifestRoute,
} from "../routing/app-route-graph.js";
import { compareAppElementsSlotIds, type AppElementsSlotBinding } from "./app-elements.js";
import {
  resolveRscRedirectLifecycleHop,
  resolveStreamedRscRedirectLifecycleHop,
} from "./app-browser-rsc-redirect.js";
import {
  resolveHardNavigationTargetFromRscResponse,
  resolveRscCompatibilityNavigationDecision,
} from "./app-rsc-cache-busting.js";
import type {
  CacheEntryReuseDecision,
  CacheEntryReuseProof,
  CacheProofRejectionCode,
} from "./cache-proof.js";
import {
  NavigationTraceReasonCodes,
  createNavigationLifecycleTraceFields,
  createNavigationTrace,
  type NavigationTrace,
  type NavigationTraceFields,
  type NavigationTraceReasonCode,
} from "./navigation-trace.js";
import {
  verifyOperationTokenForCacheReuse,
  type OperationLane,
  type OperationToken,
  type OperationTokenRejectionReason,
} from "./operation-token.js";

// OperationToken and OperationLane are owned by ./operation-token.ts, the token
// authority module. Re-exported here so the planner stays the single import
// surface for navigation types.
export type { OperationLane, OperationToken } from "./operation-token.js";

export type RouteSnapshot = {
  interception: InterceptionSnapshot | null;
  interceptionContext: string | null;
  routeId: string;
  // Ordered ancestor-first, with the root layout at index 0. Same-layout
  // persistence uses prefix comparison, so callers must preserve this order.
  layoutIds: readonly string[];
  mountedParallelSlots: readonly MountedParallelSlotSnapshot[];
  rootBoundaryId: string | null;
  displayUrl: string;
  matchedUrl: string;
  slotBindings: readonly ParallelSlotBindingSnapshot[];
};

export type InterceptionSnapshot = {
  sourceMatchedUrl: string;
  sourceRouteId: string;
  slotId: string;
  targetMatchedUrl: string;
  targetRouteId: string;
};

export type MountedParallelSlotSnapshot = {
  slotId: string;
  ownerLayoutId: string | null;
};

// Planner snapshots consume the same canonical slot-binding facts decoded from
// AppElements metadata. Keep the alias explicit so route-state and transport
// readers cannot drift into structurally identical but semantically separate
// shapes.
export type ParallelSlotBindingSnapshot = AppElementsSlotBinding;

export type NavigationPlannerState = {
  // A single state shape lets intent events and result events move through one
  // planner surface. flightResponseArrived uses event.token; later #726 slices
  // can split this by event kind once more result paths are routed through the
  // planner.
  nextOperationToken: OperationToken;
  // Callers that have lifecycle authority should pass the complete trace
  // context. When absent, the planner emits the stable root-boundary facts it
  // can derive from the event and visible snapshot.
  traceFields?: NavigationTraceFields;
  visibleCommitVersion: number;
  visibleSnapshot: RouteSnapshot;
};

export type RefreshScope = "visible";
export type TraverseDirection = "back" | "forward" | "unknown";

export type NavigationEvent =
  | { kind: "navigate"; href: string; mode: "push" | "replace" }
  | { kind: "refresh"; scope: RefreshScope }
  | { kind: "traverse"; direction: TraverseDirection; historyState: unknown }
  | { kind: "prefetch"; href: string }
  | { kind: "flightResponseArrived"; token: OperationToken; result: FlightResult };

type RequestedWork =
  | { kind: "flight"; href: string; mode: "push" | "replace" | "refresh" }
  | { direction: TraverseDirection; historyState: unknown; kind: "traverseFlight" }
  | { kind: "prefetch"; href: string };

type CommitProposal = {
  cacheEntryReuseDecision?: AcceptedCacheEntryReuseDecision;
  preserveAbsentSlots: boolean;
  preserveElementIds: readonly string[];
  preservePreviousSlotIds: readonly string[];
  reason: "currentRootBoundary" | "interceptedCurrentRootBoundary" | "unprovenTopologyFallback";
  targetSnapshot: RouteSnapshot;
};

type NoCommitReason = "prefetchOnly";
type HardNavigationReason =
  | "cacheProofRejected"
  | "cacheReuseTokenRejected"
  | "interceptionProofRejected"
  | "rootBoundaryChanged";
export type RootBoundaryTransition =
  | "currentRootBoundary"
  | "rootBoundaryChanged"
  | "rootBoundaryUnknown";

export type NavigationDecision =
  | {
      kind: "requestWork";
      token: OperationToken;
      work: RequestedWork;
      trace: NavigationTrace;
    }
  | {
      kind: "proposeCommit";
      token: OperationToken;
      proposal: CommitProposal;
      trace: NavigationTrace;
    }
  | {
      kind: "noCommit";
      token: OperationToken;
      reason: NoCommitReason;
      trace: NavigationTrace;
    }
  | {
      kind: "hardNavigate";
      token: OperationToken;
      url: string;
      reason: HardNavigationReason;
      trace: NavigationTrace;
    };

export type FlightResult = {
  cacheEntryReuseProof?: CacheEntryReuseProof;
  href: string;
  targetSnapshot: RouteSnapshot;
};

type RscFetchResultSource = "cached" | "live";
type RscRedirectSignal = "response-url" | "streamed-header";

export type RscFetchResultFacts = {
  source: RscFetchResultSource;
  currentHref: string;
  origin: string;
  effectiveHistoryUpdateMode: "push" | "replace";
  redirectDepth: number;
  requestPreviousNextUrl: string | null;
  clientCompatibilityId: string | null;
  responseOk: boolean;
  isRscContentType: boolean;
  hasBody: boolean;
  compatibilityIdHeader: string | null;
  responseUrl: string | null;
  streamedRedirectTarget: string | null;
};

type RscRedirectFollow = {
  href: string;
  historyUpdateMode: "push" | "replace";
  previousNextUrl: string | null;
  redirectDepth: number;
};

type RscFetchResultHardNavReason =
  | "invalidRscPayload"
  | "rscCompatibilityMismatch"
  | "externalRedirectTarget"
  | "redirectDepthExhausted"
  | "streamedRedirectLoop";

export type RscFetchResultDecision =
  | { kind: "proceedToCommit"; discardBody: false; trace: NavigationTrace }
  | {
      kind: "followRedirect";
      discardBody: boolean;
      redirect: RscRedirectFollow;
      trace: NavigationTrace;
    }
  | {
      kind: "hardNavigate";
      discardBody: boolean;
      url: string;
      reason: RscFetchResultHardNavReason;
      trace: NavigationTrace;
    };

// Early navigation intent classification runs before any fetch, on URL-delta
// facts the executor can collect synchronously at navigation start. It is the
// pre-flight sibling of classifyRscFetchResult: the planner owns the semantic
// outcome (same-document scroll vs cache-bypassing flight vs ordinary flight),
// the executor owns the effects (history mutation, scroll, RSC fetch).
//
// This surface only needs the URL delta plus history/scroll intent. Richer
// planner inputs (route manifest, mounted slots) join later slices once prefetch
// reuse and the remaining hard-navigation causes route through this surface.
export type EarlyNavigationIntentFacts = {
  // App basePath, stripped from both pathnames before comparison.
  basePath: string;
  // The current visible document URL (window.location.href at navigation start),
  // absolute so it can anchor relative target resolution.
  currentHref: string;
  // push/replace history intent carried through to the scroll executor.
  mode: "push" | "replace";
  // Whether the navigation requested scroll (Link/router scroll option).
  scroll: boolean;
  // The navigation target, absolute or relative to currentHref.
  targetHref: string;
};

export type EarlyNavigationIntentDecision =
  | {
      kind: "sameDocumentScroll";
      // Always non-empty: same-document scroll is only chosen for a hash target.
      hash: string;
      mode: "push" | "replace";
      scroll: boolean;
      trace: NavigationTrace;
    }
  | {
      kind: "flightNavigation";
      // True for same-path search changes, where a cached full-route payload is
      // not authoritative because search params are a page input.
      bypassNavigationCache: boolean;
      trace: NavigationTrace;
    };

type NavigationReuseNavigationKind = "navigate" | "refresh" | "traverse";

export type VisitedResponseCacheCandidateFacts =
  | {
      candidate: "missing";
      navigationKind: NavigationReuseNavigationKind;
    }
  | {
      candidate: "present";
      fresh: boolean;
      mountedSlotsMatch: boolean;
      navigationKind: NavigationReuseNavigationKind;
    };

type VisitedResponseCacheCandidateDecision =
  | { kind: "miss" }
  | {
      kind: "evict";
      reason: "mountedSlotsMismatch" | "refresh" | "stale";
    }
  | { kind: "reuse" };

type NavigationReuseCandidateAvailability = { status: "available" } | { status: "unavailable" };
type OptimisticRouteShellCandidateAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: "routeManifestMissing" };

export type NavigationReuseFacts = {
  bypassNavigationCache: boolean;
  navigationKind: NavigationReuseNavigationKind;
  optimisticRouteShell: OptimisticRouteShellCandidateAvailability;
  prefetch: NavigationReuseCandidateAvailability;
  targetHref: string;
  visitedResponse: NavigationReuseCandidateAvailability;
};

type FreshFetchReason = "cacheBypassed" | "cacheMiss" | "refresh" | "routeManifestMissing";

export type NavigationReuseDecision =
  | { kind: "reuseVisitedResponse"; trace: NavigationTrace }
  | { kind: "consumePrefetch"; trace: NavigationTrace }
  | { kind: "attemptOptimisticRouteShell"; trace: NavigationTrace }
  | { kind: "fetchFresh"; reason: FreshFetchReason; trace: NavigationTrace };

type NavigationPrefetchProbeFacts = {
  bypassNavigationCache: boolean;
  navigationKind: NavigationReuseNavigationKind;
  visitedResponse: NavigationReuseCandidateAvailability;
};

type NavigationPrefetchProbeDecision =
  | { kind: "probe" }
  | { kind: "skip"; reason: "cacheBypassed" | "refresh" | "visitedResponseAvailable" };

export type NavigationPlannerInput = {
  // Graph-owned route topology is the semantic authority for root/layout/slot
  // decisions whenever the caller can supply it. Null keeps the legacy
  // snapshot-only path for low-level tests and unknown route shapes.
  routeManifest: RouteManifest | null;
  state: NavigationPlannerState;
  event: NavigationEvent;
};

type RouteTopologySnapshot = {
  layoutIds: readonly string[];
  rootBoundaryId: string | null;
  rootLayoutTreePath: string | null;
  slotBindings: readonly ParallelSlotBindingSnapshot[];
};

type RouteTopologyResolution =
  | {
      kind: "known";
      topology: RouteTopologySnapshot;
    }
  | {
      kind: "unknown";
    };

type RouteTopologySlotBindingSource = "snapshot" | "manifestTarget";
type AcceptedCacheEntryReuseDecision = Extract<CacheEntryReuseDecision, { canReuse: true }>;
type RejectedCacheEntryReuseDecision = Extract<CacheEntryReuseDecision, { canReuse: false }>;
type CacheEntryProofEvaluation =
  | Readonly<{
      decision: AcceptedCacheEntryReuseDecision | null;
      kind: "accepted";
    }>
  | Readonly<{
      decision: RejectedCacheEntryReuseDecision | null;
      kind: "rejected";
    }>;

const ROUTE_INTERCEPTION_CONTEXT_SEPARATOR = "\0";
const CACHE_ENTRY_PROOF_MISSING_CODE =
  "CP_CACHE_ENTRY_PROOF_MISSING" satisfies CacheProofRejectionCode;

function createRequestWorkDecision(options: {
  eventKind: NavigationEvent["kind"];
  state: NavigationPlannerState;
  work: RequestedWork;
}): NavigationDecision {
  const traverseFields =
    options.work.kind === "traverseFlight" ? { traverseDirection: options.work.direction } : {};
  return {
    kind: "requestWork",
    token: options.state.nextOperationToken,
    work: options.work,
    trace: createNavigationTrace(NavigationTraceReasonCodes.requestWork, {
      eventKind: options.eventKind,
      targetHref: getRequestedWorkTargetHref(options.work),
      ...traverseFields,
    }),
  };
}

function getRequestedWorkTargetHref(work: RequestedWork): string | null {
  switch (work.kind) {
    case "flight":
    case "prefetch":
      return work.href;
    case "traverseFlight":
      return null;
    default: {
      const _exhaustive: never = work;
      throw new Error("[vinext] Unknown requested navigation work: " + String(_exhaustive));
    }
  }
}

function createRscFetchResultTraceFields(
  facts: RscFetchResultFacts,
  fields: NavigationTraceFields = {},
): NavigationTraceFields {
  return {
    fetchResultSource: facts.source,
    ...fields,
  };
}

function createRscFetchResultHardNavigationDecision(options: {
  discardBody: boolean;
  facts: RscFetchResultFacts;
  reason: RscFetchResultHardNavReason;
  reasonCode: NavigationTraceReasonCode;
  redirectSignal?: RscRedirectSignal;
  url: string;
}): RscFetchResultDecision {
  return {
    discardBody: options.discardBody,
    kind: "hardNavigate",
    reason: options.reason,
    trace: createNavigationTrace(
      options.reasonCode,
      createRscFetchResultTraceFields(options.facts, {
        ...(options.redirectSignal !== undefined ? { redirectSignal: options.redirectSignal } : {}),
        // Terminal redirects report the depth that was evaluated; followed
        // redirects report the next depth that the executor should request.
        redirectDepth: options.facts.redirectDepth,
        targetHref: options.url,
      }),
    ),
    url: options.url,
  };
}

function createRscFetchResultFollowRedirectDecision(options: {
  discardBody: boolean;
  facts: RscFetchResultFacts;
  redirect: RscRedirectFollow;
  redirectSignal: RscRedirectSignal;
}): RscFetchResultDecision {
  return {
    discardBody: options.discardBody,
    kind: "followRedirect",
    redirect: options.redirect,
    trace: createNavigationTrace(
      NavigationTraceReasonCodes.redirectFollow,
      createRscFetchResultTraceFields(options.facts, {
        redirectDepth: options.redirect.redirectDepth,
        redirectSignal: options.redirectSignal,
        targetHref: options.redirect.href,
      }),
    ),
  };
}

function mapRscRedirectTerminalReason(reason: "externalRedirect" | "maxRedirectsExceeded"): {
  hardNavigationReason: RscFetchResultHardNavReason;
  traceReasonCode: NavigationTraceReasonCode;
} {
  switch (reason) {
    case "externalRedirect":
      return {
        hardNavigationReason: "externalRedirectTarget",
        traceReasonCode: NavigationTraceReasonCodes.redirectTerminalExternal,
      };
    case "maxRedirectsExceeded":
      return {
        hardNavigationReason: "redirectDepthExhausted",
        traceReasonCode: NavigationTraceReasonCodes.redirectTerminalDepth,
      };
    default: {
      const _exhaustive: never = reason;
      throw new Error("[vinext] Unknown RSC redirect terminal reason: " + String(_exhaustive));
    }
  }
}

function classifyRscFetchResult(facts: RscFetchResultFacts): RscFetchResultDecision {
  if (!facts.responseOk || !facts.isRscContentType || !facts.hasBody) {
    const url = resolveHardNavigationTargetFromRscResponse(
      facts.responseUrl,
      facts.currentHref,
      facts.origin,
    );
    return createRscFetchResultHardNavigationDecision({
      discardBody: false,
      facts,
      reason: "invalidRscPayload",
      reasonCode: NavigationTraceReasonCodes.invalidRscPayload,
      url,
    });
  }

  const compatibilityDecision = resolveRscCompatibilityNavigationDecision({
    clientCompatibilityId: facts.clientCompatibilityId,
    currentHref: facts.currentHref,
    origin: facts.origin,
    responseCompatibilityId: facts.compatibilityIdHeader,
    responseUrl: facts.responseUrl,
  });
  if (compatibilityDecision.kind === "hard-navigate") {
    return createRscFetchResultHardNavigationDecision({
      discardBody: false,
      facts,
      reason: "rscCompatibilityMismatch",
      reasonCode: NavigationTraceReasonCodes.rscCompatibilityMismatch,
      url: compatibilityDecision.hardNavigationTarget,
    });
  }

  if (facts.responseUrl !== null) {
    const redirectDecision = resolveRscRedirectLifecycleHop({
      currentHref: facts.currentHref,
      historyUpdateMode: facts.effectiveHistoryUpdateMode,
      origin: facts.origin,
      redirectDepth: facts.redirectDepth,
      requestPreviousNextUrl: facts.requestPreviousNextUrl,
      responseUrl: facts.responseUrl,
    });
    if (redirectDecision.kind === "terminal-hard-navigation") {
      const terminalReason = mapRscRedirectTerminalReason(redirectDecision.reason);
      return createRscFetchResultHardNavigationDecision({
        discardBody: false,
        facts,
        reason: terminalReason.hardNavigationReason,
        reasonCode: terminalReason.traceReasonCode,
        redirectSignal: "response-url",
        url: redirectDecision.href,
      });
    }
    if (redirectDecision.kind === "follow") {
      return createRscFetchResultFollowRedirectDecision({
        discardBody: false,
        facts,
        redirect: {
          href: redirectDecision.href,
          historyUpdateMode: facts.effectiveHistoryUpdateMode,
          previousNextUrl: redirectDecision.previousNextUrl,
          redirectDepth: redirectDecision.redirectDepth,
        },
        redirectSignal: "response-url",
      });
    }
  }

  if (facts.streamedRedirectTarget !== null) {
    const redirectDecision = resolveStreamedRscRedirectLifecycleHop({
      currentHref: facts.currentHref,
      historyUpdateMode: facts.effectiveHistoryUpdateMode,
      origin: facts.origin,
      redirectDepth: facts.redirectDepth,
      requestPreviousNextUrl: facts.requestPreviousNextUrl,
      streamedRedirectTarget: facts.streamedRedirectTarget,
    });
    if (redirectDecision.kind === "terminal-hard-navigation") {
      const terminalReason = mapRscRedirectTerminalReason(redirectDecision.reason);
      return createRscFetchResultHardNavigationDecision({
        discardBody: true,
        facts,
        reason: terminalReason.hardNavigationReason,
        reasonCode: terminalReason.traceReasonCode,
        redirectSignal: "streamed-header",
        url: redirectDecision.href,
      });
    }
    if (redirectDecision.kind === "follow") {
      return createRscFetchResultFollowRedirectDecision({
        discardBody: true,
        facts,
        redirect: {
          href: redirectDecision.href,
          historyUpdateMode: facts.effectiveHistoryUpdateMode,
          previousNextUrl: redirectDecision.previousNextUrl,
          redirectDepth: redirectDecision.redirectDepth,
        },
        redirectSignal: "streamed-header",
      });
    }

    return createRscFetchResultHardNavigationDecision({
      discardBody: true,
      facts,
      reason: "streamedRedirectLoop",
      reasonCode: NavigationTraceReasonCodes.streamedRedirectLoop,
      redirectSignal: "streamed-header",
      url: redirectDecision.href,
    });
  }

  return {
    discardBody: false,
    kind: "proceedToCommit",
    trace: createNavigationTrace(
      NavigationTraceReasonCodes.proceedToCommit,
      createRscFetchResultTraceFields(facts),
    ),
  };
}

function createEarlyNavigationIntentTrace(
  reasonCode: NavigationTraceReasonCode,
  facts: EarlyNavigationIntentFacts,
): NavigationTrace {
  return createNavigationTrace(reasonCode, { targetHref: facts.targetHref });
}

function classifyEarlyNavigationIntent(
  facts: EarlyNavigationIntentFacts,
): EarlyNavigationIntentDecision {
  let current: URL;
  let next: URL;
  try {
    current = new URL(facts.currentHref);
    next = new URL(facts.targetHref, facts.currentHref);
  } catch {
    // Unparseable hrefs cannot be reasoned about as a same-document delta. Fall
    // back to an ordinary flight navigation and let the fetch path surface any
    // real failure rather than masking it as a same-page outcome.
    return {
      bypassNavigationCache: false,
      kind: "flightNavigation",
      trace: createEarlyNavigationIntentTrace(
        NavigationTraceReasonCodes.crossDocumentFlight,
        facts,
      ),
    };
  }

  // A cross-origin target is never a same-document or same-page navigation, even
  // when its pathname and search match. The planner is the semantic authority
  // here, so it cannot assume the caller already filtered same-origin: gate both
  // same-document outcomes on origin so a different host falls through to an
  // ordinary flight.
  const samePathname =
    current.origin === next.origin &&
    stripBasePath(current.pathname, facts.basePath) ===
      stripBasePath(next.pathname, facts.basePath);
  // Compare serialised search params rather than raw search strings, matching the
  // previous same-page-search predicate, so encoding differences that parse to
  // the same query (e.g. "%20" vs "+") are not read as a search change. App
  // Router snapshots reach currentHref through createSnapshotPathAndSearch();
  // reparsing and serialising that canonical query is idempotent and preserves
  // key order. We intentionally do not sort, since query order can be observable.
  const sameSearch = current.searchParams.toString() === next.searchParams.toString();

  if (samePathname && sameSearch && next.hash !== "") {
    return {
      hash: next.hash,
      kind: "sameDocumentScroll",
      mode: facts.mode,
      scroll: facts.scroll,
      trace: createEarlyNavigationIntentTrace(NavigationTraceReasonCodes.sameDocumentScroll, facts),
    };
  }

  if (samePathname && !sameSearch) {
    return {
      bypassNavigationCache: true,
      kind: "flightNavigation",
      trace: createEarlyNavigationIntentTrace(NavigationTraceReasonCodes.samePageSearch, facts),
    };
  }

  return {
    bypassNavigationCache: false,
    kind: "flightNavigation",
    trace: createEarlyNavigationIntentTrace(NavigationTraceReasonCodes.crossDocumentFlight, facts),
  };
}

function classifyVisitedResponseCacheCandidate(
  facts: VisitedResponseCacheCandidateFacts,
): VisitedResponseCacheCandidateDecision {
  if (facts.candidate === "missing") {
    return { kind: "miss" };
  }

  if (!facts.mountedSlotsMatch) {
    return {
      kind: "evict",
      reason: "mountedSlotsMismatch",
    };
  }

  if (facts.navigationKind === "refresh") {
    return {
      kind: "evict",
      reason: "refresh",
    };
  }

  if (!facts.fresh) {
    return {
      kind: "evict",
      reason: "stale",
    };
  }

  return { kind: "reuse" };
}

function createNavigationReuseTrace(
  code: NavigationTraceReasonCode,
  facts: NavigationReuseFacts,
  fields: NavigationTraceFields = {},
): NavigationTrace {
  return createNavigationTrace(code, {
    eventKind: facts.navigationKind,
    targetHref: facts.targetHref,
    ...fields,
  });
}

function createFreshFetchDecision(
  facts: NavigationReuseFacts,
  reason: FreshFetchReason,
): NavigationReuseDecision {
  return {
    kind: "fetchFresh",
    reason,
    trace: createNavigationReuseTrace(NavigationTraceReasonCodes.fetchFresh, facts, {
      freshFetchReason: reason,
    }),
  };
}

function classifyNavigationReuse(facts: NavigationReuseFacts): NavigationReuseDecision {
  if (facts.navigationKind === "refresh") {
    return createFreshFetchDecision(facts, "refresh");
  }

  if (!facts.bypassNavigationCache && facts.visitedResponse.status === "available") {
    return {
      kind: "reuseVisitedResponse",
      trace: createNavigationReuseTrace(NavigationTraceReasonCodes.visitedResponseReuse, facts),
    };
  }

  if (!facts.bypassNavigationCache && facts.prefetch.status === "available") {
    return {
      kind: "consumePrefetch",
      trace: createNavigationReuseTrace(NavigationTraceReasonCodes.prefetchResponseReuse, facts),
    };
  }

  if (facts.navigationKind === "navigate") {
    if (facts.optimisticRouteShell.status === "available") {
      return {
        kind: "attemptOptimisticRouteShell",
        trace: createNavigationReuseTrace(NavigationTraceReasonCodes.optimisticRouteShell, facts),
      };
    }

    return createFreshFetchDecision(
      facts,
      facts.bypassNavigationCache ? "cacheBypassed" : facts.optimisticRouteShell.reason,
    );
  }

  if (facts.bypassNavigationCache) {
    return createFreshFetchDecision(facts, "cacheBypassed");
  }

  return createFreshFetchDecision(facts, "cacheMiss");
}

function classifyNavigationPrefetchProbe(
  facts: NavigationPrefetchProbeFacts,
): NavigationPrefetchProbeDecision {
  if (facts.visitedResponse.status === "available") {
    return { kind: "skip", reason: "visitedResponseAvailable" };
  }

  if (facts.navigationKind === "refresh") {
    return { kind: "skip", reason: "refresh" };
  }

  if (facts.bypassNavigationCache) {
    return { kind: "skip", reason: "cacheBypassed" };
  }

  return { kind: "probe" };
}

function createSnapshotRouteTopology(snapshot: RouteSnapshot): RouteTopologySnapshot {
  return {
    layoutIds: snapshot.layoutIds,
    rootBoundaryId: snapshot.rootBoundaryId,
    rootLayoutTreePath: snapshot.rootBoundaryId,
    slotBindings: snapshot.slotBindings,
  };
}

function stripInterceptionContextFromRouteId(routeId: string): string {
  const separatorIndex = routeId.indexOf(ROUTE_INTERCEPTION_CONTEXT_SEPARATOR);
  return separatorIndex === -1 ? routeId : routeId.slice(0, separatorIndex);
}

function matchedUrlFromConcreteRouteId(routeId: string): string | null {
  const normalizedRouteId = stripInterceptionContextFromRouteId(routeId);
  if (!normalizedRouteId.startsWith("route:/")) return null;
  return normalizedRouteId.slice("route:".length);
}

function getMatchedUrlPathname(matchedUrl: string): string {
  try {
    return new URL(matchedUrl, "https://vinext.local").pathname;
  } catch {
    const [withoutHash = ""] = matchedUrl.split("#");
    const [pathname = ""] = withoutHash.split("?");
    return pathname === "" ? "/" : pathname;
  }
}

function splitMatchedUrlIntoRouteParts(matchedUrl: string): string[] {
  return splitPathnameForRouteMatch(getMatchedUrlPathname(matchedUrl));
}

function findRouteManifestRouteByMatchedUrl(
  routeManifest: RouteManifest,
  matchedUrl: string,
): RouteManifestRoute | null {
  const urlParts = splitMatchedUrlIntoRouteParts(matchedUrl);

  // RouteManifest preserves buildAppRouteGraph's sortRoutes() order, so the
  // first pattern match follows the same static/dynamic/catch-all precedence as
  // request-time route matching instead of raw filesystem scan order.
  for (const route of routeManifest.segmentGraph.routes.values()) {
    if (matchRoutePattern(urlParts, route.patternParts) !== null) {
      return route;
    }
  }

  return null;
}

function routeManifestRouteMatchesUrl(route: RouteManifestRoute, matchedUrl: string): boolean {
  return matchRoutePattern(splitMatchedUrlIntoRouteParts(matchedUrl), route.patternParts) !== null;
}

function findRouteManifestRouteByIdOrMatchedUrl(options: {
  matchedUrl: string;
  routeId: string;
  routeManifest: RouteManifest;
}): RouteManifestRoute | null {
  const routeId = stripInterceptionContextFromRouteId(options.routeId);
  const route = options.routeManifest.segmentGraph.routes.get(routeId);
  if (route && routeManifestRouteMatchesUrl(route, options.matchedUrl)) {
    return route;
  }

  const concreteRouteMatchedUrl =
    route === undefined ? matchedUrlFromConcreteRouteId(options.routeId) : null;
  if (concreteRouteMatchedUrl !== null) {
    const concreteRoute = findRouteManifestRouteByMatchedUrl(
      options.routeManifest,
      concreteRouteMatchedUrl,
    );
    if (concreteRoute !== null) return concreteRoute;
  }

  return findRouteManifestRouteByMatchedUrl(options.routeManifest, options.matchedUrl);
}

function findRouteManifestRouteForSnapshot(
  routeManifest: RouteManifest,
  snapshot: RouteSnapshot,
): RouteManifestRoute | null {
  if (snapshot.interception !== null) {
    return findRouteManifestRouteByIdOrMatchedUrl({
      matchedUrl: snapshot.interception.sourceMatchedUrl,
      routeId: snapshot.interception.sourceRouteId,
      routeManifest,
    });
  }

  return findRouteManifestRouteByIdOrMatchedUrl({
    matchedUrl: snapshot.matchedUrl,
    routeId: snapshot.routeId,
    routeManifest,
  });
}

function resolveRouteManifestSlotBindings(
  routeManifest: RouteManifest,
  route: RouteManifestRoute,
): readonly ParallelSlotBindingSnapshot[] {
  const bindings: ParallelSlotBindingSnapshot[] = [];
  for (const slotId of route.slotIds) {
    const binding = routeManifest.segmentGraph.slotBindings.get(`${route.id}::${slotId}`);
    if (!binding) continue;
    bindings.push({
      ownerLayoutId: binding.ownerLayoutId,
      slotId: binding.slotId,
      state: binding.state,
    });
  }

  return bindings.sort((left, right) => compareAppElementsSlotIds(left.slotId, right.slotId));
}

function resolveRouteManifestRootLayoutTreePath(
  routeManifest: RouteManifest,
  route: RouteManifestRoute,
): string | null {
  if (route.rootBoundaryId === null) return null;
  return routeManifest.segmentGraph.rootBoundaries.get(route.rootBoundaryId)?.treePath ?? null;
}

function resolveRouteTopologySnapshot(options: {
  routeManifest: RouteManifest | null;
  slotBindingSource: RouteTopologySlotBindingSource;
  snapshot: RouteSnapshot;
}): RouteTopologyResolution {
  const route =
    options.routeManifest === null
      ? null
      : findRouteManifestRouteForSnapshot(options.routeManifest, options.snapshot);
  if (route === null || options.routeManifest === null) {
    return { kind: "unknown" };
  }

  // Intercepted targets carry the source route's tree topology, not the direct
  // target route's, so direct-target manifest slot bindings do not apply.
  const shouldUseManifestSlotBindings =
    options.slotBindingSource === "manifestTarget" && options.snapshot.interception === null;

  return {
    kind: "known",
    topology: {
      layoutIds: route.layoutIds,
      rootBoundaryId: route.rootBoundaryId,
      rootLayoutTreePath: resolveRouteManifestRootLayoutTreePath(options.routeManifest, route),
      slotBindings: shouldUseManifestSlotBindings
        ? resolveRouteManifestSlotBindings(options.routeManifest, route)
        : options.snapshot.slotBindings,
    },
  };
}

function findRouteManifestInterceptionForProof(
  routeManifest: RouteManifest,
  proof: InterceptionSnapshot,
): RouteManifestInterception | null {
  const sourceParts = splitMatchedUrlIntoRouteParts(proof.sourceMatchedUrl);
  const targetParts = splitMatchedUrlIntoRouteParts(proof.targetMatchedUrl);
  const targetRoute = findRouteManifestRouteByIdOrMatchedUrl({
    matchedUrl: proof.targetMatchedUrl,
    routeId: proof.targetRouteId,
    routeManifest,
  });
  const candidateInterceptions =
    routeManifest.segmentGraph.interceptionsBySlotId.get(proof.slotId) ?? [];

  for (const interception of candidateInterceptions) {
    if (!matchRoutePatternPrefix(sourceParts, interception.sourcePatternParts)) {
      continue;
    }
    const exactTargetParams = matchRoutePattern(targetParts, interception.targetPatternParts);
    const allowsMiddlewareRewriteTarget =
      exactTargetParams === null &&
      matchRoutePatternWithOptionalDynamicSegments(targetParts, interception.targetPatternParts);
    if (exactTargetParams === null && !allowsMiddlewareRewriteTarget) {
      continue;
    }
    if (
      !allowsMiddlewareRewriteTarget &&
      interception.targetRouteId !== null &&
      targetRoute?.id !== interception.targetRouteId
    ) {
      continue;
    }
    return interception;
  }

  return null;
}

function createRootBoundaryTraceFields(options: {
  currentRootLayoutTreePath: string | null;
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  nextRootLayoutTreePath: string | null;
  state: NavigationPlannerState;
}): NavigationTraceFields {
  // Browser commit approval supplies lifecycle trace context before calling
  // the planner. This fallback exists for pure planner callers and tests; it
  // intentionally cannot invent lifecycle-only fields such as active nav id.
  if (options.state.traceFields) {
    return {
      ...options.state.traceFields,
      currentRootLayoutTreePath: options.currentRootLayoutTreePath,
      nextRootLayoutTreePath: options.nextRootLayoutTreePath,
    };
  }

  return createNavigationLifecycleTraceFields({
    currentRootLayoutTreePath: options.currentRootLayoutTreePath,
    currentVisibleCommitVersion: options.state.visibleCommitVersion,
    nextRootLayoutTreePath: options.nextRootLayoutTreePath,
    startedVisibleCommitVersion: options.event.token.baseVisibleCommitVersion,
  });
}

function classifyRootBoundaryTransition(
  currentRootBoundaryId: string | null,
  nextRootBoundaryId: string | null,
): RootBoundaryTransition {
  if (currentRootBoundaryId === null || nextRootBoundaryId === null) {
    return "rootBoundaryUnknown";
  }

  return currentRootBoundaryId === nextRootBoundaryId
    ? "currentRootBoundary"
    : "rootBoundaryChanged";
}

function resolveSameLayoutAncestorPersistence(
  currentSnapshot: RouteSnapshot,
  targetSnapshot: RouteSnapshot,
): readonly string[] {
  return resolveSameLayoutAncestorPersistenceForTopologies(
    createSnapshotRouteTopology(currentSnapshot),
    createSnapshotRouteTopology(targetSnapshot),
  );
}

function resolveSameLayoutAncestorPersistenceForTopologies(
  currentTopology: RouteTopologySnapshot,
  targetTopology: RouteTopologySnapshot,
): readonly string[] {
  if (
    classifyRootBoundaryTransition(
      currentTopology.rootBoundaryId,
      targetTopology.rootBoundaryId,
    ) !== "currentRootBoundary"
  ) {
    return [];
  }

  const commonLayoutIds: string[] = [];
  const maxLength = Math.min(currentTopology.layoutIds.length, targetTopology.layoutIds.length);
  for (let index = 0; index < maxLength; index++) {
    const layoutId = currentTopology.layoutIds[index];
    if (layoutId !== targetTopology.layoutIds[index]) break;
    commonLayoutIds.push(layoutId);
  }
  return commonLayoutIds;
}

function resolveMountedParallelSlotPersistence(
  currentSnapshot: RouteSnapshot,
  targetSnapshot: RouteSnapshot,
): readonly string[] {
  const preservedLayoutIds = resolveSameLayoutAncestorPersistence(currentSnapshot, targetSnapshot);
  return resolveMountedParallelSlotPersistenceForLayouts(currentSnapshot, preservedLayoutIds);
}

function resolveMountedParallelSlotPersistenceForLayouts(
  currentSnapshot: RouteSnapshot,
  preservedLayoutIds: readonly string[],
): readonly string[] {
  if (preservedLayoutIds.length === 0) return [];
  const preservedLayoutIdSet = new Set(preservedLayoutIds);

  const preservedSlotIds: string[] = [];
  const seenSlotIds = new Set<string>();
  for (const slot of currentSnapshot.mountedParallelSlots) {
    if (slot.ownerLayoutId === null) continue;
    if (!preservedLayoutIdSet.has(slot.ownerLayoutId)) continue;
    if (seenSlotIds.has(slot.slotId)) continue;

    preservedSlotIds.push(slot.slotId);
    seenSlotIds.add(slot.slotId);
  }
  return preservedSlotIds;
}

function resolveCurrentRootBoundaryElementPersistence(
  currentSnapshot: RouteSnapshot,
  targetSnapshot: RouteSnapshot,
): readonly string[] {
  const preservedLayoutIds = resolveSameLayoutAncestorPersistence(currentSnapshot, targetSnapshot);
  // Non-commit consumers still receive the legacy mounted-slot element list.
  // Commit promotion uses preservePreviousSlotIds instead so default/unmatched
  // slot reuse requires route-state proof.
  return [
    ...preservedLayoutIds,
    ...resolveMountedParallelSlotPersistenceForLayouts(currentSnapshot, preservedLayoutIds),
  ];
}

function resolveCurrentRootBoundaryCommitElementPersistence(options: {
  currentTopology: RouteTopologySnapshot;
  lane: OperationLane;
  targetTopology: RouteTopologySnapshot;
}): readonly string[] {
  // Commit element persistence only keeps layout IDs. Default/unmatched slot
  // reuse is handled separately by preservePreviousSlotIds, using slot-binding
  // metadata as proof; payloads without __slotBindings get no semantic reuse.
  // resolveCurrentRootBoundaryCommitSlotPersistence recomputes this same
  // ancestor set; planner correctness relies on both calls agreeing so any
  // preserved slot's owner layout is also present in preserveElementIds.
  return resolveSameLayoutAncestorPersistenceForTopologies(
    options.currentTopology,
    options.targetTopology,
  );
}

function resolveCurrentRootBoundaryCommitSlotPersistence(options: {
  currentTopology: RouteTopologySnapshot;
  lane: OperationLane;
  targetTopology: RouteTopologySnapshot;
}): readonly string[] {
  if (options.lane === "traverse") return [];

  const preservedLayoutIds = resolveSameLayoutAncestorPersistenceForTopologies(
    options.currentTopology,
    options.targetTopology,
  );
  if (preservedLayoutIds.length === 0) return [];

  return resolveDefaultOrUnmatchedSlotPersistenceForLayouts({
    currentSlotBindings: options.currentTopology.slotBindings,
    preservedLayoutIds,
    targetSlotBindings: options.targetTopology.slotBindings,
  });
}

/**
 * Default/unmatched slot preservation law:
 *
 * A target default/unmatched slot may reuse previous content only when:
 * - the slot's owner layout is part of the preserved layout ancestor set;
 * - the current visible snapshot proves the same slot had renderable content;
 * - the navigation is not a traversal.
 *
 * Wire absence and UNMATCHED_SLOT markers are not semantic proof.
 */
export function resolveDefaultOrUnmatchedSlotPersistenceForLayouts(options: {
  currentSlotBindings: readonly ParallelSlotBindingSnapshot[];
  preservedLayoutIds: readonly string[];
  targetSlotBindings: readonly ParallelSlotBindingSnapshot[];
}): readonly string[] {
  const preservedLayoutIdSet = new Set(options.preservedLayoutIds);
  const slotIdsWithContent = new Set<string>();
  for (const binding of options.currentSlotBindings) {
    if (binding.state === "unmatched") continue;
    slotIdsWithContent.add(binding.slotId);
  }

  const preservedSlotIds: string[] = [];
  const seenSlotIds = new Set<string>();
  for (const binding of options.targetSlotBindings) {
    if (binding.ownerLayoutId === null) continue;
    if (!preservedLayoutIdSet.has(binding.ownerLayoutId)) continue;
    if (binding.state === "active") continue;
    if (!slotIdsWithContent.has(binding.slotId)) continue;
    if (seenSlotIds.has(binding.slotId)) continue;

    preservedSlotIds.push(binding.slotId);
    seenSlotIds.add(binding.slotId);
  }
  return preservedSlotIds.sort(compareAppElementsSlotIds);
}

type VisibleInterceptionSourceIdentity = {
  matchedUrl: string;
  routeId: string;
};

type InterceptedPreservationValidation =
  | {
      kind: "approved";
      preserveElementIds: readonly string[];
      preservePreviousSlotIds: readonly string[];
    }
  | {
      kind: "rejected";
      reasonCode: NavigationTraceReasonCode;
    };

function getVisibleInterceptionSourceIdentity(
  snapshot: RouteSnapshot,
): VisibleInterceptionSourceIdentity {
  if (snapshot.interception) {
    return {
      matchedUrl: snapshot.interception.sourceMatchedUrl,
      routeId: snapshot.interception.sourceRouteId,
    };
  }
  const concreteMatchedUrl = matchedUrlFromConcreteRouteId(snapshot.routeId);
  return {
    matchedUrl: concreteMatchedUrl ?? snapshot.matchedUrl,
    routeId: snapshot.routeId,
  };
}

function createInterceptionProofRejectedDecision(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  reasonCode: NavigationTraceReasonCode;
  traceFields: NavigationTraceFields;
}): NavigationDecision {
  return {
    kind: "hardNavigate",
    reason: "interceptionProofRejected",
    token: options.event.token,
    trace: createNavigationTrace(options.reasonCode, options.traceFields),
    url: options.event.result.href,
  };
}

function evaluateCacheEntryReuseProof(
  proof: CacheEntryReuseProof | undefined,
): CacheEntryProofEvaluation {
  if (proof === undefined) {
    return {
      kind: "accepted",
      decision: null,
    };
  }

  if (proof.decision === null) {
    return {
      kind: "rejected",
      decision: null,
    };
  }

  if (proof.decision.canReuse) {
    return {
      kind: "accepted",
      decision: proof.decision,
    };
  }

  return {
    kind: "rejected",
    decision: proof.decision,
  };
}

function createCacheProofRejectedTraceFields(
  traceFields: NavigationTraceFields,
  decision: RejectedCacheEntryReuseDecision | null,
): NavigationTraceFields {
  if (decision === null) {
    return {
      ...traceFields,
      cacheProofCode: CACHE_ENTRY_PROOF_MISSING_CODE,
    };
  }

  return {
    ...traceFields,
    cacheProofCode: decision.code,
    cacheProofMode: decision.mode,
    cacheProofScope: decision.scope,
  };
}

function createCacheProofRejectedDecision(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  rejection: Extract<CacheEntryProofEvaluation, { kind: "rejected" }>;
  traceFields: NavigationTraceFields;
}): NavigationDecision {
  return {
    kind: "hardNavigate",
    reason: "cacheProofRejected",
    token: options.event.token,
    trace: createNavigationTrace(
      NavigationTraceReasonCodes.cacheProofRejected,
      createCacheProofRejectedTraceFields(options.traceFields, options.rejection.decision),
    ),
    url: options.event.result.href,
  };
}

// A proven cache entry rejected by the OperationToken authority (its graph
// version or variant no longer matches the installed one). Distinct from
// cacheProofRejected — the cache proof itself authorized reuse; the token did
// not — so it carries its own reason code and the verdict reason for telemetry.
function createCacheReuseTokenRejectedDecision(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  reason: OperationTokenRejectionReason;
  traceFields: NavigationTraceFields;
}): NavigationDecision {
  return {
    kind: "hardNavigate",
    reason: "cacheReuseTokenRejected",
    token: options.event.token,
    trace: createNavigationTrace(NavigationTraceReasonCodes.cacheReuseTokenRejected, {
      ...options.traceFields,
      cacheReuseTokenReason: options.reason,
    }),
    url: options.event.result.href,
  };
}

function createAcceptedCacheProofTraceFields(
  traceFields: NavigationTraceFields,
  decision: AcceptedCacheEntryReuseDecision | null,
): NavigationTraceFields {
  if (decision === null) return traceFields;
  return {
    ...traceFields,
    cacheProofCode: decision.code,
    cacheProofReuseClass: decision.reuseClass,
  };
}

function createCacheEntryProposalFields(
  decision: AcceptedCacheEntryReuseDecision | null,
): Pick<CommitProposal, "cacheEntryReuseDecision"> {
  if (decision === null) return {};
  return {
    cacheEntryReuseDecision: decision,
  };
}

function validateInterceptedPreservation(options: {
  currentSnapshot: RouteSnapshot;
  currentTopology: RouteTopologySnapshot;
  routeManifest: RouteManifest | null;
  targetSnapshot: RouteSnapshot;
  targetTopology: RouteTopologySnapshot;
}): InterceptedPreservationValidation {
  const proof = options.targetSnapshot.interception;
  if (!proof) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedMissingProof,
    };
  }

  if (proof.targetMatchedUrl !== options.targetSnapshot.matchedUrl) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedTargetMismatch,
    };
  }

  const sourceIdentity = getVisibleInterceptionSourceIdentity(options.currentSnapshot);
  if (
    proof.sourceMatchedUrl !== sourceIdentity.matchedUrl ||
    proof.sourceRouteId !== sourceIdentity.routeId
  ) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedUnknownSource,
    };
  }

  const declaredInterception =
    options.routeManifest === null
      ? null
      : findRouteManifestInterceptionForProof(options.routeManifest, proof);
  if (options.routeManifest !== null && declaredInterception === null) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedUndeclaredTopology,
    };
  }

  const preservedLayoutIds = resolveSameLayoutAncestorPersistenceForTopologies(
    options.currentTopology,
    options.targetTopology,
  );
  if (preservedLayoutIds.length === 0) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedIncompatibleRoot,
    };
  }

  const preservedLayoutIdSet = new Set(preservedLayoutIds);
  const targetSlotBinding = options.targetTopology.slotBindings.find(
    (binding) => binding.slotId === proof.slotId,
  );
  if (
    !targetSlotBinding ||
    targetSlotBinding.state !== "active" ||
    targetSlotBinding.ownerLayoutId === null ||
    !preservedLayoutIdSet.has(targetSlotBinding.ownerLayoutId)
  ) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedMissingSlotProof,
    };
  }
  if (
    declaredInterception !== null &&
    targetSlotBinding.ownerLayoutId !== declaredInterception.ownerLayoutId
  ) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedUndeclaredTopology,
    };
  }

  const preservePreviousSlotIds = resolveDefaultOrUnmatchedSlotPersistenceForLayouts({
    currentSlotBindings: options.currentTopology.slotBindings,
    preservedLayoutIds,
    targetSlotBindings: options.targetTopology.slotBindings,
  }).filter((slotId) => slotId !== proof.slotId);

  return {
    kind: "approved",
    preserveElementIds: preservedLayoutIds,
    preservePreviousSlotIds,
  };
}

function planFlightResponseArrived(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  routeManifest: RouteManifest | null;
  state: NavigationPlannerState;
}): NavigationDecision {
  const targetSnapshot = options.event.result.targetSnapshot;
  const currentTopology = resolveRouteTopologySnapshot({
    routeManifest: options.routeManifest,
    slotBindingSource: "snapshot",
    snapshot: options.state.visibleSnapshot,
  });
  const targetTopology = resolveRouteTopologySnapshot({
    routeManifest: options.routeManifest,
    slotBindingSource: "manifestTarget",
    snapshot: targetSnapshot,
  });
  const traceFields = createRootBoundaryTraceFields({
    currentRootLayoutTreePath:
      currentTopology.kind === "known" ? currentTopology.topology.rootLayoutTreePath : null,
    event: options.event,
    nextRootLayoutTreePath:
      targetTopology.kind === "known" ? targetTopology.topology.rootLayoutTreePath : null,
    state: options.state,
  });

  if (options.event.token.lane === "prefetch") {
    return {
      kind: "noCommit",
      reason: "prefetchOnly",
      token: options.event.token,
      trace: createNavigationTrace(NavigationTraceReasonCodes.prefetchOnly, traceFields),
    };
  }

  const cacheEntryProofEvaluation = evaluateCacheEntryReuseProof(
    options.event.result.cacheEntryReuseProof,
  );
  if (cacheEntryProofEvaluation.kind === "rejected") {
    return createCacheProofRejectedDecision({
      event: options.event,
      rejection: cacheEntryProofEvaluation,
      traceFields,
    });
  }
  const acceptedCacheEntryDecision = cacheEntryProofEvaluation.decision;

  // Commits and cache reuse share the OperationToken authority. A proven cache
  // entry may only be reused if its token still matches the installed route graph
  // and cache variant. Behavior-preserving today — the token's graphVersion is
  // minted from the same route manifest the planner verifies against — and a real
  // guard once cross-document or segment reuse (PR 6/7) can carry a token whose
  // graph version or variant has diverged from the installed one. The installed
  // cache variant is not yet known to the planner (segment cache, PR 7), so that
  // dimension stays dormant rather than comparing the token to itself.
  if (acceptedCacheEntryDecision !== null) {
    const reuseVerdict = verifyOperationTokenForCacheReuse(options.event.token, {
      graphVersion: options.routeManifest?.graphVersion ?? null,
      installedCacheVariantFingerprint: null,
    });
    if (!reuseVerdict.authorized) {
      return createCacheReuseTokenRejectedDecision({
        event: options.event,
        reason: reuseVerdict.reason,
        traceFields,
      });
    }
  }

  const commitTraceFields = createAcceptedCacheProofTraceFields(
    traceFields,
    acceptedCacheEntryDecision,
  );
  const cacheEntryProposalFields = createCacheEntryProposalFields(acceptedCacheEntryDecision);

  // interceptionContext is transport evidence, not authority. Normal payloads
  // can carry it when a request was sent from an intercepted visible world, so
  // only explicit __interception proof enters the preservation branch.
  const hasInterceptedPayload = targetSnapshot.interception !== null;
  if (hasInterceptedPayload) {
    if (currentTopology.kind === "unknown" || targetTopology.kind === "unknown") {
      return createInterceptionProofRejectedDecision({
        event: options.event,
        reasonCode: NavigationTraceReasonCodes.interceptedRejectedUndeclaredTopology,
        traceFields: commitTraceFields,
      });
    }

    const validation = validateInterceptedPreservation({
      currentSnapshot: options.state.visibleSnapshot,
      currentTopology: currentTopology.topology,
      routeManifest: options.routeManifest,
      targetSnapshot,
      targetTopology: targetTopology.topology,
    });
    if (validation.kind === "rejected") {
      return createInterceptionProofRejectedDecision({
        event: options.event,
        reasonCode: validation.reasonCode,
        traceFields: commitTraceFields,
      });
    }

    return {
      kind: "proposeCommit",
      proposal: {
        ...cacheEntryProposalFields,
        preserveAbsentSlots: false,
        preserveElementIds: validation.preserveElementIds,
        preservePreviousSlotIds: validation.preservePreviousSlotIds,
        reason: "interceptedCurrentRootBoundary",
        targetSnapshot,
      },
      token: options.event.token,
      trace: createNavigationTrace(
        NavigationTraceReasonCodes.interceptedCommitCurrent,
        commitTraceFields,
      ),
    };
  }

  const transition =
    currentTopology.kind === "unknown" || targetTopology.kind === "unknown"
      ? "rootBoundaryUnknown"
      : classifyRootBoundaryTransition(
          currentTopology.topology.rootBoundaryId,
          targetTopology.topology.rootBoundaryId,
        );

  if (transition === "rootBoundaryChanged") {
    return {
      kind: "hardNavigate",
      reason: "rootBoundaryChanged",
      token: options.event.token,
      trace: createNavigationTrace(
        NavigationTraceReasonCodes.rootBoundaryChanged,
        commitTraceFields,
      ),
      url: options.event.result.href,
    };
  }

  if (transition === "rootBoundaryUnknown") {
    // Unknown topology is not semantic proof. The event may still commit its
    // fully supplied payload, but it must not preserve absent slots, layouts,
    // or previous slot content from snapshot-derived route shape.
    return {
      kind: "proposeCommit",
      proposal: {
        ...cacheEntryProposalFields,
        preserveAbsentSlots: false,
        preserveElementIds: [],
        preservePreviousSlotIds: [],
        reason: "unprovenTopologyFallback",
        targetSnapshot,
      },
      token: options.event.token,
      trace: createNavigationTrace(
        NavigationTraceReasonCodes.rootBoundaryUnknown,
        commitTraceFields,
      ),
    };
  }

  if (currentTopology.kind !== "known" || targetTopology.kind !== "known") {
    throw new Error("[vinext] Current-root navigation planning requires manifest topology");
  }

  return {
    kind: "proposeCommit",
    proposal: {
      ...cacheEntryProposalFields,
      preserveAbsentSlots: false,
      preserveElementIds: resolveCurrentRootBoundaryCommitElementPersistence({
        currentTopology: currentTopology.topology,
        lane: options.event.token.lane,
        targetTopology: targetTopology.topology,
      }),
      preservePreviousSlotIds: resolveCurrentRootBoundaryCommitSlotPersistence({
        currentTopology: currentTopology.topology,
        lane: options.event.token.lane,
        targetTopology: targetTopology.topology,
      }),
      reason: "currentRootBoundary",
      targetSnapshot,
    },
    token: options.event.token,
    trace: createNavigationTrace(NavigationTraceReasonCodes.commitCurrent, commitTraceFields),
  };
}

function planNavigation(input: NavigationPlannerInput): NavigationDecision {
  switch (input.event.kind) {
    case "navigate":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          href: input.event.href,
          kind: "flight",
          mode: input.event.mode,
        },
      });
    case "refresh":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          href: input.state.visibleSnapshot.displayUrl,
          kind: "flight",
          mode: "refresh",
        },
      });
    case "traverse":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          direction: input.event.direction,
          historyState: input.event.historyState,
          kind: "traverseFlight",
        },
      });
    case "prefetch":
      return createRequestWorkDecision({
        eventKind: input.event.kind,
        state: input.state,
        work: {
          href: input.event.href,
          kind: "prefetch",
        },
      });
    case "flightResponseArrived":
      return planFlightResponseArrived({
        event: input.event,
        routeManifest: input.routeManifest,
        state: input.state,
      });
    default: {
      const _exhaustive: never = input.event;
      throw new Error("[vinext] Unknown navigation event: " + String(_exhaustive));
    }
  }
}

export type ServerActionResultFacts = {
  actionRedirectHref: string | null;
  actionRedirectType: "push" | "replace";
  clientCompatibilityId: string | null;
  compatibilityIdHeader: string | null;
  currentHref: string;
  isRscContentType: boolean;
  origin: string;
  responseUrl: string | null;
};

export type ServerActionResultDecision =
  | { kind: "proceed"; trace: NavigationTrace }
  | {
      kind: "hardNavigate";
      url: string;
      historyMode?: "assign" | "replace";
      clearClientNavigationCaches: boolean;
      reason: "serverActionRedirectCompatibilityMismatch" | "serverActionRscCompatibilityMismatch";
      trace: NavigationTrace;
    };

export type RscNavigationErrorFacts = {
  currentHref: string;
};

export type RscNavigationErrorDecision = {
  kind: "hardNavigate";
  url: string;
  reason: "rscNavigationError";
  trace: NavigationTrace;
};

function classifyServerActionResult(facts: ServerActionResultFacts): ServerActionResultDecision {
  // A client without a compatibility id cannot prove skew.
  if (facts.clientCompatibilityId === null) {
    return {
      kind: "proceed",
      trace: createNavigationTrace(NavigationTraceReasonCodes.proceedToCommit, {}),
    };
  }

  // Non-RSC action responses are not subject to the cache-busting compatibility
  // check; the executor will handle them directly.
  if (!facts.isRscContentType) {
    return {
      kind: "proceed",
      trace: createNavigationTrace(NavigationTraceReasonCodes.proceedToCommit, {}),
    };
  }

  const compatibilityDecision = resolveRscCompatibilityNavigationDecision({
    clientCompatibilityId: facts.clientCompatibilityId,
    currentHref: facts.currentHref,
    origin: facts.origin,
    responseCompatibilityId: facts.compatibilityIdHeader,
    responseUrl: facts.responseUrl,
  });

  if (compatibilityDecision.kind === "compatible") {
    return {
      kind: "proceed",
      trace: createNavigationTrace(NavigationTraceReasonCodes.proceedToCommit, {}),
    };
  }

  // compatibilityDecision.hardNavigationTarget (derived from responseUrl with _rsc stripped)
  // is intentionally not used here. For server actions, responseUrl is the action endpoint URL,
  // not the page URL the user should land on. The authoritative destinations are actionRedirectHref
  // (explicit redirect) and currentHref (reload in place) — both are set below.

  if (facts.actionRedirectHref !== null) {
    return {
      kind: "hardNavigate",
      url: facts.actionRedirectHref,
      historyMode: facts.actionRedirectType === "push" ? "assign" : "replace",
      clearClientNavigationCaches: true,
      reason: "serverActionRedirectCompatibilityMismatch",
      trace: createNavigationTrace(
        NavigationTraceReasonCodes.serverActionRedirectCompatibilityMismatch,
        { targetHref: facts.actionRedirectHref },
      ),
    };
  }

  // For a no-redirect RSC response, the executor should reload the current
  // document so the user stays on the same URL (including search params).
  const targetUrl = facts.currentHref;

  return {
    kind: "hardNavigate",
    url: targetUrl,
    clearClientNavigationCaches: false,
    reason: "serverActionRscCompatibilityMismatch",
    trace: createNavigationTrace(NavigationTraceReasonCodes.serverActionRscCompatibilityMismatch, {
      targetHref: targetUrl,
    }),
  };
}

function classifyRscNavigationError(facts: RscNavigationErrorFacts): RscNavigationErrorDecision {
  return {
    kind: "hardNavigate",
    url: facts.currentHref,
    reason: "rscNavigationError",
    trace: createNavigationTrace(NavigationTraceReasonCodes.rscNavigationError, {
      targetHref: facts.currentHref,
    }),
  };
}

export const navigationPlanner = {
  classifyEarlyNavigationIntent,
  classifyNavigationPrefetchProbe,
  classifyNavigationReuse,
  classifyRscFetchResult,
  classifyRscNavigationError,
  classifyRootBoundaryTransition,
  classifyServerActionResult,
  classifyVisitedResponseCacheCandidate,
  plan: planNavigation,
  resolveCurrentRootBoundaryElementPersistence,
  resolveMountedParallelSlotPersistence,
  resolveSameLayoutAncestorPersistence,
};
