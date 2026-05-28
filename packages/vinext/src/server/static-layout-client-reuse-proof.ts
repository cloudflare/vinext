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

export function createStaticLayoutClientReusePayloadHash(
  input: StaticLayoutClientReuseProofInput,
): string {
  const artifactCompatibility: Record<string, string | number | null> = {};
  for (const field of ARTIFACT_COMPATIBILITY_PROOF_FIELDS) {
    artifactCompatibility[field] = input.artifactCompatibility[field];
  }

  return createClientReusePayloadHash(
    JSON.stringify({
      artifactCompatibility,
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
