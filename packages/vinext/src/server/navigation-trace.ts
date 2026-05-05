export const NAVIGATION_TRACE_SCHEMA_VERSION = 0;

export type NavigationTraceSchemaVersion = 0;

export const NavigationTraceReasonCodes = {
  commitCurrent: "NC_COMMIT",
  rootBoundaryChanged: "NC_ROOT",
  rootBoundaryUnknown: "NC_ROOT_UNKNOWN",
  staleOperation: "NC_STALE",
} satisfies Readonly<{
  commitCurrent: "NC_COMMIT";
  rootBoundaryChanged: "NC_ROOT";
  rootBoundaryUnknown: "NC_ROOT_UNKNOWN";
  staleOperation: "NC_STALE";
}>;

export type NavigationTraceReasonCode =
  (typeof NavigationTraceReasonCodes)[keyof typeof NavigationTraceReasonCodes];

export type NavigationTraceFieldName =
  | "activeNavigationId"
  | "currentRootLayoutTreePath"
  | "nextRootLayoutTreePath"
  | "startedNavigationId";

export type NavigationTraceFieldValue = string | number | boolean | null;

export type NavigationTraceFields = Readonly<
  Partial<Record<NavigationTraceFieldName, NavigationTraceFieldValue>>
>;

export type NavigationTraceEntry = Readonly<{
  code: NavigationTraceReasonCode;
  fields: NavigationTraceFields;
}>;

export type NavigationTrace = Readonly<{
  schemaVersion: NavigationTraceSchemaVersion;
  entries: readonly NavigationTraceEntry[];
}>;

function createNavigationTraceEntry(
  code: NavigationTraceReasonCode,
  fields: NavigationTraceFields = {},
): NavigationTraceEntry {
  return {
    code,
    fields: { ...fields },
  };
}

export function createNavigationTrace(
  code: NavigationTraceReasonCode,
  fields: NavigationTraceFields = {},
): NavigationTrace {
  return {
    schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
    entries: [createNavigationTraceEntry(code, fields)],
  };
}
