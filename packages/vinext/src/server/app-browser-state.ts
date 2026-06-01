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
  type MountedParallelSlotSnapshotV0,
  type NavigationDecisionV0,
  type OperationLane,
  type OperationToken,
  type RouteSnapshotV0,
} from "./navigation-planner.js";
import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";
export {
  createHistoryStateWithNavigationMetadata,
  createHistoryStateWithPreviousNextUrl,
  readHistoryStatePreviousNextUrl,
  readHistoryStateTraversalIndex,
  resolveHistoryTraversalIntent,
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

export type OperationRecord = PendingOperationRecord | CommittedOperationRecord;

export type AppRouterState = {
  activeOperation: OperationRecord | null;
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
  routeId: string;
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
  return metadata.cacheEntryReuseProof !== undefined;
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

  if (
    options.startedNavigationId !== options.activeNavigationId ||
    options.pending.action.operation.startedVisibleCommitVersion !==
      options.currentState.visibleCommitVersion
  ) {
    return {
      disposition: "skip",
      preserveElementIds: [],
      trace: createNavigationTrace(NavigationTraceReasonCodes.staleOperation, traceFields),
    };
  }

  return mapNavigationDecisionToPendingDisposition(
    planPendingRootBoundaryFlightResponse({
      currentState: options.currentState,
      pending: options.pending,
      routeManifest: options.routeManifest ?? null,
      targetHref: options.targetHref,
      traceFields,
    }),
  );
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

function createNavigationSnapshotUrl(snapshot: ClientNavigationRenderSnapshot): string {
  const query = snapshot.searchParams.toString();
  return query === "" ? snapshot.pathname : `${snapshot.pathname}?${query}`;
}

function createMountedParallelSlotSnapshots(
  elements: AppElements,
): readonly MountedParallelSlotSnapshotV0[] {
  const snapshots: MountedParallelSlotSnapshotV0[] = [];
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

function createVisibleRouteSnapshot(state: AppRouterState): RouteSnapshotV0 {
  const displayUrl = createNavigationSnapshotUrl(state.navigationSnapshot);
  const matchedUrl = normalizeNavigationSnapshotMatchedUrl(state.navigationSnapshot.pathname);
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

function createPendingRouteSnapshot(pending: PendingNavigationCommit): RouteSnapshotV0 {
  const displayUrl = createNavigationSnapshotUrl(pending.action.navigationSnapshot);
  const matchedUrl = normalizeNavigationSnapshotMatchedUrl(
    pending.action.navigationSnapshot.pathname,
  );
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
  targetSnapshot: RouteSnapshotV0;
}): OperationToken {
  return {
    baseVisibleCommitVersion: options.pending.action.operation.startedVisibleCommitVersion,
    deploymentVersion: null,
    graphVersion: options.routeManifest?.graphVersion ?? null,
    lane: options.pending.action.operation.lane,
    operationId: options.pending.action.operation.id,
    targetSnapshotFingerprint: createRootBoundarySnapshotFingerprint(options.targetSnapshot),
  };
}

function createRootBoundarySnapshotFingerprint(snapshot: RouteSnapshotV0): string {
  return `${snapshot.routeId}|root:${snapshot.rootBoundaryId ?? "unknown"}`;
}

function planPendingRootBoundaryFlightResponse(options: {
  currentState: AppRouterState;
  pending: PendingNavigationCommit;
  routeManifest: RouteManifest | null;
  targetHref?: string;
  traceFields: NavigationTraceFields;
}): NavigationDecisionV0 {
  const targetSnapshot = createPendingRouteSnapshot(options.pending);
  const token = createPendingNavigationOperationToken({
    pending: options.pending,
    routeManifest: options.routeManifest,
    targetSnapshot,
  });
  const cacheEntryReuseProof = options.pending.cacheEntryReuseProof;

  // #726-CORE-07/08 keeps the browser state layer as the lifecycle gate and
  // only translates committed AppElements metadata into planner snapshots.
  // RouteManifest now supplies graph-owned route topology while snapshots
  // continue to carry runtime state such as visible slot content.
  return navigationPlanner.plan({
    routeManifest: options.routeManifest,
    state: {
      nextOperationToken: token,
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
        href: options.targetHref ?? targetSnapshot.displayUrl,
        targetSnapshot,
      },
      token,
    },
  });
}

function mapNavigationDecisionToPendingDisposition(
  decision: NavigationDecisionV0,
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
      routeId: metadata.routeId,
      type: options.type,
    },
    // Convenience aliases — always equal their action.* counterparts.
    ...(cacheEntryReuseProof ? { cacheEntryReuseProof } : {}),
    interception: metadata.interception,
    interceptionContext: metadata.interceptionContext,
    previousNextUrl,
    rootLayoutTreePath: metadata.rootLayoutTreePath,
    routeId: metadata.routeId,
  };
}
