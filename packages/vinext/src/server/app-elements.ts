import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import { AppElementsWire, UNMATCHED_SLOT, type AppElements } from "./app-elements-wire.js";

export const APP_PREFETCH_LOADING_SHELL_MARKER_KEY = "__prefetchLoadingShell";

export {
  AppElementsWire,
  APP_ARTIFACT_COMPATIBILITY_KEY,
  APP_CACHE_ENTRY_REUSE_PROOF_KEY,
  APP_INTERCEPTION_KEY,
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_LAYOUT_IDS_KEY,
  APP_LAYOUT_FLAGS_KEY,
  APP_RENDER_OBSERVATION_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  APP_SLOT_BINDINGS_KEY,
  APP_UNMATCHED_SLOT_WIRE_VALUE,
  UNMATCHED_SLOT,
  buildOutgoingAppPayload,
  compareAppElementsSlotIds,
  isAppElementsRecord,
  normalizeAppElementsSlotBindings,
  normalizeAppElements,
  readAppElementsMetadata,
  withLayoutFlags,
  type AppElementValue,
  type AppElementsInterception,
  type AppElementsSlotBinding,
  type AppElements,
  type AppOutgoingElements,
  type AppWireElements,
  type LayoutFlags,
} from "./app-elements-wire.js";

// Raw constructor helpers stay private because callers use AppElementsWire codecs.

export function getMountedSlotIds(elements: AppElements): string[] {
  return Object.keys(elements)
    .filter((key) => {
      const value = elements[key];
      return (
        AppElementsWire.isSlotId(key) &&
        value !== null &&
        value !== undefined &&
        value !== UNMATCHED_SLOT
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
