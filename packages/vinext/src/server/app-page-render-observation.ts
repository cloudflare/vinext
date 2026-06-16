import type { ReactNode } from "react";
import { fnv1a64 } from "../utils/hash.js";
import { _consumeRequestScopedCacheLife } from "vinext/shims/cache-request-state";
import { consumeDynamicFetchObservations } from "vinext/shims/fetch-cache";
import {
  consumeDynamicUsage,
  consumeInvalidDynamicUsageError,
  consumeRenderRequestApiUsage,
} from "vinext/shims/headers";
import { AppElementsWire, isAppElementsRecord } from "./app-elements.js";
import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import {
  buildRenderObservation,
  buildRenderRequestApiObservations,
  type BoundaryOutcome,
  type CacheProofOutputScope,
  type RenderCacheability,
  type RenderObservation,
  type RenderObservationCompleteness,
  type RenderRequestApiKind,
} from "./cache-proof.js";

export type AppPageRenderObservationState = Readonly<{
  dynamicFetches: readonly string[];
  requestApis: readonly RenderRequestApiKind[];
}>;

function readRootBoundaryId(element: Readonly<Record<string, unknown>>): string | null {
  const rootLayoutTreePath = element[AppElementsWire.keys.rootLayout];
  return typeof rootLayoutTreePath === "string" ? rootLayoutTreePath : null;
}

function readRouteId(
  element: ReactNode | Readonly<Record<string, ReactNode>>,
  routePattern: string,
): string {
  if (isAppElementsRecord(element)) {
    const routeId = element[AppElementsWire.keys.route];
    if (typeof routeId === "string") {
      return routeId;
    }
  }

  return AppElementsWire.encodeRouteId(routePattern, null);
}

function createMountedSlotsFingerprint(
  mountedSlotsHeader: string | null | undefined,
): string | null {
  const normalized = normalizeMountedSlotsHeader(mountedSlotsHeader);
  return normalized ? `slots:${fnv1a64(normalized)}` : null;
}

function mergeObservedRequestApis(
  observed: readonly RenderRequestApiKind[],
  params: Record<string, unknown>,
): RenderRequestApiKind[] {
  const merged = new Set<RenderRequestApiKind>(observed);
  // Conservative: route params are marked observed when the route supplies
  // values, since this slice does not add property-access proxying.
  if (Object.keys(params).length > 0) {
    merged.add("params");
  }
  return [...merged].sort();
}

export function createEmptyAppPageRenderObservationState(): AppPageRenderObservationState {
  return {
    dynamicFetches: [],
    requestApis: [],
  };
}

export function consumeAppPageRenderObservationState(): AppPageRenderObservationState {
  return {
    dynamicFetches: consumeDynamicFetchObservations(),
    requestApis: consumeRenderRequestApiUsage(),
  };
}

export function discardAppPageRenderState(): void {
  _consumeRequestScopedCacheLife();
  consumeDynamicFetchObservations();
  consumeRenderRequestApiUsage();
  consumeInvalidDynamicUsageError();
  consumeDynamicUsage();
}

export function createAppPageRenderObservation(options: {
  boundaryOutcome: BoundaryOutcome;
  cacheTags: readonly string[];
  cacheability: RenderCacheability;
  cleanPathname: string;
  completeness: RenderObservationCompleteness;
  output: CacheProofOutputScope;
  params: Record<string, unknown>;
  state: AppPageRenderObservationState;
}): RenderObservation {
  return buildRenderObservation({
    boundaryOutcome: options.boundaryOutcome,
    cacheability: options.cacheability,
    cacheTags: options.cacheTags,
    completeness: options.completeness,
    dynamicFetches: options.state.dynamicFetches,
    output: options.output,
    pathTags: [options.cleanPathname],
    requestApis: buildRenderRequestApiObservations({
      completeness: options.completeness,
      observed: mergeObservedRequestApis(options.state.requestApis, options.params),
    }),
  });
}

export function createAppPageRscOutputScope(options: {
  element: ReactNode | Readonly<Record<string, ReactNode>>;
  mountedSlotsHeader?: string | null;
  renderEpoch: string | null;
  rootBoundaryId: string | null;
  routePattern: string;
}): CacheProofOutputScope {
  return {
    kind: "app-rsc",
    mountedSlotsFingerprint: createMountedSlotsFingerprint(options.mountedSlotsHeader),
    renderEpoch: options.renderEpoch,
    rootBoundaryId:
      options.rootBoundaryId ??
      (isAppElementsRecord(options.element) ? readRootBoundaryId(options.element) : null),
    routeId: readRouteId(options.element, options.routePattern),
  };
}

// HTML output is derived from the resolved RSC render and does not vary by the
// set of mounted parallel-route slots; only RSC payload artifacts include that
// slot fingerprint in their output scope.
export function createAppPageHtmlOutputScope(options: {
  element: ReactNode | Readonly<Record<string, ReactNode>>;
  renderEpoch: string | null;
  rootBoundaryId: string | null;
  routePattern: string;
}): CacheProofOutputScope {
  return {
    kind: "app-html",
    renderEpoch: options.renderEpoch,
    rootBoundaryId:
      options.rootBoundaryId ??
      (isAppElementsRecord(options.element) ? readRootBoundaryId(options.element) : null),
    routeId: readRouteId(options.element, options.routePattern),
  };
}
