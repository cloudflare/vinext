import {
  evaluateArtifactCompatibility,
  ARTIFACT_COMPATIBILITY_PROOF_FIELDS,
  type ArtifactCompatibilityEnvelope,
  type ArtifactCompatibilityEvaluationOptions,
} from "./artifact-compatibility.js";
import type { StaticLayoutArtifactReuseDecision } from "./cache-proof.js";
import {
  CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET,
  createClientReusePayloadHash,
  type ClientReuseManifestEntry,
  type ClientReuseManifestEntryRejection,
  type ClientReuseManifestParseResult,
  type ClientReuseManifestRejection,
  type ClientReuseManifestSkipDisposition,
  type ClientReuseManifestTraceFields,
} from "./client-reuse-manifest.js";
export {
  createStaticLayoutClientReuseArtifactCompatibility,
  createStaticLayoutClientReusePayloadHash,
  createStaticLayoutClientReuseRouteId,
} from "./static-layout-client-reuse-proof.js";

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

type ClientReuseSkipTransportPlan =
  | Readonly<{
      entryRejections: readonly ClientReuseManifestEntryRejection[];
      kind: "renderAndSend";
      manifestRejection?: ClientReuseManifestRejection;
      skipDisposition: ClientReuseManifestSkipDisposition;
      skipIneligibleEntryIds: readonly string[];
      skippedEntryIds: readonly string[];
    }>
  | Readonly<{
      entryRejections: readonly ClientReuseManifestEntryRejection[];
      kind: "skip";
      skipDisposition: ClientReuseManifestSkipDisposition;
      skipIneligibleEntryIds: readonly string[];
      skippedEntryIds: readonly string[];
    }>;

type CreateClientReuseSkipTransportPlanInput = Readonly<{
  manifest: ClientReuseManifestParseResult;
  maxWireEntriesToVerify?: number;
  verifyEntry: (entry: ClientReuseManifestEntry) => SkipCacheCrossCheckResult;
}>;

function createDisabledSkipDisposition(): ClientReuseManifestSkipDisposition {
  return {
    code: "SKIP_MODEL_DISABLED",
    enabled: false,
    mode: "renderAndSend",
  };
}

function createStaticLayoutSkipDisposition(
  skippedEntryIds: readonly string[],
): ClientReuseManifestSkipDisposition {
  return {
    code: "SKIP_STATIC_LAYOUT_VERIFIED",
    enabled: true,
    mode: "skipStaticLayout",
    skippedEntryIds: [...skippedEntryIds],
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

function isExactArtifactCompatibility(
  artifactCompatibility: ArtifactCompatibilityEnvelope,
  entryCompatibility: ArtifactCompatibilityEnvelope,
): boolean {
  return (
    collectArtifactCompatibilityProofMismatches(artifactCompatibility, entryCompatibility)
      .length === 0
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled skip/cache proof state: ${String(value)}`);
}

function createRenderAndSendPlan(options: {
  entryRejections?: readonly ClientReuseManifestEntryRejection[];
  manifestRejection?: ClientReuseManifestRejection;
  skipIneligibleEntryIds?: readonly string[];
}): ClientReuseSkipTransportPlan {
  return {
    kind: "renderAndSend",
    entryRejections: options.entryRejections ?? [],
    ...(options.manifestRejection ? { manifestRejection: options.manifestRejection } : {}),
    skipDisposition: createDisabledSkipDisposition(),
    skipIneligibleEntryIds: options.skipIneligibleEntryIds ?? [],
    skippedEntryIds: [],
  };
}

function createVerificationBudgetExceededRejection(
  totalWireEntries: number,
  maxWireEntriesToVerify: number,
): ClientReuseManifestRejection {
  return {
    code: "SKIP_VERIFICATION_BUDGET_EXCEEDED",
    fields: { totalWireEntries, maxWireEntriesToVerify },
  };
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

  // Skip transport requires exact artifact field equality — not just
  // compatibility-map-based equivalence.  evaluateArtifactCompatibility (above)
  // returns "compatible" when a declared set bridges differing fields (canary →
  // rollback), but the skip planner must not elide a fresh render when the two
  // payloads were built from observably different artifact environments.
  // isExactArtifactCompatibility performs a distinct field-level walk that
  // ignores the compatibility map, guaranteeing only bit-identical artifact
  // envelopes are eligible for transport skip.
  const skipDisposition = isExactArtifactCompatibility(
    input.artifact.compatibility,
    entry.artifactCompatibility,
  )
    ? createStaticLayoutSkipDisposition([entry.id])
    : createDisabledSkipDisposition();

  return {
    kind: "verified",
    code: "SKIP_CACHE_CROSS_CHECK_PASSED",
    entryId: entry.id,
    fields: {
      entryKind: entry.kind,
      reuseClass: proof.reuseClass,
      variantCacheKeyHash: createClientReusePayloadHash(proof.variant.cacheKey),
    },
    skipDisposition,
  };
}

export function createClientReuseSkipTransportPlan(
  input: CreateClientReuseSkipTransportPlanInput,
): ClientReuseSkipTransportPlan {
  const { manifest } = input;
  if (manifest.kind === "absent") {
    return createRenderAndSendPlan({});
  }
  if (manifest.kind === "rejected") {
    return createRenderAndSendPlan({ manifestRejection: manifest.rejection });
  }

  const maxWireEntriesToVerify =
    input.maxWireEntriesToVerify ?? CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET;
  if (!Number.isSafeInteger(maxWireEntriesToVerify) || maxWireEntriesToVerify < 0) {
    throw new RangeError("maxWireEntriesToVerify must be a non-negative safe integer");
  }

  const totalWireEntries = manifest.manifest.entries.length + manifest.entryRejections.length;
  if (totalWireEntries > maxWireEntriesToVerify) {
    return createRenderAndSendPlan({
      entryRejections: manifest.entryRejections,
      manifestRejection: createVerificationBudgetExceededRejection(
        totalWireEntries,
        maxWireEntriesToVerify,
      ),
    });
  }

  const skippedEntryIds: string[] = [];
  const skipIneligibleEntryIds: string[] = [];
  const entryRejections: ClientReuseManifestEntryRejection[] = [...manifest.entryRejections];
  for (const entry of manifest.manifest.entries) {
    const verification = input.verifyEntry(entry);
    if (verification.kind === "rejected") {
      entryRejections.push(verification.rejection);
      continue;
    }

    // The planner must not trust a verifier that returns a verified result
    // for a different entry than the one it was given.  This is an internal
    // invariant, not a hostile-client defence.
    if (verification.entryId !== entry.id) {
      entryRejections.push({
        code: "SKIP_CACHE_ENTRY_ID_MISMATCH",
        entryId: entry.id,
        fields: {
          verifierEntryId: verification.entryId,
          manifestEntryId: entry.id,
        },
      });
      continue;
    }

    if (verification.skipDisposition.enabled) {
      skippedEntryIds.push(entry.id);
    } else {
      skipIneligibleEntryIds.push(entry.id);
    }
  }

  if (skippedEntryIds.length === 0) {
    return createRenderAndSendPlan({ entryRejections, skipIneligibleEntryIds });
  }

  return {
    kind: "skip",
    entryRejections,
    skipDisposition: createStaticLayoutSkipDisposition(skippedEntryIds),
    skipIneligibleEntryIds,
    skippedEntryIds,
  };
}
