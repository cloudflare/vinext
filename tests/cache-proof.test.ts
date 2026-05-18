import { describe, expect, it } from "vite-plus/test";
import {
  buildBoundaryOutcomeCompatibility,
  buildCacheVariant,
  buildCacheVariantWithRouteBudget,
  buildRenderObservation,
  buildRenderRequestApiObservations,
  buildStaticLayoutReuseProof,
  CACHE_PROOF_MODEL_SCHEMA_VERSION,
  classifyCacheVariantDimensionDowngrade,
  classifyRenderObservationDowngrade,
  createAppRouteCacheProofGraphScope,
  createDisabledCacheProofDecision,
  DEFAULT_CACHE_VARIANT_BUDGET,
  hasCompleteNegativeRequestApiProof,
  type AppRouteCacheProofGraphScopeInput,
  type BoundaryOutcome,
  type CacheProofBreakerFallback,
  type CacheProofOutputScope,
  type CacheProofRejectionCode,
  type CacheVariant,
  type CacheVariantDimensionInput,
  type RenderCacheability,
  type RenderObservation,
  type RenderObservationCompleteness,
  type RenderRequestApiObservation,
} from "../packages/vinext/src/server/cache-proof.js";

type CacheVariantBuildResultForTest =
  | ReturnType<typeof buildCacheVariant>
  | ReturnType<typeof buildCacheVariantWithRouteBudget>;

function expectBreakerReason(
  result: CacheVariantBuildResultForTest,
  code: CacheProofBreakerFallback["code"],
): CacheProofBreakerFallback {
  expect(result.kind).toBe("breakerFallback");
  if (result.kind !== "breakerFallback") {
    throw new Error("Expected cache variant construction to return a breaker fallback");
  }
  expect(result.fallback.code).toBe(code);
  return result.fallback;
}

type LayoutOutputScope = Extract<CacheProofOutputScope, { kind: "layout" }>;

function createLayoutOutput(
  options: {
    layoutId?: string;
    rootBoundaryId?: string | null;
    routeId?: string;
  } = {},
): LayoutOutputScope {
  const rootBoundaryId =
    "rootBoundaryId" in options && options.rootBoundaryId !== undefined
      ? options.rootBoundaryId
      : "layout:/";

  return {
    kind: "layout",
    layoutId: options.layoutId ?? "layout:/dashboard",
    rootBoundaryId,
    routeId: options.routeId ?? "route:/dashboard/settings",
  };
}

function buildLayoutVariant(options: {
  dimensions?: readonly CacheVariantDimensionInput[];
  output: LayoutOutputScope;
}): CacheVariant {
  const result = buildCacheVariant({
    budget: DEFAULT_CACHE_VARIANT_BUDGET,
    dimensions: options.dimensions ?? [],
    output: options.output,
  });
  expect(result.kind).toBe("variant");
  if (result.kind !== "variant") {
    throw new Error("Expected cache variant construction to succeed");
  }
  return result.variant;
}

function buildLayoutObservation(options: {
  boundaryOutcome?: BoundaryOutcome;
  cacheability?: RenderCacheability;
  completeness?: RenderObservationCompleteness;
  dynamicFetches?: readonly string[];
  output: LayoutOutputScope;
  requestApis?: readonly RenderRequestApiObservation[];
}): RenderObservation {
  return buildRenderObservation({
    boundaryOutcome: options.boundaryOutcome ?? { kind: "success" },
    cacheability: options.cacheability ?? "public",
    cacheTags: ["dashboard"],
    completeness: options.completeness ?? "complete",
    dynamicFetches: options.dynamicFetches ?? [],
    output: options.output,
    pathTags: ["/dashboard"],
    requestApis:
      options.requestApis ??
      buildRenderRequestApiObservations({
        completeness: options.completeness ?? "complete",
        observed: [],
      }),
  });
}

function expectStaticLayoutProofRejection(
  result: ReturnType<typeof buildStaticLayoutReuseProof>,
  code: CacheProofRejectionCode,
): CacheProofBreakerFallback {
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") {
    throw new Error("Expected static layout proof to be rejected");
  }
  expect(result.fallback.code).toBe(code);
  return result.fallback;
}

describe("disabled cache proof model", () => {
  it("normalizes route graph semantic ids for cache proof scopes", () => {
    const route = {
      ids: {
        route: "route:/shop/:id",
        page: "page:/shop/:id",
        routeHandler: null,
        rootBoundary: "root-boundary:/",
        layouts: ["layout:/", "layout:/shop/[id]"],
        templates: [],
        slots: {
          "zebra@shop/[id]/@zebra": "slot:zebra:/shop/[id]",
          "modal@shop/[id]/@modal": "slot:modal:/shop/[id]",
          "modal-copy@shop/[id]/@modal": "slot:modal:/shop/[id]",
        },
      },
    } satisfies AppRouteCacheProofGraphScopeInput;

    const scope = createAppRouteCacheProofGraphScope(route);

    expect(scope).toEqual({
      routeId: "route:/shop/:id",
      pageId: "page:/shop/:id",
      routeHandlerId: null,
      layoutIds: ["layout:/", "layout:/shop/[id]"],
      templateIds: [],
      slotIds: ["slot:modal:/shop/[id]", "slot:zebra:/shop/[id]"],
    });
  });

  it("canonicalizes dimensions while keeping cache keys and traces redacted", () => {
    const first = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [
        {
          name: "sort",
          privacy: "public",
          source: "search",
          values: ["desc"],
        },
        {
          name: "SORT",
          privacy: "public",
          source: "search",
          values: ["asc", "asc"],
        },
        {
          name: "id",
          privacy: "public",
          source: "params",
          values: ["super-secret-token"],
        },
      ],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: "slots:main",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/shop/:id",
      },
    });
    const second = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [
        {
          name: "id",
          privacy: "public",
          source: "params",
          values: ["super-secret-token"],
        },
        {
          name: "sort",
          privacy: "public",
          source: "search",
          values: ["asc", "desc"],
        },
      ],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: "slots:main",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/shop/:id",
      },
    });

    expect(first.kind).toBe("variant");
    expect(second.kind).toBe("variant");
    if (first.kind !== "variant" || second.kind !== "variant") {
      throw new Error("Expected both inputs to produce cache variants");
    }

    expect(first.variant.cacheKey).toBe(second.variant.cacheKey);
    expect(first.variant.cacheKey.startsWith(`cp${CACHE_PROOF_MODEL_SCHEMA_VERSION}:`)).toBe(true);
    expect(first.variant.schemaVersion).toBe(CACHE_PROOF_MODEL_SCHEMA_VERSION);
    expect(first.variant.dimensions.map((dimension) => dimension.name)).toEqual(["id", "sort"]);
    expect(first.variant.dimensions[0].valueHashes).toHaveLength(1);
    expect(first.variant.dimensions[1].valueHashes).toHaveLength(2);

    const serializedVariant = JSON.stringify(first.variant);
    expect(serializedVariant).not.toContain("super-secret-token");
    expect(serializedVariant).not.toContain("desc");
    expect(serializedVariant).not.toContain("asc");
  });

  it("keeps null and empty-string output scope dimensions distinct", () => {
    const absentEpoch = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      output: {
        kind: "app-html",
        renderEpoch: null,
        rootBoundaryId: null,
        routeId: "route:/",
      },
    });
    const emptyEpoch = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      output: {
        kind: "app-html",
        renderEpoch: "",
        rootBoundaryId: "",
        routeId: "route:/",
      },
    });

    expect(absentEpoch.kind).toBe("variant");
    expect(emptyEpoch.kind).toBe("variant");
    if (absentEpoch.kind !== "variant" || emptyEpoch.kind !== "variant") {
      throw new Error("Expected both output scopes to produce cache variants");
    }

    expect(absentEpoch.variant.cacheKey).not.toBe(emptyEpoch.variant.cacheKey);
  });

  it("returns breaker fallbacks for unsafe or over-budget variants", () => {
    const unsafePublicCookie = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [
        {
          name: "session",
          privacy: "public",
          source: "cookie",
          values: ["abc"],
        },
      ],
      output: {
        kind: "layout",
        layoutId: "layout:/account",
        rootBoundaryId: "layout:/",
        routeId: "route:/account",
      },
    });

    const fallback = expectBreakerReason(unsafePublicCookie, "CP_UNSAFE_PUBLIC_DIMENSION");
    expect(JSON.stringify(fallback.fields)).not.toContain("abc");

    expectBreakerReason(
      buildCacheVariant({
        budget: {
          ...DEFAULT_CACHE_VARIANT_BUDGET,
          maxDimensionValueLength: 4,
        },
        dimensions: [
          {
            name: "tenant",
            privacy: "public",
            source: "params",
            values: ["customer-a"],
          },
        ],
        output: {
          kind: "layout",
          layoutId: "layout:/[tenant]",
          rootBoundaryId: "layout:/",
          routeId: "route:/:tenant",
        },
      }),
      "CP_DIMENSION_VALUE_TOO_LONG",
    );

    const invalidBudget = buildCacheVariant({
      budget: {
        ...DEFAULT_CACHE_VARIANT_BUDGET,
        maxEncodedLength: -1,
      },
      dimensions: [],
      output: {
        kind: "layout",
        layoutId: "layout:/[tenant]",
        rootBoundaryId: "layout:/",
        routeId: "route:/:tenant",
      },
    });
    expect(invalidBudget.kind).toBe("breakerFallback");
    if (invalidBudget.kind !== "breakerFallback") {
      throw new Error("Expected invalid cache variant budget to return a breaker fallback");
    }
    expect(invalidBudget.fallback).toMatchObject({
      code: "CP_INVALID_VARIANT_BUDGET",
      fields: { budgetField: "maxEncodedLength" },
    });
  });

  it("enforces per-route variant cardinality without charging duplicate variants", () => {
    const budget = {
      ...DEFAULT_CACHE_VARIANT_BUDGET,
      maxVariantsPerRoute: 2,
    };
    const output = {
      kind: "layout",
      layoutId: "layout:/[tenant]",
      rootBoundaryId: "layout:/",
      routeId: "route:/:tenant",
    } satisfies CacheProofOutputScope;

    const first = buildCacheVariantWithRouteBudget({
      budget,
      dimensions: [
        {
          name: "tenant",
          privacy: "public",
          source: "params",
          values: ["alpha"],
        },
      ],
      routeBudget: null,
      output,
    });
    expect(first.kind).toBe("variant");
    if (first.kind !== "variant") {
      throw new Error("Expected first route variant to be admitted");
    }
    expect(first.routeBudget.variantCacheKeys).toHaveLength(1);
    expect(first.didConsumeRouteVariantBudget).toBe(true);

    const duplicate = buildCacheVariantWithRouteBudget({
      budget,
      dimensions: [
        {
          name: "tenant",
          privacy: "public",
          source: "params",
          values: ["alpha"],
        },
      ],
      routeBudget: first.routeBudget,
      output,
    });
    expect(duplicate.kind).toBe("variant");
    if (duplicate.kind !== "variant") {
      throw new Error("Expected duplicate route variant to be admitted");
    }
    expect(duplicate.routeBudget.variantCacheKeys).toEqual(first.routeBudget.variantCacheKeys);
    expect(duplicate.didConsumeRouteVariantBudget).toBe(false);

    const second = buildCacheVariantWithRouteBudget({
      budget,
      dimensions: [
        {
          name: "tenant",
          privacy: "public",
          source: "params",
          values: ["bravo"],
        },
      ],
      routeBudget: duplicate.routeBudget,
      output,
    });
    expect(second.kind).toBe("variant");
    if (second.kind !== "variant") {
      throw new Error("Expected second route variant to be admitted");
    }
    expect(second.routeBudget.variantCacheKeys).toHaveLength(2);
    expect(second.routeBudget.variantCacheKeys).toEqual(
      [...second.routeBudget.variantCacheKeys].sort(),
    );
    expect(second.didConsumeRouteVariantBudget).toBe(true);

    const overBudget = buildCacheVariantWithRouteBudget({
      budget,
      dimensions: [
        {
          name: "tenant",
          privacy: "public",
          source: "params",
          values: ["charlie"],
        },
      ],
      routeBudget: second.routeBudget,
      output,
    });
    const fallback = expectBreakerReason(overBudget, "CP_ROUTE_VARIANT_CEILING_EXCEEDED");
    expect(fallback).toMatchObject({
      mode: "privateUncacheable",
      scope: "route",
      fields: {
        existingVariantCount: 2,
        maxVariantsPerRoute: 2,
        routeId: "route:/:tenant",
      },
    });
    expect(JSON.stringify(fallback.fields)).not.toContain("charlie");
  });

  it("rejects route variant budgets owned by a different route", () => {
    const output = {
      kind: "layout",
      layoutId: "layout:/[tenant]",
      rootBoundaryId: "layout:/",
      routeId: "route:/:tenant",
    } satisfies CacheProofOutputScope;

    const result = buildCacheVariantWithRouteBudget({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      routeBudget: {
        routeId: "route:/other",
        variantCacheKeys: ["cp1:existing"],
      },
      output,
    });

    const fallback = expectBreakerReason(result, "CP_ROUTE_VARIANT_BUDGET_ROUTE_MISMATCH");
    expect(fallback).toMatchObject({
      mode: "privateUncacheable",
      scope: "route",
      fields: {
        budgetRouteId: "route:/other",
        routeId: "route:/:tenant",
      },
    });
  });

  it("rejects known duplicate route variants when the existing route budget is already over ceiling", () => {
    const budget = {
      ...DEFAULT_CACHE_VARIANT_BUDGET,
      maxVariantsPerRoute: 1,
    };
    const output = {
      kind: "layout",
      layoutId: "layout:/[tenant]",
      rootBoundaryId: "layout:/",
      routeId: "route:/:tenant",
    } satisfies CacheProofOutputScope;
    const dimensions = [
      {
        name: "tenant",
        privacy: "public",
        source: "params",
        values: ["alpha"],
      },
    ] satisfies readonly CacheVariantDimensionInput[];
    const seed = buildCacheVariant({
      budget,
      dimensions,
      output,
    });
    expect(seed.kind).toBe("variant");
    if (seed.kind !== "variant") {
      throw new Error("Expected seed route variant to be admitted");
    }

    const duplicate = buildCacheVariantWithRouteBudget({
      budget,
      dimensions,
      routeBudget: {
        routeId: output.routeId,
        variantCacheKeys: [seed.variant.cacheKey, "cp1:other-known-variant"],
      },
      output,
    });

    const fallback = expectBreakerReason(duplicate, "CP_ROUTE_VARIANT_CEILING_EXCEEDED");
    expect(fallback).toMatchObject({
      mode: "privateUncacheable",
      scope: "route",
      fields: {
        existingVariantCount: 2,
        maxVariantsPerRoute: 1,
        routeId: "route:/:tenant",
      },
    });
  });

  it("requires complete negative request-api observations before absence is proof", () => {
    const complete = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: ["posts", "posts"],
      completeness: "complete",
      dynamicFetches: ["https://api.example.test/posts?token=secret"],
      output: {
        kind: "layout",
        layoutId: "layout:/blog",
        rootBoundaryId: "layout:/",
        routeId: "route:/blog",
      },
      pathTags: ["/blog"],
      requestApis: [
        { kind: "headers", status: "notObserved" },
        { kind: "cookies", status: "notObserved" },
      ],
    });
    const partial = buildRenderObservation({
      ...complete,
      completeness: "partial",
    });
    const observed = buildRenderObservation({
      ...complete,
      requestApis: [
        { kind: "headers", status: "observed" },
        { kind: "cookies", status: "notObserved" },
      ],
    });
    const missingApiKind = buildRenderObservation({
      ...complete,
      requestApis: [{ kind: "cookies", status: "notObserved" }],
    });
    const duplicateApiKind = {
      ...complete,
      requestApis: [
        { kind: "headers", status: "observed" },
        { kind: "headers", status: "notObserved" },
        { kind: "cookies", status: "notObserved" },
      ],
    } satisfies RenderObservation;

    expect(hasCompleteNegativeRequestApiProof(complete, ["headers", "cookies"])).toBe(true);
    expect(hasCompleteNegativeRequestApiProof(partial, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(observed, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(missingApiKind, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(duplicateApiKind, ["headers", "cookies"])).toBe(
      false,
    );
    expect(complete.cacheTags).toEqual(["posts"]);
    expect(JSON.stringify(complete.dynamicFetches)).not.toContain("secret");
  });

  it("treats boundary outcome compatibility as exact-match only", () => {
    expect(
      buildBoundaryOutcomeCompatibility({
        candidate: { kind: "success" },
        expected: { kind: "success" },
      }).kind,
    ).toBe("compatible");

    const mismatch = buildBoundaryOutcomeCompatibility({
      candidate: { kind: "notFound" },
      expected: { kind: "success" },
    });
    expect(mismatch.kind).toBe("incompatible");
    if (mismatch.kind === "incompatible") {
      expect(mismatch.fallback.code).toBe("CP_BOUNDARY_OUTCOME_MISMATCH");
    }

    const unknown = buildBoundaryOutcomeCompatibility({
      candidate: { kind: "unknown" },
      expected: { kind: "success" },
    });
    expect(unknown.kind).toBe("incompatible");
    if (unknown.kind === "incompatible") {
      expect(unknown.fallback.code).toBe("CP_BOUNDARY_OUTCOME_UNKNOWN");
    }
  });

  it("never authorizes runtime reuse while the proof model is disabled", () => {
    const variant = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      output: {
        kind: "app-html",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/",
      },
    });

    expect(variant.kind).toBe("variant");
    if (variant.kind !== "variant") {
      throw new Error("Expected cache variant construction to succeed");
    }

    const decision = createDisabledCacheProofDecision({
      variant: variant.variant,
      observation: buildRenderObservation({
        boundaryOutcome: { kind: "success" },
        cacheability: "public",
        cacheTags: [],
        completeness: "complete",
        dynamicFetches: [],
        output: variant.variant.output,
        pathTags: [],
        requestApis: [],
      }),
    });

    expect(decision).toMatchObject({
      canReuse: false,
      kind: "disabled",
      fallback: {
        code: "CP_MODEL_DISABLED",
        mode: "renderFresh",
        scope: "affectedOutput",
      },
    });
  });

  it("classifies public request observations as public variant dimensions", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: [],
      completeness: "complete",
      dynamicFetches: [],
      output: {
        kind: "app-html",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/products/:id",
      },
      pathTags: ["/products/1"],
      requestApis: [
        { kind: "params", status: "observed" },
        { kind: "searchParams", status: "observed" },
      ],
    });

    expect(observation.downgrade).toEqual(classifyRenderObservationDowngrade(observation));
    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: true,
      target: "publicVariant",
      fallback: null,
    });
    expect(observation.downgrade.reasons.map((reason) => reason.code)).toEqual([
      "CP_DOWNGRADE_PUBLIC_REQUEST_API",
      "CP_DOWNGRADE_PUBLIC_REQUEST_API",
    ]);
  });

  it("classifies private auth draft and session dimensions without enabling public reuse", () => {
    expect(classifyCacheVariantDimensionDowngrade({ source: "auth" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "auth",
      source: "auth",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "session" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "session",
      source: "session",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "draft-mode" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "draft",
      source: "draft-mode",
      target: "privateUncacheable",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "cookie" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "private",
      source: "cookie",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "header" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "private",
      source: "header",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "params" })).toBeNull();
    expect(classifyCacheVariantDimensionDowngrade({ source: "search" })).toBeNull();
  });

  it("classifies private request API observations away from public cache", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: [],
      completeness: "complete",
      dynamicFetches: [],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/account",
      },
      pathTags: ["/account"],
      requestApis: [
        { kind: "cookies", status: "observed" },
        { kind: "draftMode", status: "observed" },
        { kind: "headers", status: "observed" },
      ],
    });

    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: false,
      target: "privateUncacheable",
      fallback: {
        code: "CP_PRIVATE_DYNAMIC_DOWNGRADE",
        mode: "privateUncacheable",
        scope: "affectedOutput",
      },
    });
    expect(observation.downgrade.reasons).toEqual([
      {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "cookies",
        target: "private",
      },
      {
        code: "CP_DOWNGRADE_DRAFT_MODE",
        requestApi: "draftMode",
        target: "privateUncacheable",
      },
      {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "headers",
        target: "private",
      },
    ]);
  });

  it("classifies dynamic and incomplete observations as fresh-render downgrades", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "unknown",
      cacheTags: [],
      completeness: "partial",
      dynamicFetches: ["https://api.example.test/live?token=secret"],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/live",
      },
      pathTags: ["/live"],
      requestApis: [{ kind: "connection", status: "observed" }],
    });

    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: false,
      target: "freshRender",
      fallback: {
        code: "CP_PRIVATE_DYNAMIC_DOWNGRADE",
        mode: "renderFresh",
        scope: "affectedOutput",
      },
    });
    expect(observation.downgrade.reasons.map((reason) => reason.code)).toEqual([
      "CP_DOWNGRADE_CACHEABILITY_UNKNOWN",
      "CP_DOWNGRADE_INCOMPLETE_OBSERVATION",
      "CP_DOWNGRADE_DYNAMIC_FETCH",
      "CP_DOWNGRADE_DYNAMIC_REQUEST_API",
    ]);
    expect(JSON.stringify(observation.downgrade)).not.toContain("secret");
  });

  it("proves static layout reuse while leaving runtime cache reuse disabled", () => {
    const currentOutput = createLayoutOutput({
      routeId: "route:/dashboard/profile",
    });
    const candidateOutput = createLayoutOutput({
      routeId: "route:/dashboard/settings",
    });
    const variant = buildLayoutVariant({ output: candidateOutput });
    const observation = buildLayoutObservation({ output: candidateOutput });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput,
    });

    expect(proof.kind).toBe("proof");
    if (proof.kind !== "proof") {
      throw new Error("Expected same static layout identity to produce proof");
    }
    expect(proof.proof).toMatchObject({
      authorizesRuntimeReuse: false,
      code: "CP_STATIC_LAYOUT_REUSE_PROVEN",
      reuseClass: "static-layout",
      fields: {
        candidateRouteId: "route:/dashboard/settings",
        currentRouteId: "route:/dashboard/profile",
        layoutId: "layout:/dashboard",
        rootBoundaryId: "layout:/",
      },
    });

    const decision = createDisabledCacheProofDecision({
      observation,
      staticLayoutProof: proof.proof,
      variant,
    });

    expect(decision).toMatchObject({
      canReuse: false,
      kind: "disabled",
      fallback: {
        code: "CP_MODEL_DISABLED",
      },
      staticLayoutProof: {
        code: "CP_STATIC_LAYOUT_REUSE_PROVEN",
      },
    });
  });

  it("rejects static layout proof when request API absence is not completely proven", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({ output });
    const observedParams = buildLayoutObservation({
      output,
      requestApis: buildRenderRequestApiObservations({
        completeness: "complete",
        observed: ["params"],
      }),
    });
    const missingKinds = buildLayoutObservation({
      output,
      requestApis: [{ kind: "headers", status: "notObserved" }],
    });

    const observedProof = buildStaticLayoutReuseProof({
      candidateObservation: observedParams,
      candidateVariant: variant,
      currentOutput: output,
    });
    const missingProof = buildStaticLayoutReuseProof({
      candidateObservation: missingKinds,
      candidateVariant: variant,
      currentOutput: output,
    });

    expect(observedProof).toMatchObject({
      kind: "rejected",
      fallback: {
        code: "CP_STATIC_LAYOUT_REQUEST_API_OBSERVED",
        fields: {
          requestApi: "params",
          status: "observed",
        },
      },
    });
    expect(missingProof).toMatchObject({
      kind: "rejected",
      fallback: {
        code: "CP_STATIC_LAYOUT_REQUEST_API_UNKNOWN",
        fields: {
          requestApi: "connection",
          status: "missing",
        },
      },
    });
  });

  it("rejects stale render-observation downgrade during static layout proof", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({ output });
    const staleObservation = {
      ...buildLayoutObservation({ output }),
      downgrade: {
        fallback: null,
        isPublicCacheCandidate: true,
        reasons: [],
        target: "public",
      },
      dynamicFetches: ["https://api.example.test/live?token=secret"],
    } satisfies RenderObservation;

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: staleObservation,
      candidateVariant: variant,
      currentOutput: output,
    });

    const fallback = expectStaticLayoutProofRejection(
      proof,
      "CP_STATIC_LAYOUT_PRIVATE_DYNAMIC_DOWNGRADE",
    );
    expect(fallback).toMatchObject({
      fields: {
        reasonCodes: ["CP_DOWNGRADE_DYNAMIC_FETCH"],
        target: "freshRender",
      },
      mode: "renderFresh",
    });
    expect(JSON.stringify(fallback)).not.toContain("secret");
  });

  it("rejects duplicated request-api observations using the most restrictive status", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({ output });
    const duplicateRequestApiObservation = {
      ...buildLayoutObservation({ output }),
      downgrade: {
        fallback: null,
        isPublicCacheCandidate: true,
        reasons: [],
        target: "public",
      },
      requestApis: [
        { kind: "connection", status: "notObserved" },
        { kind: "cookies", status: "notObserved" },
        { kind: "draftMode", status: "notObserved" },
        { kind: "headers", status: "notObserved" },
        { kind: "params", status: "notObserved" },
        { kind: "params", status: "observed" },
        { kind: "searchParams", status: "notObserved" },
      ],
    } satisfies RenderObservation;

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: duplicateRequestApiObservation,
      candidateVariant: variant,
      currentOutput: output,
    });

    const fallback = expectStaticLayoutProofRejection(
      proof,
      "CP_STATIC_LAYOUT_REQUEST_API_OBSERVED",
    );
    expect(fallback.fields).toEqual({
      requestApi: "params",
      status: "observed",
    });
  });

  it("rejects private and dynamic static layout observations before reuse proof", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({ output });
    const privateObservation = buildLayoutObservation({
      output,
      requestApis: buildRenderRequestApiObservations({
        completeness: "complete",
        observed: ["cookies"],
      }),
    });
    const dynamicObservation = buildLayoutObservation({
      dynamicFetches: ["https://api.example.test/dashboard?token=secret"],
      output,
    });

    const privateProof = buildStaticLayoutReuseProof({
      candidateObservation: privateObservation,
      candidateVariant: variant,
      currentOutput: output,
    });
    const dynamicProof = buildStaticLayoutReuseProof({
      candidateObservation: dynamicObservation,
      candidateVariant: variant,
      currentOutput: output,
    });

    expect(privateProof).toMatchObject({
      kind: "rejected",
      fallback: {
        code: "CP_STATIC_LAYOUT_PRIVATE_DYNAMIC_DOWNGRADE",
        fields: {
          reasonCodes: ["CP_DOWNGRADE_PRIVATE_REQUEST_API"],
          target: "private",
        },
      },
    });
    expect(dynamicProof).toMatchObject({
      kind: "rejected",
      fallback: {
        code: "CP_STATIC_LAYOUT_PRIVATE_DYNAMIC_DOWNGRADE",
        fields: {
          reasonCodes: ["CP_DOWNGRADE_DYNAMIC_FETCH"],
          target: "freshRender",
        },
      },
    });
    expect(JSON.stringify(dynamicProof)).not.toContain("secret");
  });

  it("rejects static layout proof when boundary outcome is not successful", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({ output });
    const observation = buildLayoutObservation({
      boundaryOutcome: { kind: "error", digest: "ERR_TEST" },
      output,
    });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput: output,
    });

    const fallback = expectStaticLayoutProofRejection(proof, "CP_BOUNDARY_OUTCOME_MISMATCH");
    expect(fallback.fields).toEqual({
      candidateKind: "error",
      expectedKind: "success",
    });
  });

  it("rejects private variant dimensions for static layout proof", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({
      dimensions: [
        {
          name: "session",
          privacy: "private",
          source: "cookie",
          values: ["secret-session"],
        },
      ],
      output,
    });
    const observation = buildLayoutObservation({ output });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput: output,
    });

    expect(proof).toMatchObject({
      kind: "rejected",
      fallback: {
        code: "CP_STATIC_LAYOUT_PRIVATE_VARIANT_DIMENSION",
        fields: {
          dimension: "session",
          reasonCode: "CP_DOWNGRADE_PRIVATE_DIMENSION",
          source: "cookie",
          target: "private",
        },
      },
    });
    expect(JSON.stringify(proof)).not.toContain("secret-session");
  });

  it("rejects non-layout current output scope for static layout proof", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({ output });
    const observation = buildLayoutObservation({ output });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput: {
        kind: "page",
        pageId: "page:/dashboard",
        rootBoundaryId: "layout:/",
        routeId: output.routeId,
      },
    });

    const fallback = expectStaticLayoutProofRejection(
      proof,
      "CP_STATIC_LAYOUT_CURRENT_OUTPUT_KIND",
    );
    expect(fallback.fields).toEqual({
      currentOutputKind: "page",
    });
  });

  it("rejects non-layout candidate variant output scope for static layout proof", () => {
    const currentOutput = createLayoutOutput();
    const observation = buildLayoutObservation({ output: currentOutput });
    const variantResult = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: currentOutput.rootBoundaryId,
        routeId: currentOutput.routeId,
      },
    });
    expect(variantResult.kind).toBe("variant");
    if (variantResult.kind !== "variant") {
      throw new Error("Expected non-layout candidate variant construction to succeed");
    }

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variantResult.variant,
      currentOutput,
    });

    const fallback = expectStaticLayoutProofRejection(
      proof,
      "CP_STATIC_LAYOUT_CANDIDATE_OUTPUT_KIND",
    );
    expect(fallback.fields).toEqual({
      candidateOutputKind: "app-rsc",
    });
  });

  it("rejects non-layout observation output scope for static layout proof", () => {
    const output = createLayoutOutput();
    const variant = buildLayoutVariant({ output });
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: ["dashboard"],
      completeness: "complete",
      dynamicFetches: [],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: output.rootBoundaryId,
        routeId: output.routeId,
      },
      pathTags: ["/dashboard"],
      requestApis: buildRenderRequestApiObservations({
        completeness: "complete",
        observed: [],
      }),
    });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput: output,
    });

    const fallback = expectStaticLayoutProofRejection(
      proof,
      "CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_KIND",
    );
    expect(fallback.fields).toEqual({
      observationOutputKind: "app-rsc",
    });
  });

  it("rejects static layout observation output mismatch", () => {
    const candidateOutput = createLayoutOutput({
      routeId: "route:/dashboard/settings",
    });
    const observationOutput = createLayoutOutput({
      routeId: "route:/dashboard/profile",
    });
    const variant = buildLayoutVariant({ output: candidateOutput });
    const observation = buildLayoutObservation({ output: observationOutput });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput: candidateOutput,
    });

    const fallback = expectStaticLayoutProofRejection(
      proof,
      "CP_STATIC_LAYOUT_OBSERVATION_OUTPUT_MISMATCH",
    );
    expect(fallback.fields).toMatchObject({
      candidateRouteId: "route:/dashboard/settings",
      field: "routeId",
      observationRouteId: "route:/dashboard/profile",
    });
  });

  it("rejects static layout identity mismatch", () => {
    const currentOutput = createLayoutOutput({
      layoutId: "layout:/dashboard",
    });
    const candidateOutput = createLayoutOutput({
      layoutId: "layout:/dashboard/settings",
    });
    const variant = buildLayoutVariant({ output: candidateOutput });
    const observation = buildLayoutObservation({ output: candidateOutput });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput,
    });

    const fallback = expectStaticLayoutProofRejection(proof, "CP_STATIC_LAYOUT_ID_MISMATCH");
    expect(fallback.fields).toEqual({
      candidateLayoutId: "layout:/dashboard/settings",
      currentLayoutId: "layout:/dashboard",
    });
  });

  it("rejects static layout root-boundary mismatch", () => {
    const currentOutput = createLayoutOutput({
      rootBoundaryId: "layout:/root-a",
    });
    const candidateOutput = createLayoutOutput({
      rootBoundaryId: "layout:/root-b",
    });
    const variant = buildLayoutVariant({ output: candidateOutput });
    const observation = buildLayoutObservation({ output: candidateOutput });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput,
    });

    const fallback = expectStaticLayoutProofRejection(
      proof,
      "CP_STATIC_LAYOUT_ROOT_BOUNDARY_MISMATCH",
    );
    expect(fallback.fields).toEqual({
      candidateRootBoundaryId: "layout:/root-b",
      currentRootBoundaryId: "layout:/root-a",
    });
  });

  it("rejects unknown root-boundary identity instead of treating it as proof", () => {
    const output = createLayoutOutput({ rootBoundaryId: null });
    const variant = buildLayoutVariant({ output });
    const observation = buildLayoutObservation({ output });

    const proof = buildStaticLayoutReuseProof({
      candidateObservation: observation,
      candidateVariant: variant,
      currentOutput: output,
    });

    expect(proof).toMatchObject({
      kind: "rejected",
      fallback: {
        code: "CP_STATIC_LAYOUT_ROOT_BOUNDARY_UNKNOWN",
        fields: {
          candidateRootBoundaryId: null,
          currentRootBoundaryId: null,
        },
      },
    });
  });
});
