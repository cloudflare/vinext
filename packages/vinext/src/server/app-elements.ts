import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import { AppElementsWire, UNMATCHED_SLOT, type AppElements } from "./app-elements-wire.js";

export const APP_PREFETCH_LOADING_SHELL_MARKER_KEY = "__prefetchLoadingShell";
/**
 * An optimistic shell's rebinder from the learned URL's segment state keys to
 * the target's. Only the browser sets it, on the elements it builds a shell
 * from, so it never reaches the wire.
 */
const APP_OPTIMISTIC_STATE_KEY_REBINDER_KEY = "__optimisticStateKeyRebinder";

type AppElementsStateKeyRebinder = (stateKey: string) => string;

export function setOptimisticStateKeyRebinder(
  elements: Record<string, unknown>,
  rebind: AppElementsStateKeyRebinder,
): void {
  elements[APP_OPTIMISTIC_STATE_KEY_REBINDER_KEY] = rebind;
}

export function readOptimisticStateKeyRebinder(
  elements: AppElements,
): AppElementsStateKeyRebinder | null {
  const rebind: unknown = Reflect.get(elements, APP_OPTIMISTIC_STATE_KEY_REBINDER_KEY);
  return typeof rebind === "function" ? (rebind as AppElementsStateKeyRebinder) : null;
}

export {
  AppElementsWire,
  APP_ARTIFACT_COMPATIBILITY_KEY,
  APP_BFCACHE_SEGMENT_IDENTITIES_KEY,
  APP_CACHE_ENTRY_REUSE_PROOF_KEY,
  APP_DYNAMIC_STALE_TIME_KEY,
  APP_INTERCEPTION_KEY,
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_LAYOUT_IDS_KEY,
  APP_RETAINED_ELEMENT_IDS_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_HEAD_ID_PREFIX,
  APP_ROUTE_KEY,
  APP_SKIPPED_LAYOUT_IDS_KEY,
  APP_SOURCE_PAGE_SEGMENTS_KEY,
  APP_SLOT_BINDINGS_KEY,
  APP_STATIC_SIBLINGS_KEY,
  APP_STREAMING_METADATA_BODY_ID_PREFIX,
  APP_STREAMING_METADATA_OUTLET_ID_PREFIX,
  APP_UNMATCHED_SLOT_WIRE_VALUE,
  UNMATCHED_SLOT,
  buildOutgoingAppPayload,
  compareAppElementsSlotIds,
  isAppElementsRecord,
  normalizeAppElementsSlotBindings,
  normalizeAppElements,
  readAppElementsMetadata,
  type AppElementValue,
  type AppElementsBfcacheSegmentIdentities,
  type AppElementsInterception,
  type AppElementsSlotBinding,
  type AppElements,
  type AppOutgoingElements,
  type AppWireElements,
} from "./app-elements-wire.js";

// Raw constructor helpers stay private because callers use AppElementsWire codecs.

export function getMountedSlotIds(elements: AppElements): string[] {
  return Object.keys(elements)
    .filter((key) => {
      const value = elements[key];
      const parsed = AppElementsWire.parseElementKey(key);
      return (
        parsed?.kind === "slot" &&
        parsed.name !== "children" &&
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
