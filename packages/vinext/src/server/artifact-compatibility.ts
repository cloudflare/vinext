import { fnv1a64 } from "../utils/hash.js";
import { isUnknownRecord as isRecord } from "../utils/record.js";

export const ARTIFACT_COMPATIBILITY_SCHEMA_VERSION = 1;

// These versions describe separate protocol layers. For example, a future
// rolling deploy can bump the flat AppElements row shape while keeping the
// envelope object and serialized RSC transport version stable.
export const APP_ELEMENTS_SCHEMA_VERSION = 1;
export const RSC_PAYLOAD_SCHEMA_VERSION = 1;

export type ArtifactCompatibilityEnvelope = Readonly<{
  schemaVersion: typeof ARTIFACT_COMPATIBILITY_SCHEMA_VERSION;
  graphVersion: string | null;
  deploymentVersion: string | null;
  appElementsSchemaVersion: typeof APP_ELEMENTS_SCHEMA_VERSION;
  rscPayloadSchemaVersion: typeof RSC_PAYLOAD_SCHEMA_VERSION;
  rootBoundaryId: string | null;
  renderEpoch: string | null;
}>;

// Canonical ordered list of every field in ArtifactCompatibilityEnvelope.
// Order is load-bearing — hash-producing consumers iterate this array to
// guarantee deterministic ordering across runtimes.
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

type ArtifactCompatibilityEnvelopeInput = Readonly<{
  graphVersion?: string | null;
  deploymentVersion?: string | null;
  rootBoundaryId?: string | null;
  renderEpoch?: string | null;
}>;

export type ArtifactCompatibilitySet = readonly [string, string, ...string[]];

export type ArtifactCompatibilityMap = Readonly<{
  graphVersions?: readonly ArtifactCompatibilitySet[];
  deploymentVersions?: readonly ArtifactCompatibilitySet[];
  rootBoundaryIds?: readonly ArtifactCompatibilitySet[];
  renderEpochs?: readonly ArtifactCompatibilitySet[];
}>;

export type ArtifactCompatibilityEvaluationOptions = Readonly<{
  compatibilityMap?: ArtifactCompatibilityMap;
}>;

type ArtifactCompatibilityFallback = "renderFresh";

type ArtifactCompatibilityUnknownReason =
  | "graphVersionUnknown"
  | "deploymentVersionUnknown"
  | "rootBoundaryIdUnknown"
  | "renderEpochUnknown";

type ArtifactCompatibilityIncompatibleReason =
  | "appElementsSchemaVersionMismatch"
  | "deploymentVersionNotDeclaredCompatible"
  | "deploymentVersionMismatch"
  | "graphVersionNotDeclaredCompatible"
  | "graphVersionMismatch"
  | "renderEpochNotDeclaredCompatible"
  | "renderEpochMismatch"
  | "rootBoundaryIdNotDeclaredCompatible"
  | "rootBoundaryIdMismatch"
  | "rscPayloadSchemaVersionMismatch"
  | "schemaVersionMismatch";

type ArtifactCompatibilityDecision = Readonly<
  | { kind: "compatible" }
  | {
      kind: "unknown";
      fallback: ArtifactCompatibilityFallback;
      reason: ArtifactCompatibilityUnknownReason;
    }
  | {
      kind: "incompatible";
      fallback: ArtifactCompatibilityFallback;
      reason: ArtifactCompatibilityIncompatibleReason;
    }
>;

type ArtifactCompatibilityGraphVersionInput = Readonly<{
  routePattern: string;
  rootBoundaryId: string | null;
}>;

export function createArtifactCompatibilityEnvelope(
  input: ArtifactCompatibilityEnvelopeInput = {},
): ArtifactCompatibilityEnvelope {
  return {
    schemaVersion: ARTIFACT_COMPATIBILITY_SCHEMA_VERSION,
    graphVersion: input.graphVersion ?? null,
    deploymentVersion: input.deploymentVersion ?? null,
    appElementsSchemaVersion: APP_ELEMENTS_SCHEMA_VERSION,
    rscPayloadSchemaVersion: RSC_PAYLOAD_SCHEMA_VERSION,
    rootBoundaryId: input.rootBoundaryId ?? null,
    renderEpoch: input.renderEpoch ?? null,
  };
}

export function createArtifactCompatibilityGraphVersion(
  input: ArtifactCompatibilityGraphVersionInput,
): string {
  const fingerprint = fnv1a64(JSON.stringify([input.routePattern, input.rootBoundaryId]));
  return `app-route-graph:${fingerprint}`;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function hasCurrentSchemaVersions(record: Readonly<Record<string, unknown>>): boolean {
  return (
    record.schemaVersion === ARTIFACT_COMPATIBILITY_SCHEMA_VERSION &&
    record.appElementsSchemaVersion === APP_ELEMENTS_SCHEMA_VERSION &&
    record.rscPayloadSchemaVersion === RSC_PAYLOAD_SCHEMA_VERSION
  );
}

export function parseArtifactCompatibilityEnvelope(
  value: unknown,
): ArtifactCompatibilityEnvelope | null {
  if (!isRecord(value)) return null;
  // The Wave01 skeleton intentionally collapses version mismatch and malformed
  // metadata into "not current". Cache/skip callers must split those cases
  // before treating unknown compatibility as anything other than a miss/reject.
  if (!hasCurrentSchemaVersions(value)) return null;
  if (!isStringOrNull(value.graphVersion)) return null;
  if (!isStringOrNull(value.deploymentVersion)) return null;
  if (!isStringOrNull(value.rootBoundaryId)) return null;
  if (!isStringOrNull(value.renderEpoch)) return null;

  // This parser intentionally returns a normalized current-version proof. A
  // future-compatible reader should introduce a separate parsed type instead of
  // widening this Wave01 envelope after the current-version checks above.
  return {
    schemaVersion: ARTIFACT_COMPATIBILITY_SCHEMA_VERSION,
    graphVersion: value.graphVersion,
    deploymentVersion: value.deploymentVersion,
    appElementsSchemaVersion: APP_ELEMENTS_SCHEMA_VERSION,
    rscPayloadSchemaVersion: RSC_PAYLOAD_SCHEMA_VERSION,
    rootBoundaryId: value.rootBoundaryId,
    renderEpoch: value.renderEpoch,
  };
}

function incompatible(
  reason: ArtifactCompatibilityIncompatibleReason,
): ArtifactCompatibilityDecision {
  return { kind: "incompatible", fallback: "renderFresh", reason };
}

function unknown(reason: ArtifactCompatibilityUnknownReason): ArtifactCompatibilityDecision {
  return { kind: "unknown", fallback: "renderFresh", reason };
}

function compareKnownField(
  currentValue: string | null,
  candidateValue: string | null,
  unknownReason: ArtifactCompatibilityUnknownReason,
  mismatchReason: ArtifactCompatibilityIncompatibleReason,
  notDeclaredCompatibleReason: ArtifactCompatibilityIncompatibleReason,
  compatibilitySets: readonly ArtifactCompatibilitySet[] | undefined,
): ArtifactCompatibilityDecision | null {
  if (currentValue === null || candidateValue === null) {
    return unknown(unknownReason);
  }
  if (currentValue === candidateValue) {
    return null;
  }
  if (compatibilitySets === undefined) {
    return incompatible(mismatchReason);
  }
  return isDeclaredCompatible(currentValue, candidateValue, compatibilitySets)
    ? null
    : incompatible(notDeclaredCompatibleReason);
}

function isDeclaredCompatible(
  currentValue: string,
  candidateValue: string,
  compatibilitySets: readonly ArtifactCompatibilitySet[],
): boolean {
  // Compatibility is intentionally scoped to one declared set. Overlapping
  // pair sets like [a,b] and [b,c] must not silently make a compatible with c.
  return compatibilitySets.some(
    (compatibilitySet) =>
      compatibilitySet.includes(currentValue) && compatibilitySet.includes(candidateValue),
  );
}

export function evaluateArtifactCompatibility(
  current: ArtifactCompatibilityEnvelope,
  candidate: ArtifactCompatibilityEnvelope,
  options: ArtifactCompatibilityEvaluationOptions = {},
): ArtifactCompatibilityDecision {
  // This remains a proof evaluator: mismatched fields are compatible only when
  // the current build's compatibility map explicitly declares that relationship.
  if (current.schemaVersion !== candidate.schemaVersion) {
    return incompatible("schemaVersionMismatch");
  }
  if (current.appElementsSchemaVersion !== candidate.appElementsSchemaVersion) {
    return incompatible("appElementsSchemaVersionMismatch");
  }
  if (current.rscPayloadSchemaVersion !== candidate.rscPayloadSchemaVersion) {
    return incompatible("rscPayloadSchemaVersionMismatch");
  }

  const graphDecision = compareKnownField(
    current.graphVersion,
    candidate.graphVersion,
    "graphVersionUnknown",
    "graphVersionMismatch",
    "graphVersionNotDeclaredCompatible",
    options.compatibilityMap?.graphVersions,
  );
  if (graphDecision) return graphDecision;

  const deploymentDecision = compareKnownField(
    current.deploymentVersion,
    candidate.deploymentVersion,
    "deploymentVersionUnknown",
    "deploymentVersionMismatch",
    "deploymentVersionNotDeclaredCompatible",
    options.compatibilityMap?.deploymentVersions,
  );
  if (deploymentDecision) return deploymentDecision;

  const rootBoundaryDecision = compareKnownField(
    current.rootBoundaryId,
    candidate.rootBoundaryId,
    "rootBoundaryIdUnknown",
    "rootBoundaryIdMismatch",
    "rootBoundaryIdNotDeclaredCompatible",
    options.compatibilityMap?.rootBoundaryIds,
  );
  if (rootBoundaryDecision) return rootBoundaryDecision;

  const renderEpochDecision = compareKnownField(
    current.renderEpoch,
    candidate.renderEpoch,
    "renderEpochUnknown",
    "renderEpochMismatch",
    "renderEpochNotDeclaredCompatible",
    options.compatibilityMap?.renderEpochs,
  );
  if (renderEpochDecision) return renderEpochDecision;

  return { kind: "compatible" };
}
