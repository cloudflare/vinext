import {
  type ArtifactCompatibilityEnvelope,
  ARTIFACT_COMPATIBILITY_PROOF_FIELDS,
} from "./artifact-compatibility.js";
import { createClientReusePayloadHash } from "./client-reuse-manifest.js";

type StaticLayoutClientReuseProofInput = Readonly<{
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  layoutId: string;
  rootBoundaryId: string | null;
  routeId: string;
  variantCacheKey: string;
}>;

type ProofFieldPair = readonly [string, string | number | null];

export function createStaticLayoutClientReuseRouteId(layoutId: string): string {
  return `static-layout:${createClientReusePayloadHash(layoutId)}`;
}

function createCanonicalProofPairs(
  input: StaticLayoutClientReuseProofInput,
): readonly ProofFieldPair[] {
  return ARTIFACT_COMPATIBILITY_PROOF_FIELDS.map((field) => [
    field,
    input.artifactCompatibility[field],
  ]);
}

export function createStaticLayoutClientReusePayloadHash(
  input: StaticLayoutClientReuseProofInput,
): string {
  // ARTIFACT_COMPATIBILITY_PROOF_FIELDS order is load-bearing for hash
  // determinism.  The artifact compatibility section is serialized as an
  // array of [field, value] pairs in declaration order — no object key-order
  // dependency — so the hash is invariant across runtimes.  Reordering the
  // field list silently changes every hash.
  //
  // routeId is intentionally excluded.  This is a layout-scoped hash —
  // sibling routes under the same layout must produce identical payload
  // hashes, otherwise the cross-check rejects on payload hash mismatch
  // before reaching the exact-equality gate.
  // If the field list must change, bump the hash algorithm or namespace to
  // avoid silent cross-deployment hash drift.
  return createClientReusePayloadHash(
    JSON.stringify({
      artifactCompatibilityPairs: createCanonicalProofPairs(input),
      layoutId: input.layoutId,
      rootBoundaryId: input.rootBoundaryId,
      variantCacheKey: input.variantCacheKey,
    }),
  );
}

// The app-route payload envelope is route-scoped and may not carry a render epoch
// during this wave. Static-layout skip needs layout-scoped compatibility so
// sibling-route navigation can reuse a retained static layout without treating
// the source route id as part of the retained artifact identity.
//
// renderEpoch is scoped to layout identity (layoutId, rootBoundaryId) and the
// rendering variant (variantCacheKey).  The leaf routeId is intentionally
// excluded — sibling routes under the same layout must produce the same
// renderEpoch, otherwise exact-equality skip gating would silently disable
// skip transport for the primary use case (navigating between sibling pages).
export function createStaticLayoutClientReuseArtifactCompatibility(
  input: StaticLayoutClientReuseProofInput,
): ArtifactCompatibilityEnvelope {
  return {
    ...input.artifactCompatibility,
    graphVersion: `static-layout-graph:${createClientReusePayloadHash(
      JSON.stringify({
        layoutId: input.layoutId,
        rootBoundaryId: input.rootBoundaryId,
      }),
    )}`,
    renderEpoch: `static-layout:${createClientReusePayloadHash(
      JSON.stringify({
        layoutId: input.layoutId,
        rootBoundaryId: input.rootBoundaryId,
        variantCacheKey: input.variantCacheKey,
      }),
    )}`,
  };
}
