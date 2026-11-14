import type { ClientNavigationRenderSnapshot } from "vinext/shims/navigation";
import { isBfcacheSegmentId } from "./app-bfcache-identity.js";
import { isNestedBfcacheSlotSegmentIdFor } from "./bfcache-identity.js";
import {
  APP_ROUTE_HEAD_ID_PREFIX,
  APP_STREAMING_METADATA_BODY_ID_PREFIX,
  APP_STREAMING_METADATA_OUTLET_ID_PREFIX,
  AppElementsWire,
  type AppElements,
} from "./app-elements.js";

const ROUTE_ELEMENT_ID_PREFIXES = [
  APP_ROUTE_HEAD_ID_PREFIX,
  APP_STREAMING_METADATA_BODY_ID_PREFIX,
  APP_STREAMING_METADATA_OUTLET_ID_PREFIX,
] as const;

/**
 * The elements a payload left for the client to keep that it doesn't carry
 * itself, when a client state holds every one of them unchanged, or null when
 * it doesn't.
 *
 * A payload for an intercepted route leaves out the source page shown beneath
 * it, as Next.js keeps the source segment it already holds rather than
 * rendering it again. Only the state showing that route at `sourceUrl`, the
 * source URL the payload was requested for, can keep them: each segment must
 * keep the identity the payload gives it, which binds it to its route and
 * params, and the state must show the same query.
 */
export function resolveHeldRetainedElementIds(
  current: {
    elements: AppElements;
    navigationSnapshot: Pick<ClientNavigationRenderSnapshot, "search">;
    previousNextUrl: string | null;
    routeId: string;
  },
  next: AppElements,
  sourceUrl: string | null,
): readonly string[] | null {
  const nextMetadata = AppElementsWire.readMetadata(next);
  const headId = APP_ROUTE_HEAD_ID_PREFIX + nextMetadata.routeId;
  const metadataBodyId = APP_STREAMING_METADATA_BODY_ID_PREFIX + nextMetadata.routeId;
  // A head's streamed tags have a body element only when its own render placed
  // them there, so the body goes with the head the route renders: none beside
  // a head the payload carries, and the state's own, if any, beside the head
  // it keeps.
  const missing = nextMetadata.retainedElementIds.filter(
    (id) => !Object.hasOwn(next, id) && (id !== metadataBodyId || !Object.hasOwn(next, headId)),
  );
  if (missing.length === 0) return missing;
  if (
    nextMetadata.interception === null ||
    sourceUrl === null ||
    current.routeId !== nextMetadata.routeId
  ) {
    return null;
  }
  // The route id carries the source's pathname but not its query.
  const currentSearch =
    current.previousNextUrl === null
      ? current.navigationSnapshot.search
      : new URL(current.previousNextUrl, "http://localhost").search;
  if (new URL(sourceUrl, "http://localhost").search !== currentSearch) return null;

  const currentMetadata = AppElementsWire.readMetadata(current.elements);
  const currentIdentities = currentMetadata.bfcacheSegmentIdentities;
  const held: string[] = [];
  for (const id of missing) {
    if (id === metadataBodyId && !Object.hasOwn(current.elements, id)) continue;
    if (!Object.hasOwn(current.elements, id) || current.elements[id] === undefined) return null;
    // A loading shell holds no page yet, only its navigation's payload does,
    // whether the route carries its page as a page or as its children slot.
    if (current.elements[id] === null) {
      const parsed = AppElementsWire.parseElementKey(id);
      if (parsed?.kind === "page" || (parsed?.kind === "slot" && parsed.name === "children")) {
        return null;
      }
    }
    if (isBfcacheSegmentId(id)) {
      const identity = nextMetadata.bfcacheSegmentIdentities[id];
      if (identity === undefined || identity !== currentIdentities[id]) return null;
      // A slot keeps its shell's identity while the branch inside it changes,
      // so each segment the payload places within it must match too.
      for (const [nestedId, nestedIdentity] of Object.entries(
        nextMetadata.bfcacheSegmentIdentities,
      )) {
        if (
          isNestedBfcacheSlotSegmentIdFor(nestedId, id) &&
          nestedIdentity !== currentIdentities[nestedId]
        ) {
          return null;
        }
      }
    } else if (
      !ROUTE_ELEMENT_ID_PREFIXES.some((prefix) => id === prefix + nextMetadata.routeId) ||
      // An intercepted state's own head and its tags are the intercept's: only
      // the ones it kept from the source are the source's.
      (currentMetadata.interception !== null && !currentMetadata.retainedElementIds.includes(id))
    ) {
      return null;
    }
    held.push(id);
  }
  return held;
}
