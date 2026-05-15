import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import { mergeElements } from "vinext/shims/slot";
import type { AppElements } from "./app-elements.js";
import {
  createPendingNavigationCommit,
  resolvePendingNavigationCommitDispositionDecision,
  type AppRouterAction,
  type AppRouterState,
  type CommittedOperationRecord,
  type OperationLane,
  type PendingNavigationCommit,
  type PendingOperationRecord,
} from "./app-browser-state.js";
import {
  NavigationTraceReasonCodes,
  NavigationTraceTransactionCodes,
  createNavigationTrace,
  prependNavigationTraceEntry,
  type NavigationTrace,
  type NavigationTraceFields,
  type NavigationTraceTransactionCode,
} from "./navigation-trace.js";

type VisibleCommitDecision = {
  disposition: "commit";
  preserveAbsentSlots: boolean;
  preserveElementIds: readonly string[];
  trace: NavigationTrace;
};
type HardNavigateCommitDecision = {
  disposition: "hard-navigate";
  trace: NavigationTrace;
};
type NoCommitDecision = {
  disposition: "no-commit";
  trace: NavigationTrace;
};
type CommitDecision = VisibleCommitDecision | HardNavigateCommitDecision | NoCommitDecision;
const approvedVisibleCommitBrand: unique symbol = Symbol("ApprovedVisibleCommit");
export type ApprovedVisibleCommit = {
  readonly [approvedVisibleCommitBrand]: true;
  readonly action: AppRouterAction;
  readonly decision: VisibleCommitDecision;
  readonly interceptionContext: string | null;
  readonly previousNextUrl: string | null;
  readonly rootLayoutTreePath: string | null;
  readonly routeId: string;
};
type VisibleCommitApproval = {
  approvedCommit: ApprovedVisibleCommit;
  decision: VisibleCommitDecision;
};
type NonVisibleCommitApproval = {
  approvedCommit: null;
  decision: HardNavigateCommitDecision | NoCommitDecision;
};
type CommitApproval = VisibleCommitApproval | NonVisibleCommitApproval;
type ClassifiedPendingNavigationCommit = {
  approvedCommit: ApprovedVisibleCommit | null;
  decision: CommitDecision;
  pending: PendingNavigationCommit;
  trace: NavigationTrace;
};

export function applyApprovedVisibleCommit(
  state: AppRouterState,
  commit: ApprovedVisibleCommit,
): AppRouterState {
  assertApprovedVisibleCommit(commit);
  return reduceApprovedVisibleCommitState(state, commit);
}

function assertApprovedVisibleCommit(commit: ApprovedVisibleCommit): void {
  if (commit[approvedVisibleCommitBrand] !== true) {
    throw new Error("[vinext] Visible router state mutation requires ApprovedVisibleCommit");
  }
}

function commitOperationRecord(
  operation: PendingOperationRecord,
  visibleCommitVersion: number,
): CommittedOperationRecord {
  return {
    id: operation.id,
    lane: operation.lane,
    startedVisibleCommitVersion: operation.startedVisibleCommitVersion,
    state: "committed",
    visibleCommitVersion,
  };
}

function commitVisibleRouterState(
  state: AppRouterState,
  nextState: Omit<AppRouterState, "activeOperation" | "visibleCommitVersion">,
  operation: PendingOperationRecord,
): AppRouterState {
  // Single owner for visibleCommitVersion: only an ApprovedVisibleCommit may
  // advance it, and every accepted visible mutation advances it exactly once.
  const visibleCommitVersion = state.visibleCommitVersion + 1;
  return {
    ...nextState,
    activeOperation: commitOperationRecord(operation, visibleCommitVersion),
    visibleCommitVersion,
  };
}

function reduceApprovedVisibleCommitState(
  state: AppRouterState,
  commit: ApprovedVisibleCommit,
): AppRouterState {
  const { action } = commit;
  switch (action.type) {
    case "traverse":
    case "navigate":
      return commitVisibleRouterState(
        state,
        {
          bfcacheIds: action.bfcacheIds,
          elements: mergeElements(state.elements, action.elements, {
            clearAbsentSlots: action.type === "traverse",
            preserveAbsentSlots: commit.decision.preserveAbsentSlots,
            preserveElementIds: commit.decision.preserveElementIds,
          }),
          interceptionContext: action.interceptionContext,
          layoutFlags: mergeLayoutFlags(
            state.layoutFlags,
            action.layoutFlags,
            commit.decision.preserveElementIds,
          ),
          layoutIds: action.layoutIds,
          navigationSnapshot: action.navigationSnapshot,
          previousNextUrl: action.previousNextUrl,
          renderId: action.renderId,
          rootLayoutTreePath: action.rootLayoutTreePath,
          routeId: action.routeId,
        },
        action.operation,
      );
    case "replace":
      return commitVisibleRouterState(
        state,
        {
          bfcacheIds: action.bfcacheIds,
          elements: action.elements,
          interceptionContext: action.interceptionContext,
          layoutFlags: action.layoutFlags,
          layoutIds: action.layoutIds,
          navigationSnapshot: action.navigationSnapshot,
          previousNextUrl: action.previousNextUrl,
          renderId: action.renderId,
          rootLayoutTreePath: action.rootLayoutTreePath,
          routeId: action.routeId,
        },
        action.operation,
      );
    default: {
      const _exhaustive: never = action.type;
      throw new Error("[vinext] Unknown router action: " + String(_exhaustive));
    }
  }
}

function resolvePendingNavigationCommitDecision(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  pending: PendingNavigationCommit;
  startedNavigationId: number;
  targetHref: string;
}): CommitDecision {
  const decision = resolvePendingNavigationCommitDispositionDecision(options);

  switch (decision.disposition) {
    case "skip":
      return { disposition: "no-commit", trace: decision.trace };
    case "hard-navigate":
      return { disposition: "hard-navigate", trace: decision.trace };
    case "dispatch":
      return createVisibleCommitDecision(
        decision.trace,
        decision.preserveElementIds,
        decision.preserveAbsentSlots,
      );
    default: {
      const _exhaustive: never = decision;
      throw new Error("[vinext] Unknown navigation commit disposition: " + String(_exhaustive));
    }
  }
}

function createVisibleCommitDecision(
  trace: NavigationTrace = createNavigationTrace(NavigationTraceReasonCodes.commitCurrent),
  preserveElementIds: readonly string[] = [],
  preserveAbsentSlots: boolean = false,
): VisibleCommitDecision {
  return {
    disposition: "commit",
    preserveAbsentSlots,
    preserveElementIds: [...preserveElementIds],
    trace,
  };
}

function mergeLayoutFlags(
  previousFlags: AppRouterState["layoutFlags"],
  nextFlags: AppRouterState["layoutFlags"],
  preserveElementIds: readonly string[],
): AppRouterState["layoutFlags"] {
  const merged: Record<string, "s" | "d"> = { ...nextFlags };
  for (const id of preserveElementIds) {
    if (Object.hasOwn(merged, id)) continue;
    const value = previousFlags[id];
    if (value) merged[id] = value;
  }
  return merged;
}

function createApprovedVisibleCommit(options: {
  decision: VisibleCommitDecision;
  pending: PendingNavigationCommit;
}): ApprovedVisibleCommit {
  return {
    [approvedVisibleCommitBrand]: true,
    action: options.pending.action,
    decision: options.decision,
    interceptionContext: options.pending.interceptionContext,
    previousNextUrl: options.pending.previousNextUrl,
    rootLayoutTreePath: options.pending.rootLayoutTreePath,
    routeId: options.pending.routeId,
  };
}

function createCommitTransactionFields(pending: PendingNavigationCommit): NavigationTraceFields {
  return {
    operationLane: pending.action.operation.lane,
    pendingOperationId: pending.action.operation.id,
    startedVisibleCommitVersion: pending.action.operation.startedVisibleCommitVersion,
  };
}

function prependCommitTransactionTrace(
  trace: NavigationTrace,
  code: NavigationTraceTransactionCode,
  pending: PendingNavigationCommit,
): NavigationTrace {
  return prependNavigationTraceEntry(trace, code, createCommitTransactionFields(pending));
}

function addCommitTransactionTrace(
  decision: CommitDecision,
  pending: PendingNavigationCommit,
): CommitDecision {
  switch (decision.disposition) {
    case "commit":
      return {
        ...decision,
        trace: prependCommitTransactionTrace(
          decision.trace,
          NavigationTraceTransactionCodes.visibleCommit,
          pending,
        ),
      };
    case "hard-navigate":
      return {
        ...decision,
        trace: prependCommitTransactionTrace(
          decision.trace,
          NavigationTraceTransactionCodes.hardNavigate,
          pending,
        ),
      };
    case "no-commit":
      return {
        ...decision,
        trace: prependCommitTransactionTrace(
          decision.trace,
          NavigationTraceTransactionCodes.noCommit,
          pending,
        ),
      };
    default: {
      const _exhaustive: never = decision;
      throw new Error("[vinext] Unknown commit decision: " + String(_exhaustive));
    }
  }
}

export function approveHmrVisibleCommit(pending: PendingNavigationCommit): ApprovedVisibleCommit {
  if (pending.action.operation.lane !== "hmr") {
    throw new Error("[vinext] HMR visible commit approval requires an HMR pending operation");
  }

  const decision = addCommitTransactionTrace(createVisibleCommitDecision(), pending);
  // This guard is a type narrowing assertion: createVisibleCommitDecision()
  // structurally produces a commit decision, and addCommitTransactionTrace()
  // must preserve that disposition while adding operator trace context.
  if (decision.disposition !== "commit") {
    throw new Error("[vinext] HMR visible commit approval did not produce a commit decision");
  }

  return createApprovedVisibleCommit({
    decision,
    pending,
  });
}

export function approvePendingNavigationCommit(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  pending: PendingNavigationCommit;
  startedNavigationId: number;
  targetHref: string;
}): CommitApproval {
  const decision = addCommitTransactionTrace(
    resolvePendingNavigationCommitDecision({
      activeNavigationId: options.activeNavigationId,
      currentState: options.currentState,
      pending: options.pending,
      startedNavigationId: options.startedNavigationId,
      targetHref: options.targetHref,
    }),
    options.pending,
  );

  switch (decision.disposition) {
    case "commit":
      return {
        approvedCommit: createApprovedVisibleCommit({
          decision,
          pending: options.pending,
        }),
        decision,
      };
    case "hard-navigate":
    case "no-commit":
      return {
        approvedCommit: null,
        decision,
      };
    default: {
      const _exhaustive: never = decision;
      throw new Error("[vinext] Unknown commit decision: " + String(_exhaustive));
    }
  }
}

export async function resolveAndClassifyNavigationCommit(options: {
  activeNavigationId: number;
  currentState: AppRouterState;
  // When provided, these getters are called after awaiting nextElements so
  // approval uses the latest lifecycle authority instead of the call snapshot.
  getActiveNavigationId?: () => number;
  getCurrentStateForApproval?: () => AppRouterState;
  navigationSnapshot: ClientNavigationRenderSnapshot;
  nextElements: Promise<AppElements>;
  operationLane: OperationLane;
  previousNextUrl?: string | null;
  renderId: number;
  startedNavigationId: number;
  targetHref: string;
  type: "navigate" | "replace" | "traverse";
}): Promise<ClassifiedPendingNavigationCommit> {
  const pending = await createPendingNavigationCommit({
    currentState: options.currentState,
    nextElements: options.nextElements,
    navigationSnapshot: options.navigationSnapshot,
    operationLane: options.operationLane,
    previousNextUrl: options.previousNextUrl,
    renderId: options.renderId,
    type: options.type,
  });

  const approvalState = options.getCurrentStateForApproval?.() ?? options.currentState;
  const approval = approvePendingNavigationCommit({
    activeNavigationId: options.getActiveNavigationId?.() ?? options.activeNavigationId,
    currentState: approvalState,
    pending,
    startedNavigationId: options.startedNavigationId,
    targetHref: options.targetHref,
  });

  return {
    approvedCommit: approval.approvedCommit,
    decision: approval.decision,
    pending,
    trace: approval.decision.trace,
  };
}
