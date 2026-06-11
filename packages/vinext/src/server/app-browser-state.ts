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
  type MountedParallelSlotSnapshotV0,
  type NavigationDecisionV0,
  type OperationLane,
  type OperationToken,
  type RouteSnapshotV0,
} from "./navigation-planner.js";
import {
  createSnapshotPathAndSearch,
  type ClientNavigationRenderSnapshot,
} from "vinext/shims/navigation";
import {
  countConsumedPathnameSegments,
  isInvisibleSegment,
  normalizePathnameForRouteMatch,
  splitPathSegments,
} from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";
import { INITIAL_BFCACHE_ID } from "./app-bfcache-id.js";
import { isBfcacheSegmentId, type BfcacheIdMap } from "./app-history-state.js";

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
type BfcacheStateKeyMap = Readonly<Record<string, string>>;

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

// Monotonic within a single browser document. Full reloads reset the counter,
// while the browser entry's document-scoped version gate prevents old history
// ids from being restored into the new document and colliding with fresh mints.
let nextBfcacheId = 0;

function rememberBfcacheId(value: string): void {
  // The hydration sentinel is the raw "0" value and intentionally does not
  // advance the counter; fresh ids start at "_b_1_".
  const match = /^_b_(\d+)_$/.exec(value);
  if (!match) return;
  nextBfcacheId = Math.max(nextBfcacheId, Number(match[1]));
}

function mintBfcacheId(): string {
  nextBfcacheId += 1;
  return `_b_${nextBfcacheId}_`;
}

function getVisibleTreePathSegments(treePath: string): string[] {
  // Tree paths contain raw filesystem segments (route groups, parallel @slots,
  // and "." default segments). Only URL-visible segments consume a pathname
  // segment when deriving the identity prefix, so filter the invisible ones
  // using the same authority the route graph uses (isInvisibleSegment). Missing
  // @slot/"." here over-counts consumed segments and re-mints bfcache ids for
  // segments that actually persisted across a parallel-route navigation.
  return splitPathSegments(treePath).filter((segment) => !isInvisibleSegment(segment));
}

function getTreePathIdentityPrefix(pathname: string, treePath: string): string {
  const pathnameSegments = splitPathSegments(pathname);
  // countConsumedPathnameSegments is the shared, browser-safe slice of the
  // canonical filesystem-segment → URL-segment mapping in app-route-graph.ts.
  const consumedPathnameSegments = countConsumedPathnameSegments(
    getVisibleTreePathSegments(treePath),
    pathnameSegments.length,
  );

  if (consumedPathnameSegments === 0) return "/";
  const segments = pathnameSegments.slice(0, consumedPathnameSegments);
  return `/${segments.join("/")}`;
}

type AppElementsMetadata = ReturnType<typeof AppElementsWire.readMetadata>;

/**
 * Metadata parsed once per element map, paired with a slotId→binding index so
 * per-slot identity lookups are O(1) instead of a linear `slotBindings.find`
 * scan (which made per-commit identity derivation O(slots^2)).
 */
type ParsedAppElementsMetadata = {
  metadata: AppElementsMetadata;
  slotBindingsBySlotId: ReadonlyMap<string, AppElementsSlotBinding>;
};

function readAppElementsMetadata(elements: AppElements): ParsedAppElementsMetadata | null {
  let metadata: AppElementsMetadata;
  try {
    metadata = AppElementsWire.readMetadata(elements);
  } catch {
    // Some low-level tests pass partial element maps without metadata.
    return null;
  }
  const slotBindingsBySlotId = new Map<string, AppElementsSlotBinding>();
  for (const binding of metadata.slotBindings) {
    slotBindingsBySlotId.set(binding.slotId, binding);
  }
  return { metadata, slotBindingsBySlotId };
}

function createActiveSlotIdentity(
  id: string,
  parsed: ParsedAppElementsMetadata | null,
): string | null {
  const activeSlotBinding = parsed?.slotBindingsBySlotId.get(id);
  if (activeSlotBinding?.activeRouteId != null) {
    return `${id}@${activeSlotBinding.activeRouteId}`;
  }

  const interception = parsed?.metadata.interception;
  if (interception?.slotId !== id) return null;

  return `${id}@${interception.targetRouteId}`;
}

/**
 * Legacy bridge for deriving a bfcache segment identity from AppElements wire
 * keys. Keep wire-key parsing contained here until Vinext has a route-manifest
 * semantic authority equivalent to Next.js CacheNode/segment-cache state.
 */
function createBfcacheSegmentIdentity(
  id: string,
  options: { metadata: ParsedAppElementsMetadata | null; pathname: string },
): string | null {
  const parsed = AppElementsWire.parseElementKey(id);
  if (!parsed) return null;

  if (parsed.kind === "page") {
    return `${id}@${options.pathname}`;
  }

  if (parsed.kind === "slot") {
    const activeSlotIdentity = createActiveSlotIdentity(id, options.metadata);
    if (activeSlotIdentity !== null) return activeSlotIdentity;

    return `${id}@${getTreePathIdentityPrefix(options.pathname, parsed.treePath)}`;
  }

  if (parsed.kind === "layout" || parsed.kind === "template") {
    return `${id}@${getTreePathIdentityPrefix(options.pathname, parsed.treePath)}`;
  }

  return null;
}

function collectBfcacheSegmentIds(
  elements: AppElements,
  parsed?: ParsedAppElementsMetadata | null,
): string[] {
  const ids = new Set(Object.keys(elements));
  // Reuse already-parsed metadata when the caller has it; only fall back to a
  // fresh parse when metadata was not threaded in (e.g. createInitialBfcacheIdMap).
  const metadata = parsed === undefined ? readAppElementsMetadata(elements) : parsed;
  for (const layoutId of metadata?.metadata.layoutIds ?? []) {
    ids.add(layoutId);
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

function normalizeBfcachePathname(pathname: string): string {
  // Use the route-match normalizer so decoded delimiters like %2F remain data
  // inside their segment instead of becoming structural path separators.
  const normalized = normalizePath(normalizePathnameForRouteMatch(pathname));
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

export function createBfcacheSegmentStateKeyMap(options: {
  elements: AppElements;
  pathname: string;
}): BfcacheStateKeyMap {
  const metadata = readAppElementsMetadata(options.elements);
  const normalizedPathname = normalizeBfcachePathname(options.pathname);
  const stateKeys: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIds(options.elements, metadata)) {
    const stateKey = createBfcacheSegmentIdentity(id, {
      metadata,
      pathname: normalizedPathname,
    });
    if (stateKey !== null) {
      stateKeys[id] = stateKey;
    }
  }
  return stateKeys;
}

export function createNextBfcacheIdMap(options: {
  current: BfcacheIdMap;
  currentElements: AppElements;
  currentPathname: string;
  elements: AppElements;
  nextPathname: string;
  restored?: BfcacheIdMap | null;
  reuseCurrent?: boolean;
}): BfcacheIdMap {
  const current = options.reuseCurrent === false ? {} : options.current;
  for (const value of Object.values(current)) {
    rememberBfcacheId(value);
  }
  for (const value of Object.values(options.restored ?? {})) {
    rememberBfcacheId(value);
  }

  const currentMetadata = readAppElementsMetadata(options.currentElements);
  const nextMetadata = readAppElementsMetadata(options.elements);
  const currentPathname = normalizeBfcachePathname(options.currentPathname);
  const nextPathname = normalizeBfcachePathname(options.nextPathname);
  const ids: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIds(options.elements, nextMetadata)) {
    const currentIdentity = createBfcacheSegmentIdentity(id, {
      metadata: currentMetadata,
      pathname: currentPathname,
    });
    const nextIdentity = createBfcacheSegmentIdentity(id, {
      metadata: nextMetadata,
      pathname: nextPathname,
    });
    const currentValue = currentIdentity === nextIdentity ? current[id] : undefined;
    // History traversals restore persisted ids first, matching segments keep
    // their current id, and newly-created segments mint a fresh opaque id.
    // Restored ids intentionally win over identity-matching: the target entry's
    // ids were authoritative when that entry was created, and traversal must
    // faithfully restore them even if the segment's identity has since changed.
    // Callers must clear restored ids before this point when traversal redirects
    // change the target href, because stale history ids otherwise win here.
    const value = options.restored?.[id] ?? currentValue ?? mintBfcacheId();
    ids[id] = value;
    rememberBfcacheId(value);
  }
  return ids;
}

export function preserveBfcacheIdsForMergedElements(options: {
  elements: AppElements;
  next: BfcacheIdMap;
  previous: BfcacheIdMap;
}): BfcacheIdMap {
  const ids: Record<string, string> = {};
  for (const id of collectBfcacheSegmentIds(options.elements)) {
    const nextValue = options.next[id];
    if (nextValue !== undefined) {
      ids[id] = nextValue;
      continue;
    }

    const previousValue = options.previous[id];
    if (previousValue !== undefined) {
      ids[id] = previousValue;
      // Keep the module-level opaque-id counter ahead of restored ids so future
      // mints cannot reuse a value after reducer-level preservation.
      rememberBfcacheId(previousValue);
    }
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

  if (
    options.startedNavigationId !== options.activeNavigationId ||
    options.pending.action.operation.startedVisibleCommitVersion !==
      options.currentState.visibleCommitVersion
  ) {
    // staleOperation — the navigation that created `pending` started from a
    // different visibleCommitVersion than the current state. This happens when
    // a synchronous history snapshot restore (restoreHistoryStateSnapshot, see
    // app-browser-entry.ts popstate handler) bumps visibleCommitVersion before
    // an in-flight async RSC traverse resolves. The snapshot restore is the
    // authoritative commit; the stale async payload is intentionally discarded.
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
  const displayUrl = createSnapshotPathAndSearch(state.navigationSnapshot);
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
  const displayUrl = createSnapshotPathAndSearch(pending.action.navigationSnapshot);
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
