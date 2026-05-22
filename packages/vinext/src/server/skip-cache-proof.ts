import {
  evaluateArtifactCompatibility,
  type ArtifactCompatibilityEnvelope,
  type ArtifactCompatibilityEvaluationOptions,
} from "./artifact-compatibility.js";
import type { StaticLayoutArtifactReuseDecision } from "./cache-proof.js";
import {
  createClientReusePayloadHash,
  type ClientReuseManifestEntry,
  type ClientReuseManifestEntryRejection,
  type ClientReuseManifestSkipDisposition,
  type ClientReuseManifestTraceFields,
} from "./client-reuse-manifest.js";

export type SkipCacheInvalidationProof =
  | Readonly<{ kind: "invalidated"; invalidationEpoch: string | null }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "valid" }>;

type SkipCacheArtifactProof = Readonly<{
  compatibility: ArtifactCompatibilityEnvelope;
  invalidation: SkipCacheInvalidationProof;
  payloadHash: string | null;
}>;

type SkipCacheCrossCheckAcceptanceCode = "SKIP_CACHE_CROSS_CHECK_PASSED";

type SkipCacheCrossCheckVerified = Readonly<{
  code: SkipCacheCrossCheckAcceptanceCode;
  entryId: string;
  fields: ClientReuseManifestTraceFields;
  kind: "verified";
  skipDisposition: ClientReuseManifestSkipDisposition;
}>;

type SkipCacheCrossCheckRejected = Readonly<{
  kind: "rejected";
  rejection: ClientReuseManifestEntryRejection;
  skipDisposition: ClientReuseManifestSkipDisposition;
}>;

type SkipCacheCrossCheckResult = SkipCacheCrossCheckRejected | SkipCacheCrossCheckVerified;

type CrossCheckClientReuseManifestEntryWithCacheInput = Readonly<{
  artifact: SkipCacheArtifactProof;
  cacheDecision: StaticLayoutArtifactReuseDecision | null;
  entry: ClientReuseManifestEntry;
}> &
  ArtifactCompatibilityEvaluationOptions;

const ARTIFACT_COMPATIBILITY_PROOF_FIELDS: readonly (keyof ArtifactCompatibilityEnvelope)[] = [
  "schemaVersion",
  "graphVersion",
  "deploymentVersion",
  "appElementsSchemaVersion",
  "rscPayloadSchemaVersion",
  "rootBoundaryId",
  "renderEpoch",
];

function createDisabledSkipDisposition(): ClientReuseManifestSkipDisposition {
  return {
    code: "SKIP_MODEL_DISABLED",
    enabled: false,
    mode: "renderAndSend",
  };
}

function rejectSkipCacheCrossCheck(
  entry: ClientReuseManifestEntry,
  code: ClientReuseManifestEntryRejection["code"],
  fields: ClientReuseManifestTraceFields = {},
): SkipCacheCrossCheckRejected {
  return {
    kind: "rejected",
    rejection: {
      code,
      entryId: entry.id,
      fields,
    },
    skipDisposition: createDisabledSkipDisposition(),
  };
}

function collectArtifactCompatibilityProofMismatches(
  artifactCompatibility: ArtifactCompatibilityEnvelope,
  proofCompatibility: ArtifactCompatibilityEnvelope,
): readonly string[] {
  const mismatchedFields: string[] = [];
  for (const field of ARTIFACT_COMPATIBILITY_PROOF_FIELDS) {
    if (artifactCompatibility[field] !== proofCompatibility[field]) {
      mismatchedFields.push(field);
    }
  }
  return mismatchedFields;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled skip/cache proof state: ${String(value)}`);
}

function crossCheckInvalidationProof(
  entry: ClientReuseManifestEntry,
  invalidation: SkipCacheInvalidationProof,
): SkipCacheCrossCheckRejected | null {
  switch (invalidation.kind) {
    case "valid":
      return null;
    case "unknown":
      return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_INVALIDATION_UNKNOWN");
    case "invalidated":
      return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_INVALIDATED", {
        invalidationEpoch: invalidation.invalidationEpoch,
      });
    default:
      return assertNever(invalidation);
  }
}

export function crossCheckClientReuseManifestEntryWithCache(
  input: CrossCheckClientReuseManifestEntryWithCacheInput,
): SkipCacheCrossCheckResult {
  const { cacheDecision, entry } = input;
  if (cacheDecision === null) {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_PROOF_MISSING");
  }
  if (cacheDecision.kind === "fallback") {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_PROOF_REJECTED", {
      cacheProofCode: cacheDecision.fallback.code,
      cacheProofMode: cacheDecision.fallback.mode,
      cacheProofScope: cacheDecision.fallback.scope,
    });
  }

  const { proof } = cacheDecision;
  if (entry.kind !== "layout" || proof.reuseClass !== "static-layout") {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_REUSE_CLASS_UNSUPPORTED", {
      entryKind: entry.kind,
      reuseClass: proof.reuseClass,
    });
  }

  if (entry.id !== proof.candidateOutput.layoutId) {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_ENTRY_ID_MISMATCH", {
      cacheEntryId: proof.candidateOutput.layoutId,
      manifestEntryId: entry.id,
    });
  }

  const artifactProofMismatches = collectArtifactCompatibilityProofMismatches(
    input.artifact.compatibility,
    proof.candidateArtifactCompatibility,
  );
  if (artifactProofMismatches.length > 0) {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_ARTIFACT_PROOF_MISMATCH", {
      mismatchedFields: artifactProofMismatches,
    });
  }

  const artifactCompatibility = evaluateArtifactCompatibility(
    input.artifact.compatibility,
    entry.artifactCompatibility,
    { compatibilityMap: input.compatibilityMap },
  );
  if (artifactCompatibility.kind === "unknown") {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_ARTIFACT_COMPATIBILITY_UNKNOWN", {
      compatibilityFallback: artifactCompatibility.fallback,
      reason: artifactCompatibility.reason,
    });
  }
  if (artifactCompatibility.kind === "incompatible") {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_ARTIFACT_COMPATIBILITY_INCOMPATIBLE", {
      compatibilityFallback: artifactCompatibility.fallback,
      reason: artifactCompatibility.reason,
    });
  }

  if (entry.variantCacheKey !== proof.variant.cacheKey) {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_VARIANT_MISMATCH", {
      cacheVariantCacheKeyHash: createClientReusePayloadHash(proof.variant.cacheKey),
      entryVariantCacheKeyHash: createClientReusePayloadHash(entry.variantCacheKey),
    });
  }

  if (input.artifact.payloadHash === null) {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_PAYLOAD_HASH_MISSING");
  }

  if (entry.payloadHash !== input.artifact.payloadHash) {
    return rejectSkipCacheCrossCheck(entry, "SKIP_CACHE_PAYLOAD_HASH_MISMATCH", {
      cachePayloadHash: input.artifact.payloadHash,
      entryPayloadHash: entry.payloadHash,
    });
  }

  const invalidationRejection = crossCheckInvalidationProof(entry, input.artifact.invalidation);
  if (invalidationRejection) return invalidationRejection;

  return {
    kind: "verified",
    code: "SKIP_CACHE_CROSS_CHECK_PASSED",
    entryId: entry.id,
    fields: {
      entryKind: entry.kind,
      reuseClass: proof.reuseClass,
      variantCacheKeyHash: createClientReusePayloadHash(proof.variant.cacheKey),
    },
    skipDisposition: createDisabledSkipDisposition(),
  };
}
