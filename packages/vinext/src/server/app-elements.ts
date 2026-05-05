import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import { UNMATCHED_SLOT, type AppElements } from "./app-elements-wire.js";

export {
  AppElementsWire,
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_LAYOUT_FLAGS_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  APP_UNMATCHED_SLOT_WIRE_VALUE,
  UNMATCHED_SLOT,
  buildOutgoingAppPayload,
  createAppPayloadCacheKey,
  createAppPayloadRouteId,
  isAppElementsRecord,
  normalizeAppElements,
  readAppElementsMetadata,
  withLayoutFlags,
  type AppElementValue,
  type AppElements,
  type AppOutgoingElements,
  type AppWireElements,
  type LayoutFlags,
} from "./app-elements-wire.js";

// createAppPayloadPageId stays private because callers use AppElementsWire.encodePageId.

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

export function resolveVisitedResponseInterceptionContext(
  requestInterceptionContext: string | null,
  payloadInterceptionContext: string | null,
): string | null {
  return payloadInterceptionContext ?? requestInterceptionContext;
}
