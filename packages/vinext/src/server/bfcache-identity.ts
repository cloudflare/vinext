// Route-graph-derived BFCache segment identity (cloudflare/vinext#1790).
//
// BFCache id mint/restore/preserve and the React Activity state-key map both
// turn on one question: are two renders of the same wire element the *same*
// logical segment instance, or a different one that must re-mint? That equality
// relation is the contract this module owns.
//
// Identity is composed from route-graph semantic facts rather than reverse-
// engineered from wire-key strings + pathname segment counting:
//
//   - graphId             — the segment's stable semantic id (page/layout/...)
//   - boundSegmentKey     — canonical param binding (the resolveAppPageRouteStateKey
//                           family already used for React reset keys), so /p/1 and
//                           /p/2 differ and route groups / catch-all / optional
//                           catch-all are canonicalised one way across both systems
//   - per-kind facts      — slot state, owner layout, active/intercepted target
//
// The descriptor is a typed, inspectable contract: each variant names exactly
// which facts participate in identity, so a new participating fact is a type
// change, not a silent string-format tweak. The route-building layer is the only
// producer of these descriptors. The wire carries the resulting opaque strings,
// and browser consumers compare those strings without reinterpreting route facts.

type ParallelSlotBindingState = "active" | "default" | "unmatched";
// NUL cannot occur in a filesystem-backed @slot name, so this internal slot-id
// namespace cannot alias a user-authored parallel route while remaining valid
// for the existing AppElements slot parser and history-map validation.
const NESTED_BFCACHE_SLOT_SEGMENT_PREFIX = "slot:\0vinext_bfcache_segment_";

function createNestedBfcacheSlotParentPrefix(parentSlotId: string): string {
  const encodedParent = encodeURIComponent(parentSlotId);
  return `${NESTED_BFCACHE_SLOT_SEGMENT_PREFIX}${encodedParent.length}_${encodedParent}_`;
}

export function createNestedBfcacheSlotSegmentId(parentSlotId: string, level: number): string {
  return `${createNestedBfcacheSlotParentPrefix(parentSlotId)}${level}:/`;
}

export function isNestedBfcacheSlotSegmentId(id: string): boolean {
  return id.startsWith(NESTED_BFCACHE_SLOT_SEGMENT_PREFIX);
}

export function isNestedBfcacheSlotSegmentIdFor(id: string, parentSlotId: string): boolean {
  return (
    isNestedBfcacheSlotSegmentId(id) &&
    id.startsWith(createNestedBfcacheSlotParentPrefix(parentSlotId))
  );
}

export type BfcacheSegmentIdentity = string;

export type BfcacheSegmentDescriptor =
  | {
      kind: "page";
      graphId: string;
      rootBoundaryId: string | null;
      boundSegmentKey: string;
    }
  | {
      kind: "layout";
      graphId: string;
      rootBoundaryId: string | null;
      boundSegmentKey: string;
    }
  | {
      kind: "template";
      graphId: string;
      rootBoundaryId: string | null;
      boundSegmentKey: string;
    }
  | {
      kind: "slot-shell";
      slotGraphId: string;
      ownerLayoutGraphId: string | null;
      boundOwnerSegmentKey: string;
    }
  | {
      kind: "slot";
      slotGraphId: string;
      ownerLayoutGraphId: string | null;
      state: ParallelSlotBindingState;
      activeRouteGraphId: string | null;
      interceptionTargetRouteGraphId: string | null;
      boundSegmentKey: string;
    }
  | {
      kind: "sibling-interception";
      interceptionGraphId: string;
      sourceRouteGraphId: string;
      rootBoundaryId: string | null;
      boundSegmentKey: string;
      sourceBoundSegmentKey: string;
    };

// Deterministic, collision-resistant encoding. The leading kind tag plus a
// fixed field order means the string is stable regardless of object key order,
// and JSON.stringify of the ordered tuple keeps embedded separators (`|`, `@`,
// `:`) inside their fields as data instead of structural delimiters.
export function deriveBfcacheSegmentIdentity(descriptor: BfcacheSegmentDescriptor): string {
  switch (descriptor.kind) {
    // Route-tree segments share one shape: the kind tag keeps them distinct.
    case "page":
    case "layout":
    case "template":
      return JSON.stringify([
        descriptor.kind,
        descriptor.graphId,
        descriptor.rootBoundaryId,
        descriptor.boundSegmentKey,
      ]);
    case "slot-shell":
      return JSON.stringify([
        "slot-shell",
        descriptor.slotGraphId,
        descriptor.ownerLayoutGraphId,
        descriptor.boundOwnerSegmentKey,
      ]);
    case "slot":
      return JSON.stringify([
        "slot",
        descriptor.slotGraphId,
        descriptor.ownerLayoutGraphId,
        descriptor.state,
        descriptor.activeRouteGraphId,
        descriptor.interceptionTargetRouteGraphId,
        descriptor.boundSegmentKey,
      ]);
    case "sibling-interception":
      return JSON.stringify([
        "sibling-interception",
        descriptor.sourceRouteGraphId,
        descriptor.interceptionGraphId,
        descriptor.rootBoundaryId,
        descriptor.boundSegmentKey,
        descriptor.sourceBoundSegmentKey,
      ]);
  }
}
