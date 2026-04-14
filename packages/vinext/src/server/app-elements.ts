import { isValidElement, type ReactNode } from "react";

const APP_INTERCEPTION_SEPARATOR = "\0";

export const APP_INTERCEPTION_CONTEXT_KEY = "__interceptionContext";
export const APP_LAYOUT_FLAGS_KEY = "__layoutFlags";
export const APP_ROUTE_KEY = "__route";
export const APP_ROOT_LAYOUT_KEY = "__rootLayout";
export const APP_UNMATCHED_SLOT_WIRE_VALUE = "__VINEXT_UNMATCHED_SLOT__";

export const UNMATCHED_SLOT = Symbol.for("vinext.unmatchedSlot");

export type AppElementValue = ReactNode | typeof UNMATCHED_SLOT | string | null;
export type AppWireElementValue = ReactNode | string | null;

export type AppElements = Readonly<Record<string, AppElementValue>>;
export type AppWireElements = Readonly<Record<string, AppWireElementValue>>;

/**
 * Per-layout static/dynamic flags. `"s"` = static (skippable on next nav);
 * `"d"` = dynamic (must always render).
 *
 * Lifecycle:
 *
 *   1. BUILD   — classifyAllRouteLayouts (build/layout-classification.ts) runs
 *                Layer 1 (segment config) and Layer 2 (module graph) against
 *                each route's layouts at build time. Results are embedded in
 *                the generated entry via __VINEXT_CLASS.
 *
 *   2. PROBE   — probeAppPageLayouts (server/app-page-execution.ts) consults
 *                build-time classifications. For "needs-probe" layouts, runs
 *                Layer 3 runtime probe via runWithIsolatedDynamicScope. Returns
 *                LayoutFlags for every layout in the route.
 *
 *   3. ATTACH  — withLayoutFlags (this file) writes `__layoutFlags` into the
 *                outgoing App Router payload record.
 *
 *   4. WIRE    — renderToReadableStream serializes the record as RSC row 0.
 *
 *   5. PARSE   — readAppElementsMetadata (this file) extracts layoutFlags from
 *                the wire payload on the client side.
 *
 *   6. EMIT    — buildSkipHeaderValue (this file) converts layoutFlags into
 *                the X-Vinext-Router-Skip header for the next client request.
 *
 * Each step is re-validated — LayoutFlags is NOT a trusted source; the server
 * re-classifies every request in steps 1-2, and the filter in step 5-6 is
 * applied defensively via `computeSkipDecision`, which only honors flags the
 * server independently marked "s".
 */
export type LayoutFlags = Readonly<Record<string, "s" | "d">>;

export type AppElementsMetadata = {
  interceptionContext: string | null;
  layoutFlags: LayoutFlags;
  routeId: string;
  rootLayoutTreePath: string | null;
};

export function normalizeMountedSlotsHeader(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }

  const slotIds = Array.from(new Set(header.split(/\s+/).filter(Boolean))).sort();

  return slotIds.length > 0 ? slotIds.join(" ") : null;
}

export function getMountedSlotIds(elements: AppElements): string[] {
  return Object.keys(elements)
    .filter((key) => {
      const value = elements[key];
      return (
        key.startsWith("slot:") && value !== null && value !== undefined && value !== UNMATCHED_SLOT
      );
    })
    .sort();
}

export function getMountedSlotIdsHeader(elements: AppElements): string | null {
  return normalizeMountedSlotsHeader(getMountedSlotIds(elements).join(" "));
}

function appendInterceptionContext(identity: string, interceptionContext: string | null): string {
  return interceptionContext === null
    ? identity
    : `${identity}${APP_INTERCEPTION_SEPARATOR}${interceptionContext}`;
}

export function createAppPayloadRouteId(
  routePath: string,
  interceptionContext: string | null,
): string {
  return appendInterceptionContext(`route:${routePath}`, interceptionContext);
}

export function createAppPayloadPageId(
  routePath: string,
  interceptionContext: string | null,
): string {
  return appendInterceptionContext(`page:${routePath}`, interceptionContext);
}

export function createAppPayloadCacheKey(
  rscUrl: string,
  interceptionContext: string | null,
): string {
  return appendInterceptionContext(rscUrl, interceptionContext);
}

export function resolveVisitedResponseInterceptionContext(
  requestInterceptionContext: string | null,
  payloadInterceptionContext: string | null,
): string | null {
  return payloadInterceptionContext ?? requestInterceptionContext;
}

export function normalizeAppElements(elements: AppWireElements): AppElements {
  let needsNormalization = false;
  for (const [key, value] of Object.entries(elements)) {
    if (key.startsWith("slot:") && value === APP_UNMATCHED_SLOT_WIRE_VALUE) {
      needsNormalization = true;
      break;
    }
  }

  if (!needsNormalization) {
    return elements;
  }

  const normalized: Record<string, AppElementValue> = {};
  for (const [key, value] of Object.entries(elements)) {
    normalized[key] =
      key.startsWith("slot:") && value === APP_UNMATCHED_SLOT_WIRE_VALUE ? UNMATCHED_SLOT : value;
  }

  return normalized;
}

export const X_VINEXT_ROUTER_SKIP_HEADER = "X-Vinext-Router-Skip";
export const X_VINEXT_MOUNTED_SLOTS_HEADER = "X-Vinext-Mounted-Slots";

export function parseSkipHeader(header: string | null): ReadonlySet<string> {
  if (!header) return new Set();
  const ids = new Set<string>();
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("layout:")) {
      ids.add(trimmed);
    }
  }
  return ids;
}

/** See `LayoutFlags` type docblock in this file for lifecycle. */
export function buildSkipHeaderValue(layoutFlags: LayoutFlags): string | null {
  const staticIds: string[] = [];
  for (const [id, flag] of Object.entries(layoutFlags)) {
    if (flag === "s") staticIds.push(id);
  }
  return staticIds.length > 0 ? staticIds.join(",") : null;
}

/**
 * Pure: builds the request headers for an App Router RSC navigation.
 * Centralizing this contract keeps the navigation fetch aligned with the
 * cache-key inputs (`interceptionContext`, mounted slots, layout flags).
 */
export function createRscNavigationRequestHeaders(
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
  layoutFlags: LayoutFlags,
): Headers {
  const headers = new Headers({ Accept: "text/x-component" });
  if (interceptionContext !== null) {
    headers.set("X-Vinext-Interception-Context", interceptionContext);
  }
  if (mountedSlotsHeader !== null) {
    headers.set(X_VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
  }
  const skipValue = buildSkipHeaderValue(layoutFlags);
  if (skipValue !== null) {
    headers.set(X_VINEXT_ROUTER_SKIP_HEADER, skipValue);
  }
  return headers;
}

function isLayoutFlagsRecord(value: unknown): value is LayoutFlags {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    if (v !== "s" && v !== "d") return false;
  }
  return true;
}

function parseLayoutFlags(value: unknown): LayoutFlags {
  if (isLayoutFlagsRecord(value)) return value;
  return {};
}

/**
 * Type predicate for a plain (non-null, non-array) record of app elements.
 * Used to distinguish the App Router elements object from bare React elements
 * at the render boundary. Delegates to React's canonical `isValidElement` so
 * we don't depend on React's internal `$$typeof` marker scheme.
 */
export function isAppElementsRecord(value: unknown): value is Record<string, ReactNode> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  if (isValidElement(value)) return false;
  return true;
}

/**
 * Pure: returns a new record with `__layoutFlags` attached. Owns the write
 * boundary for the layout flags key so the write side sits next to
 * `readAppElementsMetadata`.
 *
 * See `LayoutFlags` type docblock in this file for lifecycle.
 */
export function withLayoutFlags<T extends Record<string, unknown>>(
  elements: T,
  layoutFlags: LayoutFlags,
): T & { [APP_LAYOUT_FLAGS_KEY]: LayoutFlags } {
  return { ...elements, [APP_LAYOUT_FLAGS_KEY]: layoutFlags };
}

const EMPTY_SKIP_DECISION: ReadonlySet<string> = new Set<string>();

/**
 * Pure: computes the authoritative set of layout ids that should be omitted
 * from the outgoing payload. Defense-in-depth — an id is only included if the
 * server independently classified it as `"s"` (static). Empty or missing
 * `requested` yields a shared empty set so the hot path does not allocate.
 *
 * See `LayoutFlags` type docblock in this file for lifecycle.
 */
export function computeSkipDecision(
  layoutFlags: LayoutFlags,
  requested: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (!requested || requested.size === 0) {
    return EMPTY_SKIP_DECISION;
  }
  const decision = new Set<string>();
  for (const id of requested) {
    if (layoutFlags[id] === "s") {
      decision.add(id);
    }
  }
  return decision;
}

/**
 * The outgoing wire payload shape. Includes ReactNode values for the
 * rendered tree plus metadata values like LayoutFlags attached under
 * known keys (e.g. __layoutFlags). Distinct from AppElements / AppWireElements
 * which only carry render-time values.
 */
export type AppOutgoingElements = Readonly<Record<string, ReactNode | LayoutFlags>>;

/**
 * Pure: builds the outgoing payload for the wire. Non-record inputs (e.g. a
 * bare React element) are returned unchanged. Record inputs get a fresh copy
 * with `__layoutFlags` attached. Never mutates `input.element`.
 *
 * Skip-header semantics intentionally live one layer up in
 * `app-page-skip-filter.ts` so that the payload React serializes is always
 * the CANONICAL record. The response branch applies the filter at the byte
 * layer after the tee, which keeps the cache write path producing full
 * bytes regardless of client skip state.
 */
export function buildOutgoingAppPayload(input: {
  element: ReactNode | Readonly<Record<string, ReactNode>>;
  layoutFlags: LayoutFlags;
}): ReactNode | AppOutgoingElements {
  if (!isAppElementsRecord(input.element)) {
    return input.element;
  }
  return withLayoutFlags({ ...input.element }, input.layoutFlags);
}

/**
 * Parses metadata from the wire payload. Accepts `Record<string, unknown>`
 * because the RSC payload carries heterogeneous values (React elements,
 * strings, and plain objects like layout flags) under the same record type.
 *
 * See `LayoutFlags` type docblock in this file for lifecycle.
 */
export function readAppElementsMetadata(
  elements: Readonly<Record<string, unknown>>,
): AppElementsMetadata {
  const routeId = elements[APP_ROUTE_KEY];
  if (typeof routeId !== "string") {
    throw new Error("[vinext] Missing __route string in App Router payload");
  }

  const interceptionContext = elements[APP_INTERCEPTION_CONTEXT_KEY];
  if (
    interceptionContext !== undefined &&
    interceptionContext !== null &&
    typeof interceptionContext !== "string"
  ) {
    throw new Error("[vinext] Invalid __interceptionContext in App Router payload");
  }

  const rootLayoutTreePath = elements[APP_ROOT_LAYOUT_KEY];
  if (rootLayoutTreePath === undefined) {
    throw new Error("[vinext] Missing __rootLayout key in App Router payload");
  }
  if (rootLayoutTreePath !== null && typeof rootLayoutTreePath !== "string") {
    throw new Error("[vinext] Invalid __rootLayout in App Router payload: expected string or null");
  }

  const layoutFlags = parseLayoutFlags(elements[APP_LAYOUT_FLAGS_KEY]);

  return {
    interceptionContext: interceptionContext ?? null,
    layoutFlags,
    routeId,
    rootLayoutTreePath,
  };
}
