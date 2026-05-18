import type { AppRouteSemanticIds } from "../routing/app-route-graph.js";
import { fnv1a64 } from "../utils/hash.js";
import { findSortedStringPosition } from "../utils/sorted-array.js";

export const CACHE_PROOF_MODEL_SCHEMA_VERSION = 1;
export type CacheProofModelSchemaVersion = 1;

export type CacheProofRejectionCode =
  | "CP_MODEL_DISABLED"
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
  | "CP_STATIC_LAYOUT_PRIVATE_VARIANT_DIMENSION"
  | "CP_STATIC_LAYOUT_REQUEST_API_OBSERVED"
  | "CP_STATIC_LAYOUT_REQUEST_API_UNKNOWN"
  | "CP_STATIC_LAYOUT_ROOT_BOUNDARY_MISMATCH"
  | "CP_STATIC_LAYOUT_ROOT_BOUNDARY_UNKNOWN";

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

export const DEFAULT_CACHE_VARIANT_BUDGET = {
  maxDimensionCount: 8,
  maxDimensionNameLength: 64,
  maxDimensionValueLength: 256,
  maxEncodedLength: 1024,
  maxValuesPerDimension: 8,
  maxVariantsPerRoute: 64,
} satisfies CacheVariantBudget;

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

export type CacheVariantDimensionInput = Readonly<{
  name: string;
  privacy: CacheVariantDimensionPrivacy;
  source: CacheVariantDimensionSource;
  values: readonly string[];
}>;

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

export type BuildCacheVariantInput = Readonly<{
  budget: CacheVariantBudget;
  dimensions: readonly CacheVariantDimensionInput[];
  output: CacheProofOutputScope;
}>;

export type BuildCacheVariantResult =
  | Readonly<{ kind: "variant"; variant: CacheVariant }>
  | Readonly<{ kind: "breakerFallback"; fallback: CacheProofBreakerFallback }>;

export type CacheVariantRouteBudget = Readonly<{
  routeId: string;
  variantCacheKeys: readonly string[];
}>;

export type CacheVariantRouteBudgetAdmission =
  | Readonly<{
      didConsumeRouteVariantBudget: boolean;
      kind: "variant";
      routeBudget: CacheVariantRouteBudget;
      variant: CacheVariant;
    }>
  | Readonly<{
      fallback: CacheProofBreakerFallback;
      kind: "breakerFallback";
      routeBudget: CacheVariantRouteBudget | null;
    }>;

export type BuildCacheVariantWithRouteBudgetInput = BuildCacheVariantInput &
  Readonly<{
    routeBudget: CacheVariantRouteBudget | null;
  }>;

export type BuildCacheVariantWithRouteBudgetResult = CacheVariantRouteBudgetAdmission;

export type AppRouteCacheProofGraphScopeInput = Readonly<{
  ids: AppRouteSemanticIds;
}>;

export type AppRouteCacheProofGraphScope = Readonly<{
  layoutIds: readonly string[];
  pageId: string | null;
  routeHandlerId: string | null;
  routeId: string;
  slotIds: readonly string[];
  templateIds: readonly string[];
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

export type BoundaryOutcomeCompatibility =
  | Readonly<{
      kind: "compatible";
      outcome: BoundaryOutcome;
      reason: "CP_BOUNDARY_OUTCOME_MATCH";
    }>
  | Readonly<{
      candidate: BoundaryOutcome;
      expected: BoundaryOutcome;
      fallback: CacheProofBreakerFallback;
      kind: "incompatible";
    }>;

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

export type ClassifyCacheVariantDimensionDowngradeInput = Pick<
  CacheVariantDimensionInput,
  "source"
>;

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
  authorizesRuntimeReuse: false;
  candidateOutput: StaticLayoutCacheProofOutputScope;
  code: "CP_STATIC_LAYOUT_REUSE_PROVEN";
  currentOutput: StaticLayoutCacheProofOutputScope;
  fields: CacheProofTraceFields;
  observation: RenderObservation;
  requiredNegativeRequestApis: readonly RenderRequestApiKind[];
  reuseClass: "static-layout";
  variant: CacheVariant;
}>;

export type BuildStaticLayoutReuseProofInput = Readonly<{
  candidateObservation: RenderObservation;
  candidateVariant: CacheVariant;
  currentOutput: CacheProofOutputScope;
}>;

export type BuildStaticLayoutReuseProofResult =
  | Readonly<{ kind: "proof"; proof: StaticLayoutReuseProof }>
  | Readonly<{ kind: "rejected"; fallback: CacheProofBreakerFallback }>;

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

export type DisabledCacheProofDecision = Readonly<{
  canReuse: false;
  fallback: CacheProofBreakerFallback;
  kind: "disabled";
  observation: RenderObservation;
  staticLayoutProof?: StaticLayoutReuseProof;
  variant: CacheVariant;
}>;

export type CreateDisabledCacheProofDecisionInput = Readonly<{
  observation: RenderObservation;
  staticLayoutProof?: StaticLayoutReuseProof;
  variant: CacheVariant;
}>;

const PUBLIC_UNSAFE_DIMENSION_SOURCES: ReadonlySet<CacheVariantDimensionSource> = new Set([
  "auth",
  "cookie",
  "draft-mode",
  "header",
  "session",
]);

type CacheVariantDimensionAccumulator = {
  name: string;
  privacy: CacheVariantDimensionPrivacy;
  source: CacheVariantDimensionSource;
  values: string[];
};

type DimensionAccumulatorByName = Map<string, CacheVariantDimensionAccumulator>;
type DimensionAccumulatorByPrivacy = Map<CacheVariantDimensionPrivacy, DimensionAccumulatorByName>;
type DimensionAccumulatorBySource = Map<CacheVariantDimensionSource, DimensionAccumulatorByPrivacy>;

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

function normalizeDimensionName(name: string): string {
  return name.trim().toLowerCase();
}

function redactValue(value: string): string {
  return `h:${fnv1a64(value)}`;
}

function sortedUniqueRedacted(values: readonly string[]): string[] {
  return sortedUnique(sortedUnique(values).map(redactValue));
}

function encodeParts(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

function compareDimensions(a: CacheVariantDimension, b: CacheVariantDimension): number {
  return (
    a.source.localeCompare(b.source) ||
    a.name.localeCompare(b.name) ||
    a.privacy.localeCompare(b.privacy)
  );
}

function encodeNullable(value: string | null): string | null {
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled cache proof variant: ${String(value)}`);
}

function encodeOutputScope(output: CacheProofOutputScope): string {
  switch (output.kind) {
    case "app-html":
      return encodeParts([
        output.kind,
        output.routeId,
        encodeNullable(output.rootBoundaryId),
        encodeNullable(output.renderEpoch),
      ]);
    case "app-rsc":
      return encodeParts([
        output.kind,
        output.routeId,
        encodeNullable(output.rootBoundaryId),
        encodeNullable(output.renderEpoch),
        encodeNullable(output.mountedSlotsFingerprint),
      ]);
    case "layout":
      return encodeParts([
        output.kind,
        output.routeId,
        output.layoutId,
        encodeNullable(output.rootBoundaryId),
      ]);
    case "page":
      return encodeParts([
        output.kind,
        output.routeId,
        output.pageId,
        encodeNullable(output.rootBoundaryId),
      ]);
    case "route-handler":
      return encodeParts([output.kind, output.routeId, output.routeHandlerId]);
    case "slot":
      return encodeParts([
        output.kind,
        output.routeId,
        output.slotId,
        encodeNullable(output.rootBoundaryId),
      ]);
    case "template":
      return encodeParts([
        output.kind,
        output.routeId,
        output.templateId,
        encodeNullable(output.rootBoundaryId),
      ]);
    default:
      return assertNever(output);
  }
}

function validateBudgetNumber(name: string, value: number): CacheProofBreakerFallback | null {
  if (Number.isInteger(value) && value >= 0) return null;
  return buildBreakerFallback("CP_INVALID_VARIANT_BUDGET", {
    budgetField: name,
  });
}

function validateBudget(budget: CacheVariantBudget): CacheProofBreakerFallback | null {
  return (
    validateBudgetNumber("maxDimensionCount", budget.maxDimensionCount) ??
    validateBudgetNumber("maxDimensionNameLength", budget.maxDimensionNameLength) ??
    validateBudgetNumber("maxDimensionValueLength", budget.maxDimensionValueLength) ??
    validateBudgetNumber("maxEncodedLength", budget.maxEncodedLength) ??
    validateBudgetNumber("maxValuesPerDimension", budget.maxValuesPerDimension) ??
    validateBudgetNumber("maxVariantsPerRoute", budget.maxVariantsPerRoute)
  );
}

function buildDimension(
  input: CacheVariantDimensionInput,
  budget: CacheVariantBudget,
): CacheVariantDimension | CacheProofBreakerFallback {
  const name = normalizeDimensionName(input.name);
  if (name.length === 0) {
    return buildBreakerFallback("CP_DIMENSION_NAME_MISSING", {
      source: input.source,
    });
  }
  if (name.length > budget.maxDimensionNameLength) {
    return buildBreakerFallback("CP_DIMENSION_NAME_TOO_LONG", {
      maxLength: budget.maxDimensionNameLength,
      nameHash: redactValue(name),
      source: input.source,
    });
  }
  if (input.privacy === "public" && PUBLIC_UNSAFE_DIMENSION_SOURCES.has(input.source)) {
    return buildBreakerFallback(
      "CP_UNSAFE_PUBLIC_DIMENSION",
      {
        name,
        source: input.source,
      },
      "privateUncacheable",
    );
  }

  const values = sortedUnique(input.values);
  if (values.length === 0) {
    return buildBreakerFallback("CP_DIMENSION_VALUES_MISSING", {
      name,
      source: input.source,
    });
  }
  if (values.length > budget.maxValuesPerDimension) {
    return buildBreakerFallback("CP_DIMENSION_VALUE_COUNT_EXCEEDED", {
      maxValues: budget.maxValuesPerDimension,
      name,
      source: input.source,
      valueCount: values.length,
    });
  }
  for (const value of values) {
    if (value.length > budget.maxDimensionValueLength) {
      return buildBreakerFallback("CP_DIMENSION_VALUE_TOO_LONG", {
        maxLength: budget.maxDimensionValueLength,
        name,
        source: input.source,
        valueHash: redactValue(value),
      });
    }
  }

  const valueHashes = values.map(redactValue);
  const encoded = encodeParts([input.source, input.privacy, name, valueHashes]);

  return {
    encoded,
    name,
    privacy: input.privacy,
    source: input.source,
    valueCount: valueHashes.length,
    valueHashes,
  };
}

function isCacheProofBreakerFallback(
  value: CacheVariantDimension | CacheProofBreakerFallback,
): value is CacheProofBreakerFallback {
  return "code" in value;
}

function getDimensionBucket(
  bySource: DimensionAccumulatorBySource,
  source: CacheVariantDimensionSource,
  privacy: CacheVariantDimensionPrivacy,
): DimensionAccumulatorByName {
  const existingByPrivacy = bySource.get(source);
  const byPrivacy = existingByPrivacy ?? new Map();
  if (!existingByPrivacy) {
    bySource.set(source, byPrivacy);
  }

  const existingByName = byPrivacy.get(privacy);
  const byName = existingByName ?? new Map();
  if (!existingByName) {
    byPrivacy.set(privacy, byName);
  }

  return byName;
}

function mergeDimensionInputs(
  dimensions: readonly CacheVariantDimensionInput[],
): CacheVariantDimensionInput[] {
  const bySource: DimensionAccumulatorBySource = new Map();
  const orderedDimensions: CacheVariantDimensionAccumulator[] = [];

  for (const dimension of dimensions) {
    const name = normalizeDimensionName(dimension.name);
    const bucket = getDimensionBucket(bySource, dimension.source, dimension.privacy);
    const existing = bucket.get(name);
    if (existing) {
      existing.values.push(...dimension.values);
      continue;
    }
    const accumulator = {
      name,
      privacy: dimension.privacy,
      source: dimension.source,
      values: [...dimension.values],
    };
    bucket.set(name, accumulator);
    orderedDimensions.push(accumulator);
  }

  return orderedDimensions;
}

export function createAppRouteCacheProofGraphScope(
  route: AppRouteCacheProofGraphScopeInput,
): AppRouteCacheProofGraphScope {
  return {
    routeId: route.ids.route,
    pageId: route.ids.page,
    routeHandlerId: route.ids.routeHandler,
    layoutIds: [...route.ids.layouts],
    templateIds: [...route.ids.templates],
    slotIds: sortedUnique(Object.values(route.ids.slots)),
  };
}

export function buildCacheVariant(input: BuildCacheVariantInput): BuildCacheVariantResult {
  const budgetFallback = validateBudget(input.budget);
  if (budgetFallback) {
    return {
      kind: "breakerFallback",
      fallback: budgetFallback,
    };
  }
  const dimensionInputs = mergeDimensionInputs(input.dimensions);
  if (dimensionInputs.length > input.budget.maxDimensionCount) {
    return {
      kind: "breakerFallback",
      fallback: buildBreakerFallback("CP_DIMENSION_COUNT_EXCEEDED", {
        dimensionCount: dimensionInputs.length,
        maxDimensionCount: input.budget.maxDimensionCount,
        routeId: input.output.routeId,
      }),
    };
  }

  const dimensions: CacheVariantDimension[] = [];
  for (const dimensionInput of dimensionInputs) {
    const dimension = buildDimension(dimensionInput, input.budget);
    if (isCacheProofBreakerFallback(dimension)) {
      return {
        kind: "breakerFallback",
        fallback: dimension,
      };
    }
    dimensions.push(dimension);
  }
  dimensions.sort(compareDimensions);

  const encoded = [
    `schema:${CACHE_PROOF_MODEL_SCHEMA_VERSION}`,
    encodeOutputScope(input.output),
    ...dimensions.map((dimension) => dimension.encoded),
  ].join("|");

  if (encoded.length > input.budget.maxEncodedLength) {
    return {
      kind: "breakerFallback",
      fallback: buildBreakerFallback("CP_ENCODED_VARIANT_TOO_LONG", {
        encodedHash: redactValue(encoded),
        encodedLength: encoded.length,
        maxEncodedLength: input.budget.maxEncodedLength,
        routeId: input.output.routeId,
      }),
    };
  }

  return {
    kind: "variant",
    variant: {
      schemaVersion: CACHE_PROOF_MODEL_SCHEMA_VERSION,
      cacheKey: `cp${CACHE_PROOF_MODEL_SCHEMA_VERSION}:${fnv1a64(encoded)}`,
      output: input.output,
      dimensions,
      encodedLength: encoded.length,
      budget: { ...input.budget },
    },
  };
}

function normalizeRouteBudget(input: CacheVariantRouteBudget): CacheVariantRouteBudget {
  return {
    routeId: input.routeId,
    variantCacheKeys: sortedUnique(input.variantCacheKeys),
  };
}

function buildRouteVariantCeilingFallback(
  variant: CacheVariant,
  existingVariantCount: number,
): CacheProofBreakerFallback {
  return buildBreakerFallback(
    "CP_ROUTE_VARIANT_CEILING_EXCEEDED",
    {
      existingVariantCount,
      maxVariantsPerRoute: variant.budget.maxVariantsPerRoute,
      routeId: variant.output.routeId,
    },
    "privateUncacheable",
    "route",
  );
}

export function enforceCacheVariantRouteBudget(input: {
  routeBudget: CacheVariantRouteBudget | null;
  variant: CacheVariant;
}): CacheVariantRouteBudgetAdmission {
  if (input.routeBudget && input.routeBudget.routeId !== input.variant.output.routeId) {
    return {
      kind: "breakerFallback",
      routeBudget: normalizeRouteBudget(input.routeBudget),
      fallback: buildBreakerFallback(
        "CP_ROUTE_VARIANT_BUDGET_ROUTE_MISMATCH",
        {
          budgetRouteId: input.routeBudget.routeId,
          routeId: input.variant.output.routeId,
        },
        "privateUncacheable",
        "route",
      ),
    };
  }

  const routeBudget = normalizeRouteBudget(
    input.routeBudget ?? {
      routeId: input.variant.output.routeId,
      variantCacheKeys: [],
    },
  );
  const existingVariantCount = routeBudget.variantCacheKeys.length;
  const variantKeyPosition = findSortedStringPosition(
    routeBudget.variantCacheKeys,
    input.variant.cacheKey,
  );

  if (existingVariantCount > input.variant.budget.maxVariantsPerRoute) {
    return {
      kind: "breakerFallback",
      routeBudget,
      fallback: buildRouteVariantCeilingFallback(input.variant, existingVariantCount),
    };
  }

  if (variantKeyPosition.found) {
    return {
      kind: "variant",
      variant: input.variant,
      routeBudget,
      didConsumeRouteVariantBudget: false,
    };
  }

  if (existingVariantCount >= input.variant.budget.maxVariantsPerRoute) {
    return {
      kind: "breakerFallback",
      routeBudget,
      fallback: buildRouteVariantCeilingFallback(input.variant, existingVariantCount),
    };
  }

  return {
    kind: "variant",
    variant: input.variant,
    routeBudget: {
      routeId: routeBudget.routeId,
      variantCacheKeys: [
        ...routeBudget.variantCacheKeys.slice(0, variantKeyPosition.index),
        input.variant.cacheKey,
        ...routeBudget.variantCacheKeys.slice(variantKeyPosition.index),
      ],
    },
    didConsumeRouteVariantBudget: true,
  };
}

export function buildCacheVariantWithRouteBudget(
  input: BuildCacheVariantWithRouteBudgetInput,
): BuildCacheVariantWithRouteBudgetResult {
  const variantResult = buildCacheVariant({
    budget: input.budget,
    dimensions: input.dimensions,
    output: input.output,
  });

  if (variantResult.kind === "breakerFallback") {
    return {
      kind: "breakerFallback",
      routeBudget: input.routeBudget ? normalizeRouteBudget(input.routeBudget) : null,
      fallback: variantResult.fallback,
    };
  }

  return enforceCacheVariantRouteBudget({
    routeBudget: input.routeBudget,
    variant: variantResult.variant,
  });
}

function boundaryOutcomesMatch(expected: BoundaryOutcome, candidate: BoundaryOutcome): boolean {
  switch (expected.kind) {
    case "error":
      return candidate.kind === "error" && (expected.digest ?? "") === (candidate.digest ?? "");
    case "forbidden":
      return candidate.kind === "forbidden";
    case "globalError":
      return (
        candidate.kind === "globalError" && (expected.digest ?? "") === (candidate.digest ?? "")
      );
    case "notFound":
      return candidate.kind === "notFound";
    case "redirect":
      return (
        candidate.kind === "redirect" &&
        expected.status === candidate.status &&
        expected.location === candidate.location
      );
    case "success":
      return candidate.kind === "success";
    case "unauthorized":
      return candidate.kind === "unauthorized";
    case "unknown":
      return false;
    default:
      return assertNever(expected);
  }
}

export function buildBoundaryOutcomeCompatibility(input: {
  candidate: BoundaryOutcome;
  expected: BoundaryOutcome;
}): BoundaryOutcomeCompatibility {
  if (input.expected.kind === "unknown" || input.candidate.kind === "unknown") {
    return {
      kind: "incompatible",
      expected: input.expected,
      candidate: input.candidate,
      fallback: buildBreakerFallback("CP_BOUNDARY_OUTCOME_UNKNOWN", {
        candidateKind: input.candidate.kind,
        expectedKind: input.expected.kind,
      }),
    };
  }

  if (boundaryOutcomesMatch(input.expected, input.candidate)) {
    return {
      kind: "compatible",
      outcome: input.candidate,
      reason: "CP_BOUNDARY_OUTCOME_MATCH",
    };
  }

  return {
    kind: "incompatible",
    expected: input.expected,
    candidate: input.candidate,
    fallback: buildBreakerFallback("CP_BOUNDARY_OUTCOME_MISMATCH", {
      candidateKind: input.candidate.kind,
      expectedKind: input.expected.kind,
    }),
  };
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

export function classifyCacheVariantDimensionDowngrade(
  input: ClassifyCacheVariantDimensionDowngradeInput,
): CacheProofDowngradeReason | null {
  switch (input.source) {
    case "auth":
      return {
        code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
        inputClass: "auth",
        source: "auth",
        target: "private",
      };
    case "cookie":
      return {
        code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
        inputClass: "private",
        source: "cookie",
        target: "private",
      };
    case "draft-mode":
      return {
        code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
        inputClass: "draft",
        source: "draft-mode",
        target: "privateUncacheable",
      };
    case "header":
      return {
        code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
        inputClass: "private",
        source: "header",
        target: "private",
      };
    case "session":
      return {
        code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
        inputClass: "session",
        source: "session",
        target: "private",
      };
    case "custom":
    case "interception":
    case "mounted-slots":
    case "params":
    case "route":
    case "search":
      return null;
    default:
      return assertNever(input.source);
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

function isStaticLayoutOutputScope(
  output: CacheProofOutputScope,
): output is StaticLayoutCacheProofOutputScope {
  return output.kind === "layout";
}

function rejectStaticLayoutReuseProof(
  code: CacheProofRejectionCode,
  fields: CacheProofTraceFields,
  mode: CacheProofBreakerFallbackMode = "renderFresh",
): BuildStaticLayoutReuseProofResult {
  return {
    kind: "rejected",
    fallback: buildBreakerFallback(code, fields, mode),
  };
}

function getRequestApiStatus(
  observations: readonly RenderRequestApiObservation[],
  kind: RenderRequestApiKind,
): RenderRequestApiStatus | "missing" {
  let status: RenderRequestApiStatus | null = null;

  for (const requestApi of observations) {
    if (requestApi.kind !== kind) continue;
    if (status === null || requestApiStatusRank(requestApi.status) > requestApiStatusRank(status)) {
      status = requestApi.status;
    }
  }

  return status ?? "missing";
}

function createStaticLayoutDowngradeFallback(
  downgrade: CacheProofDowngradeClassification,
): CacheProofBreakerFallback {
  const mode: CacheProofBreakerFallbackMode =
    downgrade.target === "privateUncacheable" ? "privateUncacheable" : "renderFresh";
  return buildBreakerFallback(
    "CP_STATIC_LAYOUT_PRIVATE_DYNAMIC_DOWNGRADE",
    {
      reasonCodes: downgrade.reasons.map((reason) => reason.code),
      target: downgrade.target,
    },
    mode,
  );
}

function createPrivateVariantDimensionFallback(
  dimension: CacheVariantDimension,
): CacheProofBreakerFallback | null {
  const downgrade = classifyCacheVariantDimensionDowngrade({ source: dimension.source });
  if (!downgrade && dimension.privacy !== "private") {
    return null;
  }

  const target = downgrade?.target ?? "private";
  const mode: CacheProofBreakerFallbackMode =
    target === "privateUncacheable" ? "privateUncacheable" : "renderFresh";
  return buildBreakerFallback(
    "CP_STATIC_LAYOUT_PRIVATE_VARIANT_DIMENSION",
    {
      dimension: dimension.name,
      privacy: dimension.privacy,
      reasonCode: downgrade?.code ?? null,
      source: dimension.source,
      target,
    },
    mode,
  );
}

function outputFieldMismatch(
  candidate: StaticLayoutCacheProofOutputScope,
  observation: StaticLayoutCacheProofOutputScope,
): "layoutId" | "rootBoundaryId" | "routeId" | null {
  if (candidate.layoutId !== observation.layoutId) return "layoutId";
  if (candidate.rootBoundaryId !== observation.rootBoundaryId) return "rootBoundaryId";
  if (candidate.routeId !== observation.routeId) return "routeId";
  return null;
}

export function buildStaticLayoutReuseProof(
  input: BuildStaticLayoutReuseProofInput,
): BuildStaticLayoutReuseProofResult {
  if (!isStaticLayoutOutputScope(input.currentOutput)) {
    return rejectStaticLayoutReuseProof("CP_STATIC_LAYOUT_CURRENT_OUTPUT_KIND", {
      currentOutputKind: input.currentOutput.kind,
    });
  }

  if (!isStaticLayoutOutputScope(input.candidateVariant.output)) {
    return rejectStaticLayoutReuseProof("CP_STATIC_LAYOUT_CANDIDATE_OUTPUT_KIND", {
      candidateOutputKind: input.candidateVariant.output.kind,
    });
  }

  if (!isStaticLayoutOutputScope(input.candidateObservation.output)) {
    return rejectStaticLayoutReuseProof("CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_KIND", {
      observationOutputKind: input.candidateObservation.output.kind,
    });
  }

  const currentOutput = input.currentOutput;
  const candidateOutput = input.candidateVariant.output;
  const observationOutput = input.candidateObservation.output;
  const requestApis = normalizeRequestApiObservations(input.candidateObservation.requestApis);
  const candidateObservation = {
    ...input.candidateObservation,
    requestApis,
    downgrade: classifyRenderObservationDowngrade({
      cacheability: input.candidateObservation.cacheability,
      completeness: input.candidateObservation.completeness,
      dynamicFetches: input.candidateObservation.dynamicFetches,
      requestApis,
    }),
  } satisfies RenderObservation;
  const observedOutputMismatch = outputFieldMismatch(candidateOutput, observationOutput);
  if (observedOutputMismatch) {
    return rejectStaticLayoutReuseProof("CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_MISMATCH", {
      candidateLayoutId: candidateOutput.layoutId,
      candidateRootBoundaryId: candidateOutput.rootBoundaryId,
      candidateRouteId: candidateOutput.routeId,
      field: observedOutputMismatch,
      observationLayoutId: observationOutput.layoutId,
      observationRootBoundaryId: observationOutput.rootBoundaryId,
      observationRouteId: observationOutput.routeId,
    });
  }

  if (currentOutput.layoutId !== candidateOutput.layoutId) {
    return rejectStaticLayoutReuseProof("CP_STATIC_LAYOUT_ID_MISMATCH", {
      candidateLayoutId: candidateOutput.layoutId,
      currentLayoutId: currentOutput.layoutId,
    });
  }

  if (currentOutput.rootBoundaryId === null || candidateOutput.rootBoundaryId === null) {
    return rejectStaticLayoutReuseProof("CP_STATIC_LAYOUT_ROOT_BOUNDARY_UNKNOWN", {
      candidateRootBoundaryId: candidateOutput.rootBoundaryId,
      currentRootBoundaryId: currentOutput.rootBoundaryId,
    });
  }

  if (currentOutput.rootBoundaryId !== candidateOutput.rootBoundaryId) {
    return rejectStaticLayoutReuseProof("CP_STATIC_LAYOUT_ROOT_BOUNDARY_MISMATCH", {
      candidateRootBoundaryId: candidateOutput.rootBoundaryId,
      currentRootBoundaryId: currentOutput.rootBoundaryId,
    });
  }

  const boundaryCompatibility = buildBoundaryOutcomeCompatibility({
    candidate: candidateObservation.boundaryOutcome,
    expected: { kind: "success" },
  });
  if (boundaryCompatibility.kind === "incompatible") {
    return {
      kind: "rejected",
      fallback: boundaryCompatibility.fallback,
    };
  }

  for (const dimension of input.candidateVariant.dimensions) {
    const fallback = createPrivateVariantDimensionFallback(dimension);
    if (fallback) {
      return {
        kind: "rejected",
        fallback,
      };
    }
  }

  if (!candidateObservation.downgrade.isPublicCacheCandidate) {
    return {
      kind: "rejected",
      fallback: createStaticLayoutDowngradeFallback(candidateObservation.downgrade),
    };
  }

  // The loop can use the shared readonly registry; the proof stores a detached evidence copy.
  const requiredNegativeRequestApis = ALL_RENDER_REQUEST_API_KINDS;
  for (const api of requiredNegativeRequestApis) {
    const status = getRequestApiStatus(candidateObservation.requestApis, api);
    if (status === "notObserved") continue;

    return rejectStaticLayoutReuseProof(
      status === "missing"
        ? "CP_STATIC_LAYOUT_REQUEST_API_UNKNOWN"
        : "CP_STATIC_LAYOUT_REQUEST_API_OBSERVED",
      {
        requestApi: api,
        status,
      },
    );
  }

  return {
    kind: "proof",
    proof: {
      authorizesRuntimeReuse: false,
      candidateOutput,
      code: "CP_STATIC_LAYOUT_REUSE_PROVEN",
      currentOutput,
      fields: {
        candidateRouteId: candidateOutput.routeId,
        currentRouteId: currentOutput.routeId,
        layoutId: currentOutput.layoutId,
        rootBoundaryId: currentOutput.rootBoundaryId,
      },
      observation: candidateObservation,
      requiredNegativeRequestApis: [...requiredNegativeRequestApis],
      reuseClass: "static-layout",
      variant: input.candidateVariant,
    },
  };
}

export function createDisabledCacheProofDecision(
  input: CreateDisabledCacheProofDecisionInput,
): DisabledCacheProofDecision {
  return {
    kind: "disabled",
    canReuse: false,
    variant: input.variant,
    observation: input.observation,
    ...(input.staticLayoutProof ? { staticLayoutProof: input.staticLayoutProof } : {}),
    fallback: buildBreakerFallback("CP_MODEL_DISABLED"),
  };
}
