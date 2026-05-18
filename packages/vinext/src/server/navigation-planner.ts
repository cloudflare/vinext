import type { RouteManifest } from "../routing/app-route-graph.js";
import { compareAppElementsSlotIds, type AppElementsSlotBinding } from "./app-elements.js";
import {
  NavigationTraceReasonCodes,
  createNavigationLifecycleTraceFields,
  createNavigationTrace,
  type NavigationTrace,
  type NavigationTraceFields,
  type NavigationTraceReasonCode,
} from "./navigation-trace.js";

export type OperationLane =
  | "hmr"
  | "navigation"
  | "prefetch"
  | "refresh"
  | "server-action"
  | "traverse";

export type OperationToken = {
  operationId: number;
  lane: OperationLane;
  baseVisibleCommitVersion: number;
  graphVersion: string | null;
  deploymentVersion: string | null;
  targetSnapshotFingerprint: string;
  cacheVariantFingerprint?: string;
};

export type RouteSnapshotV0 = {
  interception: InterceptionSnapshotV0 | null;
  interceptionContext: string | null;
  routeId: string;
  // Ordered ancestor-first, with the root layout at index 0. Same-layout
  // persistence uses prefix comparison, so callers must preserve this order.
  layoutIds: readonly string[];
  mountedParallelSlots: readonly MountedParallelSlotSnapshotV0[];
  rootBoundaryId: string | null;
  displayUrl: string;
  matchedUrl: string;
  slotBindings: readonly ParallelSlotBindingSnapshotV0[];
};

export type InterceptionSnapshotV0 = {
  sourceMatchedUrl: string;
  sourceRouteId: string;
  slotId: string;
  targetMatchedUrl: string;
  targetRouteId: string;
};

export type MountedParallelSlotSnapshotV0 = {
  slotId: string;
  ownerLayoutId: string | null;
};

// Planner snapshots consume the same canonical slot-binding facts decoded from
// AppElements metadata. Keep the alias explicit so route-state and transport
// readers cannot drift into structurally identical but semantically separate
// shapes.
export type ParallelSlotBindingSnapshotV0 = AppElementsSlotBinding;

export type NavigationPlannerStateV0 = {
  // V0 keeps a single state shape so intent events and result events can move
  // through one planner surface. flightResponseArrived uses event.token; later
  // #726 slices can split this by event kind once more result paths are routed
  // through the planner.
  nextOperationToken: OperationToken;
  // Callers that have lifecycle authority should pass the complete trace
  // context. When absent, the planner emits the stable root-boundary facts it
  // can derive from the event and visible snapshot.
  traceFields?: NavigationTraceFields;
  visibleCommitVersion: number;
  visibleSnapshot: RouteSnapshotV0;
};

export type RefreshScope = "visible";
export type TraverseDirection = "back" | "forward" | "unknown";

export type NavigationEvent =
  | { kind: "navigate"; href: string; mode: "push" | "replace" }
  | { kind: "refresh"; scope: RefreshScope }
  | { kind: "traverse"; direction: TraverseDirection; historyState: unknown }
  | { kind: "prefetch"; href: string }
  | { kind: "flightResponseArrived"; token: OperationToken; result: FlightResultV0 };

export type RequestedWork =
  | { kind: "flight"; href: string; mode: "push" | "replace" | "refresh" }
  | { direction: TraverseDirection; historyState: unknown; kind: "traverseFlight" }
  | { kind: "prefetch"; href: string };

export type CommitProposal = {
  preserveAbsentSlots: boolean;
  preserveElementIds: readonly string[];
  preservePreviousSlotIds: readonly string[];
  reason: "currentRootBoundary" | "interceptedCurrentRootBoundary" | "rootBoundaryUnknownFallback";
  targetSnapshot: RouteSnapshotV0;
};

export type NoCommitReason = "prefetchOnly";
export type HardNavigationReason = "interceptionProofRejected" | "rootBoundaryChanged";
export type RootBoundaryTransition =
  | "currentRootBoundary"
  | "rootBoundaryChanged"
  | "rootBoundaryUnknownFallback";

export type NavigationDecisionV0 =
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

export type FlightResultV0 = {
  href: string;
  targetSnapshot: RouteSnapshotV0;
};

export type NavigationPlannerInput = {
  // Reserved for #726-CORE-09 route-graph-aware planning. CORE-07/08 only
  // routes the existing root-boundary decision through the planner, so browser
  // callers pass null until route topology becomes part of the decision input.
  routeManifest: RouteManifest | null;
  state: NavigationPlannerStateV0;
  event: NavigationEvent;
};

function createRequestWorkDecision(options: {
  eventKind: NavigationEvent["kind"];
  state: NavigationPlannerStateV0;
  work: RequestedWork;
}): NavigationDecisionV0 {
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

function createRootBoundaryTraceFields(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  state: NavigationPlannerStateV0;
}): NavigationTraceFields {
  // Browser commit approval supplies lifecycle trace context before calling
  // the planner. This fallback exists for pure planner callers and tests; it
  // intentionally cannot invent lifecycle-only fields such as active nav id.
  return (
    options.state.traceFields ??
    createNavigationLifecycleTraceFields({
      currentRootLayoutTreePath: options.state.visibleSnapshot.rootBoundaryId,
      currentVisibleCommitVersion: options.state.visibleCommitVersion,
      nextRootLayoutTreePath: options.event.result.targetSnapshot.rootBoundaryId,
      startedVisibleCommitVersion: options.event.token.baseVisibleCommitVersion,
    })
  );
}

function classifyRootBoundaryTransition(
  currentRootBoundaryId: string | null,
  nextRootBoundaryId: string | null,
): RootBoundaryTransition {
  if (currentRootBoundaryId === null || nextRootBoundaryId === null) {
    // Both null directions intentionally share the v0 fallback because this
    // slice only knows boundary identity from the current flight payload.
    // #726-CORE-09 can split "unknown current" from "unknown target" once the
    // planner consumes graph-owned root boundary facts for both sides.
    return "rootBoundaryUnknownFallback";
  }

  return currentRootBoundaryId === nextRootBoundaryId
    ? "currentRootBoundary"
    : "rootBoundaryChanged";
}

function resolveSameLayoutAncestorPersistence(
  currentSnapshot: RouteSnapshotV0,
  targetSnapshot: RouteSnapshotV0,
): readonly string[] {
  if (
    classifyRootBoundaryTransition(
      currentSnapshot.rootBoundaryId,
      targetSnapshot.rootBoundaryId,
    ) !== "currentRootBoundary"
  ) {
    return [];
  }

  const commonLayoutIds: string[] = [];
  const maxLength = Math.min(currentSnapshot.layoutIds.length, targetSnapshot.layoutIds.length);
  for (let index = 0; index < maxLength; index++) {
    const layoutId = currentSnapshot.layoutIds[index];
    if (layoutId !== targetSnapshot.layoutIds[index]) break;
    commonLayoutIds.push(layoutId);
  }
  return commonLayoutIds;
}

function resolveMountedParallelSlotPersistence(
  currentSnapshot: RouteSnapshotV0,
  targetSnapshot: RouteSnapshotV0,
): readonly string[] {
  const preservedLayoutIds = resolveSameLayoutAncestorPersistence(currentSnapshot, targetSnapshot);
  return resolveMountedParallelSlotPersistenceForLayouts(currentSnapshot, preservedLayoutIds);
}

function resolveMountedParallelSlotPersistenceForLayouts(
  currentSnapshot: RouteSnapshotV0,
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
  currentSnapshot: RouteSnapshotV0,
  targetSnapshot: RouteSnapshotV0,
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
  currentSnapshot: RouteSnapshotV0;
  lane: OperationLane;
  targetSnapshot: RouteSnapshotV0;
}): readonly string[] {
  // Commit element persistence only keeps layout IDs. Default/unmatched slot
  // reuse is handled separately by preservePreviousSlotIds, using slot-binding
  // metadata as proof; payloads without __slotBindings get no semantic reuse.
  // resolveCurrentRootBoundaryCommitSlotPersistence recomputes this same
  // ancestor set; planner correctness relies on both calls agreeing so any
  // preserved slot's owner layout is also present in preserveElementIds.
  return resolveSameLayoutAncestorPersistence(options.currentSnapshot, options.targetSnapshot);
}

function resolveCurrentRootBoundaryCommitSlotPersistence(options: {
  currentSnapshot: RouteSnapshotV0;
  lane: OperationLane;
  targetSnapshot: RouteSnapshotV0;
}): readonly string[] {
  if (options.lane === "traverse") return [];

  const preservedLayoutIds = resolveSameLayoutAncestorPersistence(
    options.currentSnapshot,
    options.targetSnapshot,
  );
  if (preservedLayoutIds.length === 0) return [];

  return resolveDefaultOrUnmatchedSlotPersistenceForLayouts({
    currentSnapshot: options.currentSnapshot,
    preservedLayoutIds,
    targetSnapshot: options.targetSnapshot,
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
function resolveDefaultOrUnmatchedSlotPersistenceForLayouts(options: {
  currentSnapshot: RouteSnapshotV0;
  preservedLayoutIds: readonly string[];
  targetSnapshot: RouteSnapshotV0;
}): readonly string[] {
  const preservedLayoutIdSet = new Set(options.preservedLayoutIds);
  const slotIdsWithContent = new Set<string>();
  for (const binding of options.currentSnapshot.slotBindings) {
    if (binding.state === "unmatched") continue;
    slotIdsWithContent.add(binding.slotId);
  }

  const preservedSlotIds: string[] = [];
  const seenSlotIds = new Set<string>();
  for (const binding of options.targetSnapshot.slotBindings) {
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
  snapshot: RouteSnapshotV0,
): VisibleInterceptionSourceIdentity {
  if (snapshot.interception) {
    return {
      matchedUrl: snapshot.interception.sourceMatchedUrl,
      routeId: snapshot.interception.sourceRouteId,
    };
  }
  return {
    matchedUrl: snapshot.matchedUrl,
    routeId: snapshot.routeId,
  };
}

function createInterceptionProofRejectedDecision(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  reasonCode: NavigationTraceReasonCode;
  traceFields: NavigationTraceFields;
}): NavigationDecisionV0 {
  return {
    kind: "hardNavigate",
    reason: "interceptionProofRejected",
    token: options.event.token,
    trace: createNavigationTrace(options.reasonCode, options.traceFields),
    url: options.event.result.href,
  };
}

function validateInterceptedPreservation(options: {
  currentSnapshot: RouteSnapshotV0;
  targetSnapshot: RouteSnapshotV0;
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

  const preservedLayoutIds = resolveSameLayoutAncestorPersistence(
    options.currentSnapshot,
    options.targetSnapshot,
  );
  if (preservedLayoutIds.length === 0) {
    return {
      kind: "rejected",
      reasonCode: NavigationTraceReasonCodes.interceptedRejectedIncompatibleRoot,
    };
  }

  const preservedLayoutIdSet = new Set(preservedLayoutIds);
  const targetSlotBinding = options.targetSnapshot.slotBindings.find(
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

  const preservePreviousSlotIds = resolveDefaultOrUnmatchedSlotPersistenceForLayouts({
    currentSnapshot: options.currentSnapshot,
    preservedLayoutIds,
    targetSnapshot: options.targetSnapshot,
  }).filter((slotId) => slotId !== proof.slotId);

  return {
    kind: "approved",
    preserveElementIds: preservedLayoutIds,
    preservePreviousSlotIds,
  };
}

function planFlightResponseArrived(options: {
  event: Extract<NavigationEvent, { kind: "flightResponseArrived" }>;
  state: NavigationPlannerStateV0;
}): NavigationDecisionV0 {
  const traceFields = createRootBoundaryTraceFields(options);

  if (options.event.token.lane === "prefetch") {
    return {
      kind: "noCommit",
      reason: "prefetchOnly",
      token: options.event.token,
      trace: createNavigationTrace(NavigationTraceReasonCodes.prefetchOnly, traceFields),
    };
  }

  const targetSnapshot = options.event.result.targetSnapshot;
  // interceptionContext is transport evidence, not authority. Normal payloads
  // can carry it when a request was sent from an intercepted visible world, so
  // only explicit __interception proof enters the preservation branch.
  const hasInterceptedPayload = targetSnapshot.interception !== null;
  if (hasInterceptedPayload) {
    const validation = validateInterceptedPreservation({
      currentSnapshot: options.state.visibleSnapshot,
      targetSnapshot,
    });
    if (validation.kind === "rejected") {
      return createInterceptionProofRejectedDecision({
        event: options.event,
        reasonCode: validation.reasonCode,
        traceFields,
      });
    }

    return {
      kind: "proposeCommit",
      proposal: {
        preserveAbsentSlots: false,
        preserveElementIds: validation.preserveElementIds,
        preservePreviousSlotIds: validation.preservePreviousSlotIds,
        reason: "interceptedCurrentRootBoundary",
        targetSnapshot,
      },
      token: options.event.token,
      trace: createNavigationTrace(
        NavigationTraceReasonCodes.interceptedCommitCurrent,
        traceFields,
      ),
    };
  }

  const transition = classifyRootBoundaryTransition(
    options.state.visibleSnapshot.rootBoundaryId,
    targetSnapshot.rootBoundaryId,
  );

  if (transition === "rootBoundaryChanged") {
    return {
      kind: "hardNavigate",
      reason: "rootBoundaryChanged",
      token: options.event.token,
      trace: createNavigationTrace(NavigationTraceReasonCodes.rootBoundaryChanged, traceFields),
      url: options.event.result.href,
    };
  }

  if (transition === "rootBoundaryUnknownFallback") {
    // Unknown root identity is an uncertainty fallback, not evidence that
    // reuse is safe. #726-CORE-09 can delete the legacy soft-commit writer
    // once every promoted caller supplies graph-owned root boundary IDs from
    // the route graph read model documented in routing/app-router.ts.
    return {
      kind: "proposeCommit",
      proposal: {
        preserveAbsentSlots: true,
        preserveElementIds: [],
        preservePreviousSlotIds: [],
        reason: "rootBoundaryUnknownFallback",
        targetSnapshot,
      },
      token: options.event.token,
      trace: createNavigationTrace(NavigationTraceReasonCodes.rootBoundaryUnknown, traceFields),
    };
  }

  return {
    kind: "proposeCommit",
    proposal: {
      preserveAbsentSlots: false,
      preserveElementIds: resolveCurrentRootBoundaryCommitElementPersistence({
        currentSnapshot: options.state.visibleSnapshot,
        lane: options.event.token.lane,
        targetSnapshot,
      }),
      preservePreviousSlotIds: resolveCurrentRootBoundaryCommitSlotPersistence({
        currentSnapshot: options.state.visibleSnapshot,
        lane: options.event.token.lane,
        targetSnapshot,
      }),
      reason: "currentRootBoundary",
      targetSnapshot,
    },
    token: options.event.token,
    trace: createNavigationTrace(NavigationTraceReasonCodes.commitCurrent, traceFields),
  };
}

function planNavigation(input: NavigationPlannerInput): NavigationDecisionV0 {
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
        state: input.state,
      });
    default: {
      const _exhaustive: never = input.event;
      throw new Error("[vinext] Unknown navigation event: " + String(_exhaustive));
    }
  }
}

export const navigationPlanner = {
  classifyRootBoundaryTransition,
  plan: planNavigation,
  resolveCurrentRootBoundaryElementPersistence,
  resolveMountedParallelSlotPersistence,
  resolveSameLayoutAncestorPersistence,
};
