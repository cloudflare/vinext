import { fnv1a64 } from "../utils/hash.js";
import { AppElementsWire, type AppElements } from "./app-elements.js";

/**
 * A client navigation names the layouts it already holds, so a render that's
 * never stored can leave them out, as Next.js leaves out the segments above
 * where a navigation diverges from its router state tree.
 *
 * Each entry hashes a layout's segment identity, which binds the layout to its
 * route prefix and that prefix's params, so a layout whose params changed never
 * matches.
 */
const MAX_MOUNTED_LAYOUTS = 64;

const MOUNTED_LAYOUT_HASH = /^[0-9a-f]{16}$/;

export function hashMountedLayoutIdentity(identity: string): string {
  return fnv1a64(identity);
}

function serializeMountedLayouts(identities: readonly string[]): string | null {
  if (identities.length === 0) return null;
  return identities.slice(0, MAX_MOUNTED_LAYOUTS).map(hashMountedLayoutIdentity).join(",");
}

export function parseMountedLayoutsHeader(value: string | null): ReadonlySet<string> | null {
  if (!value) return null;
  const hashes = new Set<string>();
  for (const entry of value.split(",", MAX_MOUNTED_LAYOUTS + 1)) {
    const hash = entry.trim();
    if (!MOUNTED_LAYOUT_HASH.test(hash)) return null;
    hashes.add(hash);
  }
  if (hashes.size === 0 || hashes.size > MAX_MOUNTED_LAYOUTS) return null;
  return hashes;
}

/**
 * The header for the outermost layouts a client state holds. Only that prefix
 * can be left out of a render, as a layout below one that re-renders renders
 * inside it.
 */
export function createMountedLayoutsHeader(
  elements: AppElements,
  layoutIds: readonly string[],
): string | null {
  const identities = AppElementsWire.readMetadata(elements).bfcacheSegmentIdentities;
  const held: string[] = [];
  for (const layoutId of layoutIds) {
    const identity = identities[layoutId];
    if (identity === undefined || !Object.hasOwn(elements, layoutId)) break;
    held.push(identity);
  }
  return serializeMountedLayouts(held);
}

/**
 * Whether a client state still holds, unchanged, every layout a payload left
 * out. A navigation that started from another state, or a payload stored for
 * another client, can name layouts this one doesn't hold.
 */
export function holdsSkippedLayouts(
  current: { elements: AppElements; layoutIds: readonly string[] },
  next: AppElements,
): boolean {
  const nextMetadata = AppElementsWire.readMetadata(next);
  if (nextMetadata.skippedLayoutIds.length === 0) return true;
  const currentIdentities = AppElementsWire.readMetadata(current.elements).bfcacheSegmentIdentities;
  const currentLayoutIds = new Set(current.layoutIds);
  for (const layoutId of nextMetadata.skippedLayoutIds) {
    if (!currentLayoutIds.has(layoutId) || !Object.hasOwn(current.elements, layoutId)) {
      return false;
    }
    const identity = nextMetadata.bfcacheSegmentIdentities[layoutId];
    if (identity === undefined || identity !== currentIdentities[layoutId]) return false;
  }
  return true;
}
