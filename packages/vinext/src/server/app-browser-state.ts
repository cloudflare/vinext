import { stripBasePath } from "../utils/base-path.js";
import {
  AppElementsWire,
  getMountedSlotIds,
  getMountedSlotIdsHeader,
  type AppElements,
  type LayoutFlags,
} from "./app-elements.js";
import { createRscRequestHeaders } from "./app-rsc-cache-busting.js";
import {
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
import {
  navigationPlanner,
  type MountedParallelSlotSnapshotV0,
  type NavigationDecisionV0,
  type OperationLane,
  type OperationToken,
  type RouteSnapshotV0,
} from "./navigation-planner.js";
import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";

const VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY = "__vinext_previousNextUrl";
const VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY = "__vinext_bfcacheIds";

type HistoryStateRecord = {
  [key: string]: unknown;
};

export type { OperationLane } from "./navigation-planner.js";

export type BfcacheIdMap = Readonly<Record<string, string>>;

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
  bfcacheIds: BfcacheIdMap;
  elements: AppElements;
  interceptionContext: string | null;
  layoutFlags: LayoutFlags;
  layoutIds: readonly string[];
  previousNextUrl: string | null;
  renderId: number;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  rootLayoutTreePath: string | null;
  routeId: string;
  visibleCommitVersion: number;
};

export type AppRouterAction = {
  bfcacheIds: BfcacheIdMap;
  elements: AppElements;
  interceptionContext: string | null;
  layoutFlags: LayoutFlags;
  layoutIds: readonly string[];
  navigationSnapshot: ClientNavigationRenderSnapshot;
  operation: PendingOperationRecord;
  previousNextUrl: string | null;
  renderId: number;
  rootLayoutTreePath: string | null;
  routeId: string;
  type: "navigate" | "replace" | "traverse";
};

export type PendingNavigationCommit = {
  action: AppRouterAction;
  interceptionContext: string | null;
  previousNextUrl: string | null;
  rootLayoutTreePath: string | null;
  routeId: string;
};

type PendingNavigationCommitDisposition = "dispatch" | "hard-navigate" | "skip";
type DispatchPendingNavigationCommitDispositionDecision = {
  disposition: "dispatch";
  preserveAbsentSlots: boolean;
  preserveElementIds: readonly string[];
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

let nextBfcacheId = 0;
const INITIAL_BFCACHE_ID = "0";

function cloneHistoryState(state: unknown): HistoryStateRecord {
  if (!state || typeof state !== "object") {
    return {};
  }

  const nextState: HistoryStateRecord = {};
  for (const [key, value] of Object.entries(state)) {
    nextState[key] = value;
  }
  return nextState;
}

export function createHistoryStateWithPreviousNextUrl(
  state: unknown,
  previousNextUrl: string | null,
  bfcacheIds?: BfcacheIdMap | null,
): HistoryStateRecord | null {
  const nextState = cloneHistoryState(state);

  if (previousNextUrl === null) {
    delete nextState[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY];
  } else {
    nextState[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY] = previousNextUrl;
  }

  if (bfcacheIds !== undefined) {
    if (bfcacheIds === null || Object.keys(bfcacheIds).length === 0) {
      delete nextState[VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY];
    } else {
      nextState[VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY] = { ...bfcacheIds };
    }
  }

  return Object.keys(nextState).length > 0 ? nextState : null;
}

export function readHistoryStatePreviousNextUrl(state: unknown): string | null {
  const value = cloneHistoryState(state)[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY];
  return typeof value === "string" ? value : null;
}

function rememberBfcacheId(value: string): void {
  const match = /^_b_(\d+)_$/.exec(value);
  if (!match) return;
  nextBfcacheId = Math.max(nextBfcacheId, Number(match[1]));
}

function mintBfcacheId(): string {
  nextBfcacheId += 1;
  return `_b_${nextBfcacheId}_`;
}

function isBfcacheSegmentId(id: string): boolean {
  const parsed = AppElementsWire.parseElementKey(id);
  return (
    parsed?.kind === "layout" ||
    parsed?.kind === "page" ||
    parsed?.kind === "slot" ||
    parsed?.kind === "template"
  );
}

function getPathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function getVisibleTreePathSegments(treePath: string): string[] {
  return treePath
    .split("/")
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")));
}

function getPathPrefix(pathname: string, segmentCount: number): string {
  if (segmentCount === 0) return "/";
  const segments = getPathSegments(pathname).slice(0, segmentCount);
  return `/${segments.join("/")}`;
}

function createBfcacheSegmentIdentity(id: string, pathname: string): string | null {
  const parsed = AppElementsWire.parseElementKey(id);
  if (!parsed) return null;

  if (parsed.kind === "page") {
    return `${id}@${pathname}`;
  }

  if (parsed.kind === "layout" || parsed.kind === "slot" || parsed.kind === "template") {
    const segmentCount = getVisibleTreePathSegments(parsed.treePath).length;
    return `${id}@${getPathPrefix(pathname, segmentCount)}`;
  }

  return null;
}

function collectBfcacheSegmentIds(elements: AppElements): string[] {
  const ids = new Set(Object.keys(elements));
  try {
    for (const layoutId of AppElementsWire.readMetadata(elements).layoutIds) {
      ids.add(layoutId);
    }
  } catch {
    // Some low-level tests pass partial element maps without metadata.
  }

  return Array.from(ids).filter(isBfcacheSegmentId);
}

export function createInitialBfcacheIdMap(elements: AppElements): BfcacheIdMap {
  const ids: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIds(elements)) {
    ids[id] = INITIAL_BFCACHE_ID;
  }
  return ids;
}

export function readHistoryStateBfcacheIds(state: unknown): BfcacheIdMap | null {
  const value = cloneHistoryState(state)[VINEXT_BFCACHE_IDS_HISTORY_STATE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const ids: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    if (!isBfcacheSegmentId(key) || typeof id !== "string") {
      return null;
    }
    ids[key] = id;
    rememberBfcacheId(id);
  }
  return ids;
}

export function createNextBfcacheIdMap(options: {
  current: BfcacheIdMap;
  currentPathname: string;
  elements: AppElements;
  nextPathname: string;
  restored?: BfcacheIdMap | null;
}): BfcacheIdMap {
  for (const value of Object.values(options.current)) {
    rememberBfcacheId(value);
  }
  for (const value of Object.values(options.restored ?? {})) {
    rememberBfcacheId(value);
  }

  const ids: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIds(options.elements)) {
    const currentIdentity = createBfcacheSegmentIdentity(id, options.currentPathname);
    const nextIdentity = createBfcacheSegmentIdentity(id, options.nextPathname);
    const currentValue = currentIdentity === nextIdentity ? options.current[id] : undefined;
    // History traversals restore persisted ids first, matching segments keep
    // their current id, and newly-created segments mint a fresh opaque id.
    const value = options.restored?.[id] ?? currentValue ?? mintBfcacheId();
    ids[id] = value;
    rememberBfcacheId(value);
  }
  return ids;
}

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
  return {
    displayUrl,
    layoutIds: state.layoutIds,
    // `displayUrl` preserves the browser-visible query string for decisions and
    // traces. `matchedUrl` stays path-only because route matching has already
    // consumed query params before AppElements metadata reaches this boundary.
    matchedUrl: state.navigationSnapshot.pathname,
    mountedParallelSlots: createMountedParallelSlotSnapshots(state.elements),
    rootBoundaryId: state.rootLayoutTreePath,
    routeId: state.routeId,
  };
}

function createPendingRouteSnapshot(pending: PendingNavigationCommit): RouteSnapshotV0 {
  const displayUrl = createNavigationSnapshotUrl(pending.action.navigationSnapshot);
  return {
    displayUrl,
    layoutIds: pending.action.layoutIds,
    // See createVisibleRouteSnapshot: matchedUrl intentionally models the route
    // identity, not the address bar URL.
    matchedUrl: pending.action.navigationSnapshot.pathname,
    mountedParallelSlots: createMountedParallelSlotSnapshots(pending.action.elements),
    rootBoundaryId: pending.rootLayoutTreePath,
    routeId: pending.routeId,
  };
}

function createPendingNavigationOperationToken(options: {
  pending: PendingNavigationCommit;
  targetSnapshot: RouteSnapshotV0;
}): OperationToken {
  return {
    baseVisibleCommitVersion: options.pending.action.operation.startedVisibleCommitVersion,
    deploymentVersion: null,
    graphVersion: null,
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
  targetHref?: string;
  traceFields: NavigationTraceFields;
}): NavigationDecisionV0 {
  const targetSnapshot = createPendingRouteSnapshot(options.pending);
  const token = createPendingNavigationOperationToken({
    pending: options.pending,
    targetSnapshot,
  });

  // #726-CORE-07/08 keeps the browser state layer as the lifecycle gate and
  // only translates committed AppElements metadata into planner snapshots.
  // The planner owns the root-boundary decision; later #726 route-graph work
  // should replace these client-visible snapshots with the read model called
  // out in routing/app-router.ts instead of adding more local topology checks.
  return navigationPlanner.plan({
    routeManifest: null,
    state: {
      nextOperationToken: token,
      traceFields: options.traceFields,
      visibleCommitVersion: options.currentState.visibleCommitVersion,
      visibleSnapshot: createVisibleRouteSnapshot(options.currentState),
    },
    event: {
      kind: "flightResponseArrived",
      result: {
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
  previousNextUrl?: string | null;
  renderId: number;
  restoredBfcacheIds?: BfcacheIdMap | null;
  type: "navigate" | "replace" | "traverse";
}): Promise<PendingNavigationCommit> {
  const elements = await options.nextElements;
  const metadata = AppElementsWire.readMetadata(elements);
  const previousNextUrl =
    options.previousNextUrl !== undefined
      ? options.previousNextUrl
      : options.currentState.previousNextUrl;

  return {
    action: {
      bfcacheIds: createNextBfcacheIdMap({
        current: options.currentState.bfcacheIds,
        currentPathname: options.currentState.navigationSnapshot.pathname,
        elements,
        nextPathname: options.navigationSnapshot.pathname,
        restored: options.restoredBfcacheIds,
      }),
      elements,
      interceptionContext: metadata.interceptionContext,
      layoutIds: metadata.layoutIds,
      layoutFlags: metadata.layoutFlags,
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
    // Convenience aliases — always equal action.interceptionContext / action.rootLayoutTreePath / action.routeId.
    interceptionContext: metadata.interceptionContext,
    previousNextUrl,
    rootLayoutTreePath: metadata.rootLayoutTreePath,
    routeId: metadata.routeId,
  };
}
