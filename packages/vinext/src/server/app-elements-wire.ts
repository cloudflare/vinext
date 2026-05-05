import { isValidElement, type ReactNode } from "react";

const APP_INTERCEPTION_SEPARATOR = "\0";

export const APP_INTERCEPTION_CONTEXT_KEY = "__interceptionContext";
export const APP_LAYOUT_FLAGS_KEY = "__layoutFlags";
export const APP_ROUTE_KEY = "__route";
export const APP_ROOT_LAYOUT_KEY = "__rootLayout";
export const APP_UNMATCHED_SLOT_WIRE_VALUE = "__VINEXT_UNMATCHED_SLOT__";

export const UNMATCHED_SLOT = Symbol.for("vinext.unmatchedSlot");

export type AppElementValue = ReactNode | typeof UNMATCHED_SLOT | string | null;
type AppWireElementValue = ReactNode | string | null;

export type AppElements = Readonly<Record<string, AppElementValue>>;
export type AppWireElements = Readonly<Record<string, AppWireElementValue>>;

/**
 * Per-layout static/dynamic flags. `"s"` = static (skippable on next nav);
 * `"d"` = dynamic (must always render).
 *
 * Lifecycle (partial — later PRs extend this):
 *
 *   1. PROBE   — probeAppPageLayouts (server/app-page-execution.ts) returns
 *                LayoutFlags for every layout in the route at render time.
 *
 *   2. ATTACH  — AppElementsWire.encodeOutgoingPayload writes `__layoutFlags`
 *                into the outgoing App Router payload record.
 *
 *   3. WIRE    — renderToReadableStream serializes the record as RSC row 0.
 *
 *   4. PARSE   — AppElementsWire.readMetadata extracts layoutFlags from the
 *                wire payload on the client side.
 */
export type LayoutFlags = Readonly<Record<string, "s" | "d">>;

type AppElementsMetadata = {
  interceptionContext: string | null;
  layoutFlags: LayoutFlags;
  routeId: string;
  rootLayoutTreePath: string | null;
};

type AppElementsWireMetadataInput = {
  interceptionContext: string | null;
  routeId: string;
  rootLayoutTreePath: string | null;
};

type AppElementsWireMetadataEntries = Readonly<{
  [APP_ROUTE_KEY]: string;
  [APP_INTERCEPTION_CONTEXT_KEY]: string | null;
  [APP_ROOT_LAYOUT_KEY]: string | null;
}>;

/**
 * The outgoing wire payload shape. Includes ReactNode values for the
 * rendered tree plus metadata values like LayoutFlags attached under
 * known keys (e.g. __layoutFlags). Distinct from AppElements / AppWireElements
 * which only carry render-time values.
 */
export type AppOutgoingElements = Readonly<Record<string, ReactNode | LayoutFlags>>;

type AppElementsWireKeys = {
  readonly interceptionContext: typeof APP_INTERCEPTION_CONTEXT_KEY;
  readonly layoutFlags: typeof APP_LAYOUT_FLAGS_KEY;
  readonly rootLayout: typeof APP_ROOT_LAYOUT_KEY;
  readonly route: typeof APP_ROUTE_KEY;
};

type AppElementsWireCodec = {
  readonly keys: AppElementsWireKeys;
  readonly unmatchedSlotValue: typeof APP_UNMATCHED_SLOT_WIRE_VALUE;
  createMetadataEntries(input: AppElementsWireMetadataInput): AppElementsWireMetadataEntries;
  decode(elements: AppWireElements): AppElements;
  encodeCacheKey(rscUrl: string, interceptionContext: string | null): string;
  encodeOutgoingPayload(input: {
    element: ReactNode | Readonly<Record<string, ReactNode>>;
    layoutFlags: LayoutFlags;
  }): ReactNode | AppOutgoingElements;
  encodePageId(routePath: string, interceptionContext: string | null): string;
  encodeRouteId(routePath: string, interceptionContext: string | null): string;
  readMetadata(elements: Readonly<Record<string, unknown>>): AppElementsMetadata;
  withLayoutFlags<T extends Record<string, unknown>>(
    elements: T,
    layoutFlags: LayoutFlags,
  ): T & { [APP_LAYOUT_FLAGS_KEY]: LayoutFlags };
};

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

function createAppPayloadPageId(routePath: string, interceptionContext: string | null): string {
  return appendInterceptionContext(`page:${routePath}`, interceptionContext);
}

export function createAppPayloadCacheKey(
  rscUrl: string,
  interceptionContext: string | null,
): string {
  return appendInterceptionContext(rscUrl, interceptionContext);
}

function createAppElementsWireMetadataEntries(
  input: AppElementsWireMetadataInput,
): AppElementsWireMetadataEntries {
  return {
    [APP_ROUTE_KEY]: input.routeId,
    [APP_INTERCEPTION_CONTEXT_KEY]: input.interceptionContext,
    [APP_ROOT_LAYOUT_KEY]: input.rootLayoutTreePath,
  };
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

function isLayoutFlagsRecord(value: unknown): value is LayoutFlags {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
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
 * Type predicate for a plain (non-null, non-array) record of app payload values.
 * Used to distinguish the App Router payload object from bare React elements at
 * the render boundary. Narrows to `Readonly<Record<string, unknown>>` because
 * the outgoing payload carries heterogeneous values (ReactNodes for the rendered
 * tree, plus metadata like `__layoutFlags` which is a plain object). Delegates
 * to React's canonical `isValidElement` so we don't depend on React's internal
 * `$$typeof` marker scheme.
 */
export function isAppElementsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  if (isValidElement(value)) return false;
  return true;
}

export function withLayoutFlags<T extends Record<string, unknown>>(
  elements: T,
  layoutFlags: LayoutFlags,
): T & { [APP_LAYOUT_FLAGS_KEY]: LayoutFlags } {
  return { ...elements, [APP_LAYOUT_FLAGS_KEY]: layoutFlags };
}

export function buildOutgoingAppPayload(input: {
  element: ReactNode | Readonly<Record<string, ReactNode>>;
  layoutFlags: LayoutFlags;
}): ReactNode | AppOutgoingElements {
  if (!isAppElementsRecord(input.element)) {
    return input.element;
  }
  return withLayoutFlags(input.element, input.layoutFlags);
}

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

export const AppElementsWire: AppElementsWireCodec = {
  // WIRE follow-ups use these stable key names when moving payload readers and writers
  // behind the codec boundary.
  keys: {
    interceptionContext: APP_INTERCEPTION_CONTEXT_KEY,
    layoutFlags: APP_LAYOUT_FLAGS_KEY,
    rootLayout: APP_ROOT_LAYOUT_KEY,
    route: APP_ROUTE_KEY,
  },
  unmatchedSlotValue: APP_UNMATCHED_SLOT_WIRE_VALUE,
  createMetadataEntries: createAppElementsWireMetadataEntries,
  decode: normalizeAppElements,
  encodeCacheKey: createAppPayloadCacheKey,
  encodeOutgoingPayload: buildOutgoingAppPayload,
  encodePageId: createAppPayloadPageId,
  encodeRouteId: createAppPayloadRouteId,
  readMetadata: readAppElementsMetadata,
  withLayoutFlags,
};
