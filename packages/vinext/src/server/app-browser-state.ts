import { stripBasePath } from "../utils/base-path.js";
import type { RouteManifest } from "../routing/app-route-graph.js";
import {
  AppElementsWire,
  getMountedSlotIds,
  getMountedSlotIdsHeader,
  type AppElements,
  type AppElementsInterception,
  type AppElementsSlotBinding,
  type LayoutFlags,
} from "./app-elements.js";
import { createRscRequestHeaders } from "./app-rsc-cache-busting.js";
import {
  NEXT_ACTION_HEADER,
  RSC_ACTION_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
} from "./headers.js";
import {
  NavigationTraceReasonCodes,
  createNavigationLifecycleTraceFields,
  createNavigationTrace,
  type NavigationTrace,
  type NavigationTraceFields,
} from "./navigation-trace.js";
import { createCacheEntryReuseProof, type CacheEntryReuseProof } from "./cache-proof.js";
import {
  navigationPlanner,
  resolveDefaultOrUnmatchedSlotPersistenceForLayouts,
  type MountedParallelSlotSnapshot,
  type NavigationDecision,
  type OperationLane,
  type OperationToken,
  type RouteSnapshot,
} from "./navigation-planner.js";
import { verifyOperationTokenForCommit, type VerifiedOperationToken } from "./operation-token.js";
import {
  createSnapshotPathAndSearch,
  type ClientNavigationRenderSnapshot,
} from "vinext/shims/navigation";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";
import type { BfcacheIdMap } from "./app-history-state.js";
import { createNextBfcacheIdMap } from "./app-bfcache-identity.js";

export {
  createBfcacheSegmentStateKeyMap,
  createInitialBfcacheIdMap,
  createNextBfcacheIdMap,
  preserveBfcacheIdsForMergedElements,
} from "./app-bfcache-identity.js";

export {
  createHistoryStateWithNavigationMetadata,
  createHistoryStateWithPreviousNextUrl,
  isHistoryStateBfcacheVersionCurrent,
  readHistoryStateBfcacheIds,
  readHistoryStateBfcacheVersion,
  readHistoryStatePreviousNextUrl,
  readHistoryStateTraversalIndex,
  resolveHistoryTraversalIntent,
  type BfcacheIdMap,
  type HistoryTraversalIntent,
} from "./app-history-state.js";

export type { OperationLane } from "./navigation-planner.js";

type OperationRecordBase = {
  id: number;
  lane: OperationLane;
  startedVisibleCommitVersion: number;
};

export type PendingOperationRecord = OperationRecordBase & {
  state: "pending";
};

export type CommittedOperationRecord = OperationRecordBase & {
  state: "committed";
  visibleCommitVersion: number;
};

type OperationRecord = PendingOperationRecord | CommittedOperationRecord;

export type AppRouterState = {
  activeOperation: OperationRecord | null;
  bfcacheIds: BfcacheIdMap;
  elements: AppElements;
  interception: AppElementsInterception | null;
  interceptionContext: string | null;
  layoutFlags: LayoutFlags;
  layoutIds: readonly string[];
  previousNextUrl: string | null;
  renderId: number;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  rootLayoutTreePath: string | null;
  routeId: string;
  slotBindings: readonly AppElementsSlotBinding[];
  visibleCommitVersion: number;
};

export type AppRouterAction = {
  bfcacheIds: BfcacheIdMap;
  cacheEntryReuseProof?: CacheEntryReuseProof;
  elements: AppElements;
  interception: AppElementsInterception | null;
  interceptionContext: string | null;
  layoutFlags: LayoutFlags;
  layoutIds: readonly string[];
  navigationSnapshot: ClientNavigationRenderSnapshot;
  operation: PendingOperationRecord;
  previousNextUrl: string | null;
  renderId: number;
  rootLayoutTreePath: string | null;
  reuseCurrentBfcacheIds: boolean;
  routeId: string;
  skippedLayoutIds: readonly string[];
  slotBindings: readonly AppElementsSlotBinding[];
  type: "navigate" | "replace" | "traverse";
};

export type PendingNavigationCommit = {
  action: AppRouterAction;
  cacheEntryReuseProof?: CacheEntryReuseProof;
  interception: AppElementsInterception | null;
  interceptionContext: string | null;
  previousNextUrl: string | null;
  rootLayoutTreePath: string | null;
  routeId: string;
  skippedLayoutIds: readonly string[];
};

export type AppNavigationPayloadOrigin = Readonly<
  { origin: "fresh" } | { origin: "visited-cache" }
>;

export const FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN: AppNavigationPayloadOrigin = {
  origin: "fresh",
};
export const VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN: AppNavigationPayloadOrigin = {
  origin: "visited-cache",
};

type PendingNavigationCommitDisposition = "dispatch" | "hard-navigate" | "skip";
type CacheRestorableAppPayloadMetadata = Readonly<{
  cacheEntryReuseProof?: CacheEntryReuseProof;
  skippedLayoutIds: readonly string[];
}>;
type DispatchPendingNavigationCommitDispositionDecision = {
  disposition: "dispatch";
  preserveAbsentSlots: boolean;
  preserveElementIds: readonly string[];
  preservePreviousSlotIds: readonly string[];
  trace: NavigationTrace;
};
type NonDispatchPendingNavigationCommitDispositionDecision = {
  disposition: Exclude<PendingNavigationCommitDisposition, "dispatch">;
  preserveElementIds: readonly [];
  trace: NavigationTrace;
};
type PendingNavigationCommitDispositionDecision =
  | DispatchPendingNavigationCommitDispositionDecision
  | NonDispatchPendingNavigationCommitDispositionDecision;

function createOperationRecord(options: {
  id: number;
  lane: OperationLane;
  startedVisibleCommitVersion: number;
}): PendingOperationRecord {
  return {
    id: options.id,
    lane: options.lane,
    startedVisibleCommitVersion: options.startedVisibleCommitVersion,
    state: "pending",
  };
}

export function isCacheRestorableAppPayloadMetadata(
  metadata: CacheRestorableAppPayloadMetadata,
): metadata is CacheRestorableAppPayloadMetadata & { cacheEntryReuseProof: CacheEntryReuseProof } {
  return metadata.cacheEntryReuseProof !== undefined && metadata.skippedLayoutIds.length === 0;
}

function requiresCacheEntryReuseProof(origin: AppNavigationPayloadOrigin): boolean {
  switch (origin.origin) {
    case "fresh":
      return false;
    case "visited-cache":
      return true;
    default: {
      const _exhaustive: never = origin;
      throw new Error("[vinext] Unknown App Router payload origin: " + String(_exhaustive));
    }
  }
}

function normalizeNavigationSnapshotMatchedUrl(pathname: string): string {
  return normalizePath(normalizePathnameForRouteMatch(pathname));
}

function createRouteSnapshotRouteId(options: {
  interception: AppElementsInterception | null;
  routeId: string;
}): string {
  if (options.interception !== null) return options.routeId;

  const parsed = AppElementsWire.parseElementKey(options.routeId);
  if (parsed?.kind !== "route" || parsed.interceptionContext === null) {
    return options.routeId;
  }

  // A context suffix keeps AppElements render keys partitioned, but without
  // explicit interception proof it is not semantic route authority.
  return AppElementsWire.encodeRouteId(parsed.path, null);
}

export function resolveInterceptionContextFromPreviousNextUrl(
  previousNextUrl: string | null,
  basePath: string = "",
): string | null {
  if (previousNextUrl === null) {
    return null;
  }

  const parsedUrl = new URL(previousNextUrl, "http://localhost");
  return stripBasePath(parsedUrl.pathname, basePath);
}

type ResolveServerActionRequestStateOptions = {
  actionId: string;
  basePath: string;
  elements: AppElements;
  previousNextUrl: string | null;
};

type ResolveServerActionRequestStateResult = {
  headers: Headers;
};

/**
 * Pure: builds the fetch Headers for a server-action POST. Carries the same
 * interception-context and mounted-slots headers the refresh path already
 * sends, so the server-action re-render can rebuild the intercepted tree
 * instead of replacing it with the direct route.
 *
 * Next.js sends `Next-URL: state.previousNextUrl || state.nextUrl` on action
 * POSTs when `hasInterceptionRouteInCurrentTree(state.tree)`. Vinext's
 * X-Vinext-Interception-Context is the equivalent signal for the server-side
 * `findIntercept` lookup.
 */
export function resolveServerActionRequestState(
  options: ResolveServerActionRequestStateOptions,
): ResolveServerActionRequestStateResult {
  const headers = createRscRequestHeaders();
  headers.set(RSC_ACTION_HEADER, options.actionId);
  headers.set(NEXT_ACTION_HEADER, options.actionId);

  const interceptionContext = resolveInterceptionContextFromPreviousNextUrl(
    options.previousNextUrl,
    options.basePath,
  );
  if (interceptionContext !== null) {
    headers.set(VINEXT_INTERCEPTION_CONTEXT_HEADER, interceptionContext);
  }

  const mountedSlotsHeader = getMountedSlotIdsHeader(options.elements);
  if (mountedSlotsHeader !== null) {
    headers.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
  }

  return { headers };
}

export function resolvePendingNavigationCommitDispositionDecision(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  pending: PendingNavigationCommit;
  routeManifest?: RouteManifest | null;
  startedNavigationId: number;
  targetHref?: string;
}): PendingNavigationCommitDispositionDecision {
  const traceFields = createPendingNavigationTraceFields(options);
  const targetSnapshot = createPendingRouteSnapshot(options.pending);
  const token = createPendingNavigationOperationToken({
    pending: options.pending,
    routeManifest: options.routeManifest ?? null,
    startedNavigationId: options.startedNavigationId,
    targetSnapshot,
  });

  // OperationToken is the single eligibility authority for commit approval: a
  // result may enter commit approval only if its token proves it belongs to the
  // active navigation and the visible commit version it started from is still
  // current. The token verifies; ApprovedVisibleCommit (downstream) mutates.
  const verdict = verifyOperationTokenForCommit(token, {
    activeNavigationId: options.activeNavigationId,
    visibleCommitVersion: options.currentState.visibleCommitVersion,
  });
  if (!verdict.authorized) {
    // staleOperation — the navigation that created `pending` was superseded, or
    // visible state advanced after it started. The latter happens when a
    // synchronous history snapshot restore (restoreHistoryStateSnapshot, see
    // app-browser-entry.ts popstate handler) bumps visibleCommitVersion before
    // an in-flight async RSC traverse resolves. The authoritative commit wins;
    // the stale async payload is intentionally discarded.
    return {
      disposition: "skip",
      preserveElementIds: [],
      trace: createNavigationTrace(NavigationTraceReasonCodes.staleOperation, traceFields),
    };
  }

  const decision = mapNavigationDecisionToPendingDisposition(
    planPendingRootBoundaryFlightResponse({
      currentState: options.currentState,
      pending: options.pending,
      routeManifest: options.routeManifest ?? null,
      targetHref: options.targetHref,
      targetSnapshot,
      token: verdict.token,
      traceFields,
    }),
  );

  return mergeSkippedLayoutPreservation({
    currentState: options.currentState,
    decision,
    pending: options.pending,
  });
}

function createPendingNavigationTraceFields(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  pending: PendingNavigationCommit;
  startedNavigationId: number;
  targetHref?: string;
}): NavigationTraceFields {
  return {
    ...createNavigationLifecycleTraceFields({
      activeNavigationId: options.activeNavigationId,
      currentRootLayoutTreePath: options.currentState.rootLayoutTreePath,
      currentVisibleCommitVersion: options.currentState.visibleCommitVersion,
      nextRootLayoutTreePath: options.pending.rootLayoutTreePath,
      startedNavigationId: options.startedNavigationId,
      startedVisibleCommitVersion: options.pending.action.operation.startedVisibleCommitVersion,
    }),
    ...(options.targetHref !== undefined ? { targetHref: options.targetHref } : {}),
  };
}

function createMountedParallelSlotSnapshots(
  elements: AppElements,
): readonly MountedParallelSlotSnapshot[] {
  const snapshots: MountedParallelSlotSnapshot[] = [];
  for (const slotId of getMountedSlotIds(elements)) {
    const parsed = AppElementsWire.parseElementKey(slotId);
    if (parsed?.kind !== "slot") continue;
    snapshots.push({
      ownerLayoutId: AppElementsWire.encodeLayoutId(parsed.treePath),
      slotId,
    });
  }
  return snapshots;
}

function createVisibleRouteSnapshot(state: AppRouterState): RouteSnapshot {
  const displayUrl = createSnapshotPathAndSearch(state.navigationSnapshot);
  const matchedUrl =
    state.interception?.targetMatchedUrl ??
    normalizeNavigationSnapshotMatchedUrl(state.navigationSnapshot.pathname);
  return {
    displayUrl,
    interception: state.interception,
    interceptionContext: state.interceptionContext,
    layoutIds: state.layoutIds,
    // `displayUrl` preserves the browser-visible URL for decisions and traces.
    // `matchedUrl` uses the route-state canonical pathname, matching the
    // server's segment-decoded representation without changing user-facing
    // navigation state such as usePathname().
    matchedUrl,
    mountedParallelSlots: createMountedParallelSlotSnapshots(state.elements),
    rootBoundaryId: state.rootLayoutTreePath,
    routeId: createRouteSnapshotRouteId({
      interception: state.interception,
      routeId: state.routeId,
    }),
    slotBindings: state.slotBindings,
  };
}

function createPendingRouteSnapshot(pending: PendingNavigationCommit): RouteSnapshot {
  const displayUrl = createSnapshotPathAndSearch(pending.action.navigationSnapshot);
  const matchedUrl =
    pending.action.interception?.targetMatchedUrl ??
    normalizeNavigationSnapshotMatchedUrl(pending.action.navigationSnapshot.pathname);
  return {
    displayUrl,
    interception: pending.action.interception,
    interceptionContext: pending.action.interceptionContext,
    layoutIds: pending.action.layoutIds,
    // See createVisibleRouteSnapshot: matchedUrl intentionally models the route
    // identity, not the address bar URL.
    matchedUrl,
    mountedParallelSlots: createMountedParallelSlotSnapshots(pending.action.elements),
    rootBoundaryId: pending.rootLayoutTreePath,
    routeId: createRouteSnapshotRouteId({
      interception: pending.action.interception,
      routeId: pending.routeId,
    }),
    slotBindings: pending.action.slotBindings,
  };
}

function createPendingNavigationOperationToken(options: {
  pending: PendingNavigationCommit;
  routeManifest: RouteManifest | null;
  startedNavigationId: number;
  targetSnapshot: RouteSnapshot;
}): OperationToken {
  return {
    baseVisibleCommitVersion: options.pending.action.operation.startedVisibleCommitVersion,
    deploymentVersion: null,
    graphVersion: options.routeManifest?.graphVersion ?? null,
    lane: options.pending.action.operation.lane,
    // The lifecycle navigation id the operation started under. operationId
    // (renderId) cannot answer "belongs to the active navigation?" because it is
    // a per-render counter; navigationId carries that lifecycle authority.
    navigationId: options.startedNavigationId,
    operationId: options.pending.action.operation.id,
    targetSnapshotFingerprint: createRootBoundarySnapshotFingerprint(options.targetSnapshot),
  };
}

function createRootBoundarySnapshotFingerprint(snapshot: RouteSnapshot): string {
  return `${snapshot.routeId}|root:${snapshot.rootBoundaryId ?? "unknown"}`;
}

function planPendingRootBoundaryFlightResponse(options: {
  currentState: AppRouterState;
  pending: PendingNavigationCommit;
  routeManifest: RouteManifest | null;
  targetHref?: string;
  // The token has already passed commit eligibility (verifyOperationTokenForCommit)
  // in the disposition gate above. Requiring the verified brand here makes that
  // ordering a compile-time guarantee: the planner cannot be reached with an
  // unverified token.
  token: VerifiedOperationToken;
  targetSnapshot: RouteSnapshot;
  traceFields: NavigationTraceFields;
}): NavigationDecision {
  const cacheEntryReuseProof = options.pending.cacheEntryReuseProof;

  // #726-CORE-07/08 keeps the browser state layer as the lifecycle gate and
  // only translates committed AppElements metadata into planner snapshots.
  // RouteManifest now supplies graph-owned route topology while snapshots
  // continue to carry runtime state such as visible slot content.
  return navigationPlanner.plan({
    routeManifest: options.routeManifest,
    state: {
      nextOperationToken: options.token,
      traceFields: options.traceFields,
      visibleCommitVersion: options.currentState.visibleCommitVersion,
      visibleSnapshot: createVisibleRouteSnapshot(options.currentState),
    },
    event: {
      kind: "flightResponseArrived",
      result: {
        ...(cacheEntryReuseProof ? { cacheEntryReuseProof } : {}),
        // Approval call sites must pass the executor's targetHref so the
        // planner trace and future hard-nav executor agree with the browser
        // URL. The fallback remains for lower-level tests and direct disposition
        // callers that exercise only snapshot-derived planner semantics.
        href: options.targetHref ?? options.targetSnapshot.displayUrl,
        targetSnapshot: options.targetSnapshot,
      },
      token: options.token,
    },
  });
}

function mapNavigationDecisionToPendingDisposition(
  decision: NavigationDecision,
): PendingNavigationCommitDispositionDecision {
  switch (decision.kind) {
    case "proposeCommit":
      return {
        disposition: "dispatch",
        preserveAbsentSlots: decision.proposal.preserveAbsentSlots,
        preserveElementIds: decision.proposal.preserveElementIds,
        preservePreviousSlotIds: decision.proposal.preservePreviousSlotIds,
        trace: decision.trace,
      };
    case "hardNavigate":
      return { disposition: "hard-navigate", preserveElementIds: [], trace: decision.trace };
    case "noCommit":
      return { disposition: "skip", preserveElementIds: [], trace: decision.trace };
    case "requestWork":
      throw new Error(
        `[vinext] Root-boundary commit planning returned requestWork (${decision.work.kind}); flightResponseArrived should never request work`,
      );
    default: {
      const _exhaustive: never = decision;
      throw new Error("[vinext] Unknown navigation decision: " + String(_exhaustive));
    }
  }
}

function mergeSkippedLayoutPreservation(options: {
  currentState: AppRouterState;
  decision: PendingNavigationCommitDispositionDecision;
  pending: PendingNavigationCommit;
}): PendingNavigationCommitDispositionDecision {
  if (options.decision.disposition !== "dispatch") return options.decision;
  if (options.pending.skippedLayoutIds.length === 0) return options.decision;

  const currentLayoutIds = new Set(options.currentState.layoutIds);
  const targetLayoutIds = new Set(options.pending.action.layoutIds);
  const preserveElementIds = [...options.decision.preserveElementIds];
  const seenPreservedIds = new Set(preserveElementIds);
  const newlyPreservedLayoutIds: string[] = [];

  for (const id of options.pending.skippedLayoutIds) {
    if (seenPreservedIds.has(id)) continue;
    if (AppElementsWire.parseElementKey(id)?.kind !== "layout") continue;
    // Set membership here is intentionally broader than the planner's
    // prefix-based persistence (resolveSameLayoutAncestorPersistenceForTopologies
    // breaks at the first divergence). A layout present in both the current and
    // target chains but past that divergence point is admitted here even though
    // the planner would not preserve it. That is correct rather than a
    // divergence bug: the server only emits a skip for a layout it proved
    // byte-identical via the static-layout cache proof, so preserving the
    // retained-and-identical layout — together with its owned slots derived
    // below — is sound regardless of ancestor-chain position.
    if (!currentLayoutIds.has(id) || !targetLayoutIds.has(id)) continue;
    if (!Object.hasOwn(options.currentState.elements, id)) continue;

    preserveElementIds.push(id);
    seenPreservedIds.add(id);
    newlyPreservedLayoutIds.push(id);
  }

  if (newlyPreservedLayoutIds.length === 0) {
    return options.decision;
  }

  // Restoring a skipped layout into preserveElementIds without restoring the
  // default/unmatched parallel slots it owns would break the planner invariant
  // documented at resolveCurrentRootBoundaryCommitElementPersistence: every
  // preserved slot's owner layout is present in preserveElementIds, and vice
  // versa. The topology-unknown path returns empty slot persistence, so a
  // slot-owning layout skipped server-side would otherwise commit with a
  // missing slot (mergeElements starts from the next payload and, with
  // preserveAbsentSlots: false, never restores it). Derive the owned slots the
  // same way the planner does so the preserved layout keeps its slot content.
  const preservePreviousSlotIds = mergeSkippedLayoutSlotPreservation({
    currentSlotBindings: options.currentState.slotBindings,
    preservePreviousSlotIds: options.decision.preservePreviousSlotIds,
    skippedLayoutIds: newlyPreservedLayoutIds,
    targetSlotBindings: options.pending.action.slotBindings,
  });

  return {
    ...options.decision,
    preserveElementIds,
    preservePreviousSlotIds,
  };
}

function mergeSkippedLayoutSlotPreservation(options: {
  currentSlotBindings: readonly AppElementsSlotBinding[];
  preservePreviousSlotIds: readonly string[];
  skippedLayoutIds: readonly string[];
  targetSlotBindings: readonly AppElementsSlotBinding[];
}): readonly string[] {
  const ownedSlotIds = resolveDefaultOrUnmatchedSlotPersistenceForLayouts({
    currentSlotBindings: options.currentSlotBindings,
    preservedLayoutIds: options.skippedLayoutIds,
    targetSlotBindings: options.targetSlotBindings,
  });
  if (ownedSlotIds.length === 0) return options.preservePreviousSlotIds;

  const preservePreviousSlotIds = [...options.preservePreviousSlotIds];
  const seenSlotIds = new Set(preservePreviousSlotIds);
  for (const slotId of ownedSlotIds) {
    if (seenSlotIds.has(slotId)) continue;
    preservePreviousSlotIds.push(slotId);
    seenSlotIds.add(slotId);
  }
  return preservePreviousSlotIds;
}

export async function createPendingNavigationCommit(options: {
  currentState: AppRouterState;
  nextElements: Promise<AppElements>;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  operationLane: OperationLane;
  payloadOrigin: AppNavigationPayloadOrigin;
  // Advisory: non-intercepted responses clear this even when callers pass the
  // current visible previousNextUrl.
  previousNextUrl?: string | null;
  renderId: number;
  restoredBfcacheIds?: BfcacheIdMap | null;
  reuseCurrentBfcacheIds?: boolean;
  type: "navigate" | "replace" | "traverse";
}): Promise<PendingNavigationCommit> {
  const elements = await options.nextElements;
  const metadata = AppElementsWire.readMetadata(elements);
  const cacheEntryReuseProof =
    metadata.cacheEntryReuseProof ??
    (requiresCacheEntryReuseProof(options.payloadOrigin)
      ? createCacheEntryReuseProof(null)
      : undefined);
  const requestedPreviousNextUrl =
    options.previousNextUrl !== undefined
      ? options.previousNextUrl
      : options.currentState.previousNextUrl;
  const previousNextUrl = metadata.interception === null ? null : requestedPreviousNextUrl;

  return {
    action: {
      bfcacheIds: createNextBfcacheIdMap({
        current: options.currentState.bfcacheIds,
        currentElements: options.currentState.elements,
        currentPathname: options.currentState.navigationSnapshot.pathname,
        elements,
        nextPathname: options.navigationSnapshot.pathname,
        restored: options.restoredBfcacheIds,
        reuseCurrent: options.reuseCurrentBfcacheIds,
      }),
      ...(cacheEntryReuseProof ? { cacheEntryReuseProof } : {}),
      elements,
      interception: metadata.interception,
      interceptionContext: metadata.interceptionContext,
      layoutIds: metadata.layoutIds,
      layoutFlags: metadata.layoutFlags,
      slotBindings: metadata.slotBindings,
      navigationSnapshot: options.navigationSnapshot,
      operation: createOperationRecord({
        id: options.renderId,
        lane: options.operationLane,
        startedVisibleCommitVersion: options.currentState.visibleCommitVersion,
      }),
      previousNextUrl,
      renderId: options.renderId,
      rootLayoutTreePath: metadata.rootLayoutTreePath,
      reuseCurrentBfcacheIds: options.reuseCurrentBfcacheIds ?? true,
      routeId: metadata.routeId,
      skippedLayoutIds: metadata.skippedLayoutIds,
      type: options.type,
    },
    // Convenience aliases — always equal their action.* counterparts.
    ...(cacheEntryReuseProof ? { cacheEntryReuseProof } : {}),
    interception: metadata.interception,
    interceptionContext: metadata.interceptionContext,
    previousNextUrl,
    rootLayoutTreePath: metadata.rootLayoutTreePath,
    routeId: metadata.routeId,
    skippedLayoutIds: metadata.skippedLayoutIds,
  };
}
