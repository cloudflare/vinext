import { fnv1a64 } from "../utils/hash.js";
import type { ArtifactCompatibilityEnvelope } from "./artifact-compatibility.js";

export const CACHE_PROOF_MODEL_SCHEMA_VERSION = 1;
export type CacheProofModelSchemaVersion = 1;

export type CacheProofRejectionCode =
  | "CP_CACHE_ENTRY_PROOF_MISSING"
  | "CP_MODEL_DISABLED"
  | "CP_ARTIFACT_COMPATIBILITY_INCOMPATIBLE"
  | "CP_ARTIFACT_COMPATIBILITY_UNKNOWN"
  | "CP_DIMENSION_COUNT_EXCEEDED"
  | "CP_DIMENSION_NAME_MISSING"
  | "CP_DIMENSION_NAME_TOO_LONG"
  | "CP_DIMENSION_VALUE_COUNT_EXCEEDED"
  | "CP_DIMENSION_VALUE_TOO_LONG"
  | "CP_DIMENSION_VALUES_MISSING"
  | "CP_ENCODED_VARIANT_TOO_LONG"
  | "CP_INVALID_VARIANT_BUDGET"
  | "CP_ROUTE_VARIANT_BUDGET_ROUTE_MISMATCH"
  | "CP_ROUTE_VARIANT_CEILING_EXCEEDED"
  | "CP_UNSAFE_PUBLIC_DIMENSION"
  | "CP_BOUNDARY_OUTCOME_MISMATCH"
  | "CP_BOUNDARY_OUTCOME_UNKNOWN"
  | "CP_PRIVATE_DYNAMIC_DOWNGRADE"
  | "CP_STATIC_LAYOUT_CANDIDATE_OUTPUT_KIND"
  | "CP_STATIC_LAYOUT_CURRENT_OUTPUT_KIND"
  | "CP_STATIC_LAYOUT_ID_MISMATCH"
  | "CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_KIND"
  | "CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_MISMATCH"
  | "CP_STATIC_LAYOUT_PRIVATE_DYNAMIC_DOWNGRADE"
  | "CP_STATIC_LAYOUT_REQUEST_API_OBSERVED"
  | "CP_STATIC_LAYOUT_REQUEST_API_UNKNOWN"
  | "CP_STATIC_LAYOUT_ROOT_BOUNDARY_MISMATCH"
  | "CP_STATIC_LAYOUT_ROOT_BOUNDARY_UNKNOWN"
  | "CP_STATIC_LAYOUT_VARIANT_DIMENSION_UNPROVEN";

export type CacheProofAcceptanceCode = "CP_STATIC_LAYOUT_REUSE_PROVEN";

export type CacheProofTraceCode = CacheProofAcceptanceCode | CacheProofRejectionCode;

export type CacheProofTraceFieldValue = string | number | boolean | null | readonly string[];

export type CacheProofTraceFields = Readonly<Record<string, CacheProofTraceFieldValue>>;

export type CacheProofBreakerFallbackMode = "renderFresh" | "privateUncacheable";
export type CacheProofFallbackScope = "affectedOutput" | "route";

export type CacheProofBreakerFallback = Readonly<{
  kind: "breakerFallback";
  code: CacheProofRejectionCode;
  mode: CacheProofBreakerFallbackMode;
  scope: CacheProofFallbackScope;
  fields: CacheProofTraceFields;
}>;

export type CacheVariantBudget = Readonly<{
  maxDimensionCount: number;
  maxDimensionNameLength: number;
  maxDimensionValueLength: number;
  maxEncodedLength: number;
  maxValuesPerDimension: number;
  maxVariantsPerRoute: number;
}>;

export type CacheVariantDimensionSource =
  | "auth"
  | "cookie"
  | "custom"
  | "draft-mode"
  | "header"
  | "interception"
  | "mounted-slots"
  | "params"
  | "route"
  | "search"
  | "session";

export type CacheVariantDimensionPrivacy = "internal" | "private" | "public";

export type CacheVariantDimension = Readonly<{
  encoded: string;
  name: string;
  privacy: CacheVariantDimensionPrivacy;
  source: CacheVariantDimensionSource;
  valueCount: number;
  valueHashes: readonly string[];
}>;

export type CacheProofOutputScope =
  | Readonly<{
      kind: "app-html";
      renderEpoch: string | null;
      rootBoundaryId: string | null;
      routeId: string;
    }>
  | Readonly<{
      kind: "app-rsc";
      mountedSlotsFingerprint: string | null;
      renderEpoch: string | null;
      rootBoundaryId: string | null;
      routeId: string;
    }>
  | Readonly<{
      kind: "layout";
      layoutId: string;
      rootBoundaryId: string | null;
      routeId: string;
    }>
  | Readonly<{
      kind: "page";
      pageId: string;
      rootBoundaryId: string | null;
      routeId: string;
    }>
  | Readonly<{
      kind: "route-handler";
      routeHandlerId: string;
      routeId: string;
    }>
  | Readonly<{
      kind: "slot";
      rootBoundaryId: string | null;
      routeId: string;
      slotId: string;
    }>
  | Readonly<{
      kind: "template";
      rootBoundaryId: string | null;
      routeId: string;
      templateId: string;
    }>;

export type StaticLayoutCacheProofOutputScope = Extract<CacheProofOutputScope, { kind: "layout" }>;

export type CacheVariant = Readonly<{
  budget: CacheVariantBudget;
  cacheKey: string;
  dimensions: readonly CacheVariantDimension[];
  encodedLength: number;
  output: CacheProofOutputScope;
  schemaVersion: CacheProofModelSchemaVersion;
}>;

export type BoundaryOutcome =
  | Readonly<{ kind: "error"; digest?: string }>
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "globalError"; digest?: string }>
  | Readonly<{ kind: "notFound" }>
  | Readonly<{ kind: "redirect"; location: string; status: number }>
  | Readonly<{ kind: "success" }>
  | Readonly<{ kind: "unauthorized" }>
  | Readonly<{ kind: "unknown" }>;

export type RenderObservationCompleteness = "complete" | "partial" | "unknown";
export type RenderCacheability = "private" | "public" | "uncacheable" | "unknown";
export type RenderRequestApiKind =
  | "connection"
  | "cookies"
  | "draftMode"
  | "headers"
  | "params"
  | "searchParams";
export type RenderRequestApiStatus = "notObserved" | "observed" | "unknown";

export const ALL_RENDER_REQUEST_API_KINDS: readonly RenderRequestApiKind[] = [
  "connection",
  "cookies",
  "draftMode",
  "headers",
  "params",
  "searchParams",
];

export type RenderRequestApiObservation = Readonly<{
  kind: RenderRequestApiKind;
  status: RenderRequestApiStatus;
}>;

export type CacheProofDowngradeTarget =
  | "freshRender"
  | "private"
  | "privateUncacheable"
  | "public"
  | "publicVariant";

export type CacheProofDowngradeReason =
  | Readonly<{
      code: "CP_DOWNGRADE_CACHEABILITY_PRIVATE";
      target: "private";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_CACHEABILITY_UNCACHEABLE";
      target: "privateUncacheable";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_CACHEABILITY_UNKNOWN";
      target: "freshRender";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_DYNAMIC_FETCH";
      dynamicFetchCount: number;
      target: "freshRender";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_DYNAMIC_REQUEST_API";
      requestApi: "connection";
      target: "freshRender";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_DRAFT_MODE";
      requestApi: "draftMode";
      target: "privateUncacheable";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_INCOMPLETE_OBSERVATION";
      completeness: Exclude<RenderObservationCompleteness, "complete">;
      target: "freshRender";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION";
      inputClass: "auth" | "draft" | "private" | "session";
      source: "auth" | "cookie" | "draft-mode" | "header" | "session";
      target: "private" | "privateUncacheable";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_PRIVATE_REQUEST_API";
      requestApi: "cookies" | "headers";
      target: "private";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_PUBLIC_REQUEST_API";
      requestApi: "params" | "searchParams";
      target: "publicVariant";
    }>
  | Readonly<{
      code: "CP_DOWNGRADE_UNKNOWN_REQUEST_API";
      requestApi: RenderRequestApiKind;
      target: "freshRender";
    }>;

export type CacheProofDowngradeClassification = Readonly<{
  fallback: CacheProofBreakerFallback | null;
  isPublicCacheCandidate: boolean;
  reasons: readonly CacheProofDowngradeReason[];
  target: CacheProofDowngradeTarget;
}>;

export type ClassifyRenderObservationDowngradeInput = Readonly<{
  cacheability: RenderCacheability;
  completeness: RenderObservationCompleteness;
  dynamicFetches: readonly string[];
  requestApis: readonly RenderRequestApiObservation[];
}>;

export type RenderObservation = Readonly<{
  boundaryOutcome: BoundaryOutcome;
  cacheTags: readonly string[];
  cacheability: RenderCacheability;
  completeness: RenderObservationCompleteness;
  downgrade: CacheProofDowngradeClassification;
  dynamicFetches: readonly string[];
  output: CacheProofOutputScope;
  pathTags: readonly string[];
  requestApis: readonly RenderRequestApiObservation[];
  schemaVersion: CacheProofModelSchemaVersion;
}>;

export type StaticLayoutReuseProof = Readonly<{
  authorizesRuntimeReuse: true;
  candidateOutput: StaticLayoutCacheProofOutputScope;
  code: "CP_STATIC_LAYOUT_REUSE_PROVEN";
  currentOutput: StaticLayoutCacheProofOutputScope;
  fields: CacheProofTraceFields;
  observation: RenderObservation;
  requiredNegativeRequestApis: readonly RenderRequestApiKind[];
  reuseClass: "static-layout";
  variant: CacheVariant;
}>;

export type StaticLayoutArtifactReuseProof = StaticLayoutReuseProof &
  Readonly<{
    candidateArtifactCompatibility: ArtifactCompatibilityEnvelope;
  }>;

export type CacheProofHotPathMetric = Readonly<{
  code: CacheProofTraceCode;
  fields: CacheProofTraceFields;
  name: "vinext.cache.static_layout_artifact_reuse";
  outcome: "fallback" | "reuse";
}>;

export type StaticLayoutArtifactReuseDecision =
  | Readonly<{
      canReuse: true;
      kind: "reuse";
      metric: CacheProofHotPathMetric;
      proof: StaticLayoutArtifactReuseProof;
    }>
  | Readonly<{
      canReuse: false;
      fallback: CacheProofBreakerFallback;
      kind: "fallback";
      metric: CacheProofHotPathMetric;
    }>;

export type CacheEntryReuseDecision =
  | Readonly<{
      canReuse: true;
      code: CacheProofAcceptanceCode;
      kind: "reuse";
      reuseClass: StaticLayoutReuseProof["reuseClass"];
    }>
  | Readonly<{
      canReuse: false;
      code: CacheProofRejectionCode;
      kind: "reject";
      mode: CacheProofBreakerFallbackMode;
      scope: CacheProofFallbackScope;
    }>;

export type CacheEntryReuseProof = Readonly<{
  decision: CacheEntryReuseDecision | null;
  kind: "runtime-cache-entry";
}>;

export type BuildRenderObservationInput = Readonly<{
  boundaryOutcome: BoundaryOutcome;
  cacheTags: readonly string[];
  cacheability: RenderCacheability;
  completeness: RenderObservationCompleteness;
  dynamicFetches: readonly string[];
  output: CacheProofOutputScope;
  pathTags: readonly string[];
  requestApis: readonly RenderRequestApiObservation[];
}>;

export type BuildRenderRequestApiObservationsInput = Readonly<{
  completeness: RenderObservationCompleteness;
  observed: readonly RenderRequestApiKind[];
}>;

function buildBreakerFallback(
  code: CacheProofRejectionCode,
  fields: CacheProofTraceFields = {},
  mode: CacheProofBreakerFallbackMode = "renderFresh",
  scope: CacheProofFallbackScope = "affectedOutput",
): CacheProofBreakerFallback {
  return {
    kind: "breakerFallback",
    code,
    mode,
    scope,
    fields,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function redactValue(value: string): string {
  return `h:${fnv1a64(value)}`;
}

function sortedUniqueRedacted(values: readonly string[]): string[] {
  return sortedUnique(sortedUnique(values).map(redactValue));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled cache proof variant: ${String(value)}`);
}

function requestApiStatusRank(status: RenderRequestApiStatus): number {
  switch (status) {
    case "notObserved":
      return 0;
    case "unknown":
      return 1;
    case "observed":
      return 2;
    default:
      return assertNever(status);
  }
}

function normalizeRequestApiObservations(
  observations: readonly RenderRequestApiObservation[],
): RenderRequestApiObservation[] {
  const byKind = new Map<RenderRequestApiKind, RenderRequestApiStatus>();
  for (const observation of observations) {
    const current = byKind.get(observation.kind);
    if (
      current === undefined ||
      requestApiStatusRank(observation.status) > requestApiStatusRank(current)
    ) {
      byKind.set(observation.kind, observation.status);
    }
  }

  return [...byKind.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, status]) => ({ kind, status }));
}

function cacheProofDowngradeTargetRank(target: CacheProofDowngradeTarget): number {
  switch (target) {
    case "public":
      return 0;
    case "publicVariant":
      return 1;
    case "private":
      return 2;
    case "privateUncacheable":
      return 3;
    case "freshRender":
      return 4;
    default:
      return assertNever(target);
  }
}

function maxCacheProofDowngradeTarget(
  current: CacheProofDowngradeTarget,
  candidate: CacheProofDowngradeTarget,
): CacheProofDowngradeTarget {
  return cacheProofDowngradeTargetRank(candidate) > cacheProofDowngradeTargetRank(current)
    ? candidate
    : current;
}

function createDowngradeFallback(
  target: CacheProofDowngradeTarget,
  reasons: readonly CacheProofDowngradeReason[],
): CacheProofBreakerFallback | null {
  switch (target) {
    case "public":
    case "publicVariant":
    case "private":
      return null;
    case "privateUncacheable":
      return buildBreakerFallback(
        "CP_PRIVATE_DYNAMIC_DOWNGRADE",
        {
          reasonCodes: reasons.map((reason) => reason.code),
          target,
        },
        "privateUncacheable",
      );
    case "freshRender":
      return buildBreakerFallback("CP_PRIVATE_DYNAMIC_DOWNGRADE", {
        reasonCodes: reasons.map((reason) => reason.code),
        target,
      });
    default:
      return assertNever(target);
  }
}

function classifyObservedRequestApiDowngrade(
  kind: RenderRequestApiKind,
): CacheProofDowngradeReason {
  switch (kind) {
    case "connection":
      return {
        code: "CP_DOWNGRADE_DYNAMIC_REQUEST_API",
        requestApi: "connection",
        target: "freshRender",
      };
    case "cookies":
      return {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "cookies",
        target: "private",
      };
    case "draftMode":
      return {
        code: "CP_DOWNGRADE_DRAFT_MODE",
        requestApi: "draftMode",
        target: "privateUncacheable",
      };
    case "headers":
      return {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "headers",
        target: "private",
      };
    case "params":
      return {
        code: "CP_DOWNGRADE_PUBLIC_REQUEST_API",
        requestApi: "params",
        target: "publicVariant",
      };
    case "searchParams":
      return {
        code: "CP_DOWNGRADE_PUBLIC_REQUEST_API",
        requestApi: "searchParams",
        target: "publicVariant",
      };
    default:
      return assertNever(kind);
  }
}

export function classifyRenderObservationDowngrade(
  input: ClassifyRenderObservationDowngradeInput,
): CacheProofDowngradeClassification {
  const reasons: CacheProofDowngradeReason[] = [];
  let target: CacheProofDowngradeTarget = "public";

  switch (input.cacheability) {
    case "public":
      break;
    case "private": {
      const reason = {
        code: "CP_DOWNGRADE_CACHEABILITY_PRIVATE",
        target: "private",
      } satisfies CacheProofDowngradeReason;
      reasons.push(reason);
      target = maxCacheProofDowngradeTarget(target, reason.target);
      break;
    }
    case "uncacheable": {
      const reason = {
        code: "CP_DOWNGRADE_CACHEABILITY_UNCACHEABLE",
        target: "privateUncacheable",
      } satisfies CacheProofDowngradeReason;
      reasons.push(reason);
      target = maxCacheProofDowngradeTarget(target, reason.target);
      break;
    }
    case "unknown": {
      const reason = {
        code: "CP_DOWNGRADE_CACHEABILITY_UNKNOWN",
        target: "freshRender",
      } satisfies CacheProofDowngradeReason;
      reasons.push(reason);
      target = maxCacheProofDowngradeTarget(target, reason.target);
      break;
    }
    default:
      assertNever(input.cacheability);
  }

  if (input.completeness !== "complete") {
    const reason = {
      code: "CP_DOWNGRADE_INCOMPLETE_OBSERVATION",
      completeness: input.completeness,
      target: "freshRender",
    } satisfies CacheProofDowngradeReason;
    reasons.push(reason);
    target = maxCacheProofDowngradeTarget(target, reason.target);
  }

  if (input.dynamicFetches.length > 0) {
    const reason = {
      code: "CP_DOWNGRADE_DYNAMIC_FETCH",
      dynamicFetchCount: input.dynamicFetches.length,
      target: "freshRender",
    } satisfies CacheProofDowngradeReason;
    reasons.push(reason);
    target = maxCacheProofDowngradeTarget(target, reason.target);
  }

  const requestApis = normalizeRequestApiObservations(input.requestApis);
  for (const requestApi of requestApis) {
    if (requestApi.status === "notObserved") continue;
    const reason =
      requestApi.status === "unknown"
        ? ({
            code: "CP_DOWNGRADE_UNKNOWN_REQUEST_API",
            requestApi: requestApi.kind,
            target: "freshRender",
          } satisfies CacheProofDowngradeReason)
        : classifyObservedRequestApiDowngrade(requestApi.kind);
    reasons.push(reason);
    target = maxCacheProofDowngradeTarget(target, reason.target);
  }

  return {
    target,
    reasons,
    fallback: createDowngradeFallback(target, reasons),
    isPublicCacheCandidate: target === "public" || target === "publicVariant",
  };
}

export function buildRenderRequestApiObservations(
  input: BuildRenderRequestApiObservationsInput,
): RenderRequestApiObservation[] {
  const observedKinds = new Set(input.observed);
  const absentStatus: RenderRequestApiStatus =
    input.completeness === "complete" ? "notObserved" : "unknown";

  return ALL_RENDER_REQUEST_API_KINDS.map((kind) => ({
    kind,
    status: observedKinds.has(kind) ? "observed" : absentStatus,
  }));
}

export function buildRenderObservation(input: BuildRenderObservationInput): RenderObservation {
  const requestApis = normalizeRequestApiObservations(input.requestApis);
  const dynamicFetches = sortedUniqueRedacted(input.dynamicFetches);

  return {
    schemaVersion: CACHE_PROOF_MODEL_SCHEMA_VERSION,
    output: input.output,
    completeness: input.completeness,
    boundaryOutcome: input.boundaryOutcome,
    requestApis,
    dynamicFetches,
    cacheTags: sortedUnique(input.cacheTags),
    pathTags: sortedUnique(input.pathTags),
    cacheability: input.cacheability,
    downgrade: classifyRenderObservationDowngrade({
      cacheability: input.cacheability,
      completeness: input.completeness,
      dynamicFetches,
      requestApis,
    }),
  };
}

export function hasCompleteNegativeRequestApiProof(
  observation: RenderObservation,
  requiredApis: readonly RenderRequestApiKind[],
): boolean {
  if (observation.completeness !== "complete") return false;

  const statuses = new Map<RenderRequestApiKind, RenderRequestApiStatus>();
  for (const requestApi of normalizeRequestApiObservations(observation.requestApis)) {
    statuses.set(requestApi.kind, requestApi.status);
  }

  for (const api of requiredApis) {
    if (statuses.get(api) !== "notObserved") return false;
  }
  return true;
}

/**
 * Whether a stored App page's render is proven not to have read the request's
 * query, so one entry may serve every query. Core only writes and reads
 * entries with this proof.
 */
export function hasQueryInvariantRenderProof(observation: RenderObservation | undefined): boolean {
  return (
    observation !== undefined && hasCompleteNegativeRequestApiProof(observation, ["searchParams"])
  );
}

export function createCacheEntryReuseProof(
  decision: StaticLayoutArtifactReuseDecision | null,
): CacheEntryReuseProof {
  if (decision === null) {
    return {
      kind: "runtime-cache-entry",
      decision: null,
    };
  }

  switch (decision.kind) {
    case "reuse":
      return {
        kind: "runtime-cache-entry",
        decision: {
          canReuse: true,
          code: decision.proof.code,
          kind: "reuse",
          reuseClass: decision.proof.reuseClass,
        },
      };
    case "fallback":
      return {
        kind: "runtime-cache-entry",
        decision: {
          canReuse: false,
          code: decision.fallback.code,
          kind: "reject",
          mode: decision.fallback.mode,
          scope: decision.fallback.scope,
        },
      };
    default:
      return assertNever(decision);
  }
}
