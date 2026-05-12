import { stripBasePath } from "../utils/base-path.js";
import {
  AppElementsWire,
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
  type NavigationDecisionV0,
  type OperationLane,
  type OperationToken,
  type RouteSnapshotV0,
} from "./navigation-planner.js";
import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";

const VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY = "__vinext_previousNextUrl";

type HistoryStateRecord = {
  [key: string]: unknown;
};

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
type PendingNavigationCommitDispositionDecision = {
  disposition: PendingNavigationCommitDisposition;
  preserveElementIds: readonly string[];
  trace: NavigationTrace;
};

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
): HistoryStateRecord | null {
  const nextState = cloneHistoryState(state);

  if (previousNextUrl === null) {
    delete nextState[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY];
  } else {
    nextState[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY] = previousNextUrl;
  }

  return Object.keys(nextState).length > 0 ? nextState : null;
}

export function readHistoryStatePreviousNextUrl(state: unknown): string | null {
  const value = cloneHistoryState(state)[VINEXT_PREVIOUS_NEXT_URL_HISTORY_STATE_KEY];
  return typeof value === "string" ? value : null;
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

function createVisibleRouteSnapshot(state: AppRouterState): RouteSnapshotV0 {
  const displayUrl = createNavigationSnapshotUrl(state.navigationSnapshot);
  return {
    displayUrl,
    layoutIds: state.layoutIds,
    // `displayUrl` preserves the browser-visible query string for decisions and
    // traces. `matchedUrl` stays path-only because route matching has already
    // consumed query params before AppElements metadata reaches this boundary.
    matchedUrl: state.navigationSnapshot.pathname,
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
