import type { ReactNode } from "react";

const APP_INTERCEPTION_SEPARATOR = "\0";

export const APP_INTERCEPTION_CONTEXT_KEY = "__interceptionContext";
export const APP_ROUTE_KEY = "__route";
export const APP_ROOT_LAYOUT_KEY = "__rootLayout";
export const APP_UNMATCHED_SLOT_WIRE_VALUE = "__VINEXT_UNMATCHED_SLOT__";

export const UNMATCHED_SLOT = Symbol.for("vinext.unmatchedSlot");

export type AppElementValue = ReactNode | typeof UNMATCHED_SLOT | string | null;
export type AppWireElementValue = ReactNode | string | null;

export type AppElements = Readonly<Record<string, AppElementValue>>;
export type AppWireElements = Readonly<Record<string, AppWireElementValue>>;

export type AppElementsMetadata = {
  interceptionContext: string | null;
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

export function readAppElementsMetadata(elements: AppElements): AppElementsMetadata {
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

  return {
    interceptionContext: interceptionContext ?? null,
    routeId,
    rootLayoutTreePath,
  };
}
