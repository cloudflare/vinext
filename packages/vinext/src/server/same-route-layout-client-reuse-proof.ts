import {
  ARTIFACT_COMPATIBILITY_PROOF_FIELDS,
  type ArtifactCompatibilityEnvelope,
} from "./artifact-compatibility.js";
import { createClientReusePayloadHash } from "./client-reuse-manifest.js";

type SameRouteLayoutClientReuseProofInput = Readonly<{
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  layoutId: string;
  pathname: string;
  routeId: string;
}>;

function createIdentity(input: SameRouteLayoutClientReuseProofInput): string {
  return JSON.stringify({
    artifactCompatibilityPairs: ARTIFACT_COMPATIBILITY_PROOF_FIELDS.map((field) => [
      field,
      input.artifactCompatibility[field],
    ]),
    layoutId: input.layoutId,
    pathname: input.pathname,
    routeId: input.routeId,
  });
}

export function createSameRouteLayoutClientReuseVariantCacheKey(
  input: SameRouteLayoutClientReuseProofInput,
): string {
  return `same-route-layout:${createClientReusePayloadHash(createIdentity(input))}`;
}

export function createSameRouteLayoutClientReusePayloadHash(
  input: SameRouteLayoutClientReuseProofInput,
): string {
  return createClientReusePayloadHash(`payload:${createIdentity(input)}`);
}
