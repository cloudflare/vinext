export const NAVIGATION_TRACE_SCHEMA_VERSION = 0;

type NavigationTraceSchemaVersion = 0;

export const NavigationTraceReasonCodes = {
  cacheProofRejected: "NC_CACHE_REJECT",
  commitCurrent: "NC_COMMIT",
  crossDocumentFlight: "NC_CROSS_DOC_FLIGHT",
  invalidRscPayload: "NC_RSC_INVALID",
  interceptedCommitCurrent: "NC_INTERCEPT_COMMIT",
  interceptedRejectedIncompatibleRoot: "NC_INTERCEPT_REJECT_ROOT",
  interceptedRejectedMissingProof: "NC_INTERCEPT_REJECT_MISSING_PROOF",
  interceptedRejectedMissingSlotProof: "NC_INTERCEPT_REJECT_SLOT",
  interceptedRejectedTargetMismatch: "NC_INTERCEPT_REJECT_TARGET",
  interceptedRejectedUndeclaredTopology: "NC_INTERCEPT_REJECT_GRAPH",
  interceptedRejectedUnknownSource: "NC_INTERCEPT_REJECT_SOURCE",
  prefetchOnly: "NC_PREFETCH_ONLY",
  proceedToCommit: "NC_RSC_PROCEED",
  redirectFollow: "NC_RSC_REDIRECT_FOLLOW",
  redirectTerminalDepth: "NC_RSC_REDIRECT_DEPTH",
  redirectTerminalExternal: "NC_RSC_REDIRECT_EXTERNAL",
  requestWork: "NC_REQUEST",
  rootBoundaryChanged: "NC_ROOT",
  rootBoundaryUnknown: "NC_ROOT_UNKNOWN",
  rscCompatibilityMismatch: "NC_RSC_COMPAT_MISMATCH",
  sameDocumentScroll: "NC_SAME_DOC_SCROLL",
  samePageSearch: "NC_SAME_PAGE_SEARCH",
  staleOperation: "NC_STALE",
  streamedRedirectLoop: "NC_RSC_STREAMED_REDIRECT_LOOP",
} satisfies Readonly<{
  cacheProofRejected: "NC_CACHE_REJECT";
  commitCurrent: "NC_COMMIT";
  crossDocumentFlight: "NC_CROSS_DOC_FLIGHT";
  invalidRscPayload: "NC_RSC_INVALID";
  interceptedCommitCurrent: "NC_INTERCEPT_COMMIT";
  interceptedRejectedIncompatibleRoot: "NC_INTERCEPT_REJECT_ROOT";
  interceptedRejectedMissingProof: "NC_INTERCEPT_REJECT_MISSING_PROOF";
  interceptedRejectedMissingSlotProof: "NC_INTERCEPT_REJECT_SLOT";
  interceptedRejectedTargetMismatch: "NC_INTERCEPT_REJECT_TARGET";
  interceptedRejectedUndeclaredTopology: "NC_INTERCEPT_REJECT_GRAPH";
  interceptedRejectedUnknownSource: "NC_INTERCEPT_REJECT_SOURCE";
  prefetchOnly: "NC_PREFETCH_ONLY";
  proceedToCommit: "NC_RSC_PROCEED";
  redirectFollow: "NC_RSC_REDIRECT_FOLLOW";
  redirectTerminalDepth: "NC_RSC_REDIRECT_DEPTH";
  redirectTerminalExternal: "NC_RSC_REDIRECT_EXTERNAL";
  requestWork: "NC_REQUEST";
  rootBoundaryChanged: "NC_ROOT";
  rootBoundaryUnknown: "NC_ROOT_UNKNOWN";
  rscCompatibilityMismatch: "NC_RSC_COMPAT_MISMATCH";
  sameDocumentScroll: "NC_SAME_DOC_SCROLL";
  samePageSearch: "NC_SAME_PAGE_SEARCH";
  staleOperation: "NC_STALE";
  streamedRedirectLoop: "NC_RSC_STREAMED_REDIRECT_LOOP";
}>;

export const NavigationTraceTransactionCodes = {
  hardNavigate: "NT_HARD_NAVIGATE",
  noCommit: "NT_NO_COMMIT",
  visibleCommit: "NT_VISIBLE_COMMIT",
} satisfies Readonly<{
  hardNavigate: "NT_HARD_NAVIGATE";
  noCommit: "NT_NO_COMMIT";
  visibleCommit: "NT_VISIBLE_COMMIT";
}>;

export type NavigationTraceReasonCode =
  (typeof NavigationTraceReasonCodes)[keyof typeof NavigationTraceReasonCodes];

export type NavigationTraceTransactionCode =
  (typeof NavigationTraceTransactionCodes)[keyof typeof NavigationTraceTransactionCodes];

type NavigationTraceCode = NavigationTraceReasonCode | NavigationTraceTransactionCode;

type NavigationTraceFieldName =
  | "activeNavigationId"
  | "cacheProofCode"
  | "cacheProofMode"
  | "cacheProofReuseClass"
  | "cacheProofScope"
  | "currentRootLayoutTreePath"
  | "currentVisibleCommitVersion"
  | "nextRootLayoutTreePath"
  | "eventKind"
  | "fetchResultSource"
  | "operationLane"
  | "pendingOperationId"
  | "redirectDepth"
  | "redirectSignal"
  | "startedVisibleCommitVersion"
  | "startedNavigationId"
  | "targetHref"
  | "traverseDirection";

type NavigationTraceFieldValue = string | number | boolean | null;

export type NavigationTraceFields = Readonly<
  Partial<Record<NavigationTraceFieldName, NavigationTraceFieldValue>>
>;

type NavigationTraceEntry = Readonly<{
  code: NavigationTraceCode;
  fields: NavigationTraceFields;
}>;

export type NavigationTrace = Readonly<{
  schemaVersion: NavigationTraceSchemaVersion;
  entries: readonly NavigationTraceEntry[];
}>;

export function createNavigationLifecycleTraceFields(options: {
  activeNavigationId?: number;
  currentRootLayoutTreePath: string | null;
  currentVisibleCommitVersion: number;
  nextRootLayoutTreePath: string | null;
  startedNavigationId?: number;
  startedVisibleCommitVersion: number;
}): NavigationTraceFields {
  return {
    ...(options.activeNavigationId !== undefined
      ? { activeNavigationId: options.activeNavigationId }
      : {}),
    currentRootLayoutTreePath: options.currentRootLayoutTreePath,
    currentVisibleCommitVersion: options.currentVisibleCommitVersion,
    nextRootLayoutTreePath: options.nextRootLayoutTreePath,
    ...(options.startedNavigationId !== undefined
      ? { startedNavigationId: options.startedNavigationId }
      : {}),
    startedVisibleCommitVersion: options.startedVisibleCommitVersion,
  };
}

function createNavigationTraceEntry(
  code: NavigationTraceCode,
  fields: NavigationTraceFields = {},
): NavigationTraceEntry {
  return {
    code,
    fields: { ...fields },
  };
}

export function createNavigationTrace(
  code: NavigationTraceCode,
  fields: NavigationTraceFields = {},
): NavigationTrace {
  return {
    schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
    entries: [createNavigationTraceEntry(code, fields)],
  };
}

export function prependNavigationTraceEntry(
  trace: NavigationTrace,
  code: NavigationTraceCode,
  fields: NavigationTraceFields = {},
): NavigationTrace {
  return {
    schemaVersion: trace.schemaVersion,
    entries: [createNavigationTraceEntry(code, fields), ...trace.entries],
  };
}
