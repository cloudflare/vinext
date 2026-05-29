import type { ArtifactCompatibilityEnvelope } from "./artifact-compatibility.js";
import { createClientReusePayloadHash } from "./client-reuse-manifest.js";

type StaticLayoutClientReuseProofInput = Readonly<{
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  layoutId: string;
  rootBoundaryId: string | null;
  routeId: string;
  variantCacheKey: string;
}>;

export const ARTIFACT_COMPATIBILITY_PROOF_FIELDS: readonly (keyof ArtifactCompatibilityEnvelope)[] =
  [
    "schemaVersion",
    "graphVersion",
    "deploymentVersion",
    "appElementsSchemaVersion",
    "rscPayloadSchemaVersion",
    "rootBoundaryId",
    "renderEpoch",
  ];

export function createStaticLayoutClientReuseRouteId(layoutId: string): string {
  return `static-layout:${createClientReusePayloadHash(layoutId)}`;
}

function createCanonicalProofPairs(
  input: StaticLayoutClientReuseProofInput,
): readonly (readonly [string, string | number | null])[] {
  return ARTIFACT_COMPATIBILITY_PROOF_FIELDS.map(
    (field) => [field, input.artifactCompatibility[field]] as const,
  );
}

export function createStaticLayoutClientReusePayloadHash(
  input: StaticLayoutClientReuseProofInput,
): string {
  // Field order in ARTIFACT_COMPATIBILITY_PROOF_FIELDS is load-bearing for
  // hash determinism.  JSON.stringify key order follows insertion order in V8
  // (and in practice across all supported runtimes), so the serialized payload
  // is stable as long as this module's field list is not reordered.  If the
  // field list must change, bump the hash algorithm or namespace to avoid
  // silent cross-deployment hash drift.
  return createClientReusePayloadHash(
    JSON.stringify({
      artifactCompatibility: Object.fromEntries(createCanonicalProofPairs(input)),
      layoutId: input.layoutId,
      rootBoundaryId: input.rootBoundaryId,
      routeId: input.routeId,
      variantCacheKey: input.variantCacheKey,
    }),
  );
}

// The app-route payload envelope is route-scoped and may not carry a render epoch
// during this wave. Static-layout skip needs layout-scoped compatibility so
// sibling-route navigation can reuse a retained static layout without treating
// the source route id as part of the retained artifact identity.
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
        routeId: input.routeId,
        variantCacheKey: input.variantCacheKey,
      }),
    )}`,
  };
}
