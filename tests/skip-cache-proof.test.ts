import { describe, expect, it } from "vite-plus/test";
import {
  createArtifactCompatibilityEnvelope,
  type ArtifactCompatibilityEnvelope,
} from "../packages/vinext/src/server/artifact-compatibility.js";
import {
  createClientReusePayloadHash,
  type ClientReuseManifestEntry,
} from "../packages/vinext/src/server/client-reuse-manifest.js";
import {
  buildCacheVariantWithRouteBudget,
  buildRenderObservation,
  buildRenderRequestApiObservations,
  createStaticLayoutArtifactReuseDecision,
  DEFAULT_CACHE_VARIANT_BUDGET,
  type CacheProofOutputScope,
  type StaticLayoutArtifactReuseDecision,
} from "../packages/vinext/src/server/cache-proof.js";
import {
  crossCheckClientReuseManifestEntryWithCache,
  type SkipCacheInvalidationProof,
} from "../packages/vinext/src/server/skip-cache-proof.js";

type LayoutOutputScope = Extract<CacheProofOutputScope, { kind: "layout" }>;
type StaticLayoutReuseDecision = Extract<StaticLayoutArtifactReuseDecision, { kind: "reuse" }>;

function createLayoutOutput(): LayoutOutputScope {
  return {
    kind: "layout",
    layoutId: "layout:/dashboard",
    rootBoundaryId: "layout:/",
    routeId: "route:/dashboard/settings",
  };
}

function createCompatibility(
  overrides: Partial<
    Pick<
      ArtifactCompatibilityEnvelope,
      "deploymentVersion" | "graphVersion" | "renderEpoch" | "rootBoundaryId"
    >
  > = {},
): ArtifactCompatibilityEnvelope {
  return createArtifactCompatibilityEnvelope({
    deploymentVersion: "deploymentVersion" in overrides ? overrides.deploymentVersion : "deploy-a",
    graphVersion: "graphVersion" in overrides ? overrides.graphVersion : "graph-a",
    renderEpoch: "renderEpoch" in overrides ? overrides.renderEpoch : "epoch-a",
    rootBoundaryId: "rootBoundaryId" in overrides ? overrides.rootBoundaryId : "layout:/",
  });
}

function createReuseDecision(
  input: {
    candidateArtifactCompatibility?: ArtifactCompatibilityEnvelope;
    currentArtifactCompatibility?: ArtifactCompatibilityEnvelope;
    output?: LayoutOutputScope;
  } = {},
): StaticLayoutArtifactReuseDecision {
  const output = input.output ?? createLayoutOutput();
  return createStaticLayoutArtifactReuseDecision({
    currentArtifactCompatibility: input.currentArtifactCompatibility ?? createCompatibility(),
    candidateArtifactCompatibility: input.candidateArtifactCompatibility ?? createCompatibility(),
    candidateObservation: buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: ["dashboard"],
      completeness: "complete",
      dynamicFetches: [],
      output,
      pathTags: ["/dashboard"],
      requestApis: buildRenderRequestApiObservations({
        completeness: "complete",
        observed: [],
      }),
    }),
    candidateVariant: buildCacheVariantWithRouteBudget({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      output,
      routeBudget: {
        routeId: output.routeId,
        variantCacheKeys: [],
      },
    }),
    currentOutput: {
      ...output,
      routeId: "route:/dashboard/profile",
    },
  });
}

function expectReuseDecision(
  decision: StaticLayoutArtifactReuseDecision,
): asserts decision is StaticLayoutReuseDecision {
  expect(decision.kind).toBe("reuse");
  if (decision.kind !== "reuse") {
    throw new Error("Expected fixture cache decision to authorize static layout reuse");
  }
}

function createManifestEntry(input: {
  artifactCompatibility?: ArtifactCompatibilityEnvelope;
  id?: string;
  payloadHash?: string;
  variantCacheKey: string;
}): ClientReuseManifestEntry {
  return {
    artifactCompatibility: input.artifactCompatibility ?? createCompatibility(),
    id: input.id ?? "layout:/dashboard",
    kind: "layout",
    payloadHash: input.payloadHash ?? createClientReusePayloadHash("dashboard-layout-payload"),
    privacy: "public",
    variantCacheKey: input.variantCacheKey,
  };
}

function createVerifiedFixture(
  options: {
    artifactCompatibility?: ArtifactCompatibilityEnvelope;
    invalidation?: SkipCacheInvalidationProof;
    payloadHash?: string | null;
  } = {},
) {
  const artifactCompatibility = options.artifactCompatibility ?? createCompatibility();
  const payloadHash = createClientReusePayloadHash("dashboard-layout-payload");
  const decision = createReuseDecision({
    candidateArtifactCompatibility: artifactCompatibility,
  });
  expectReuseDecision(decision);

  return {
    artifact: {
      compatibility: artifactCompatibility,
      invalidation:
        options.invalidation ?? ({ kind: "valid" } satisfies SkipCacheInvalidationProof),
      payloadHash: options.payloadHash === undefined ? payloadHash : options.payloadHash,
    },
    decision,
    entry: createManifestEntry({
      artifactCompatibility,
      payloadHash,
      variantCacheKey: decision.proof.variant.cacheKey,
    }),
  };
}

describe("skip/cache proof cross-checks", () => {
  it("verifies a matching public layout entry without enabling skip transport", () => {
    const fixture = createVerifiedFixture();

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      entry: fixture.entry,
    });

    expect(result).toMatchObject({
      code: "SKIP_CACHE_CROSS_CHECK_PASSED",
      entryId: "layout:/dashboard",
      kind: "verified",
      skipDisposition: {
        code: "SKIP_MODEL_DISABLED",
        enabled: false,
        mode: "renderAndSend",
      },
    });
  });

  it("rejects artifact metadata that was not bound to the accepted cache proof", () => {
    const provenCompatibility = createCompatibility({
      deploymentVersion: "deploy-a",
      graphVersion: "graph-a",
    });
    const unprovenCompatibility = createCompatibility({
      deploymentVersion: "deploy-b",
      graphVersion: "graph-b",
    });
    const payloadHash = createClientReusePayloadHash("dashboard-layout-payload");
    const decision = createReuseDecision({
      candidateArtifactCompatibility: provenCompatibility,
      currentArtifactCompatibility: provenCompatibility,
    });
    expectReuseDecision(decision);

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: {
        compatibility: unprovenCompatibility,
        invalidation: { kind: "valid" },
        payloadHash,
      },
      cacheDecision: decision,
      entry: createManifestEntry({
        artifactCompatibility: unprovenCompatibility,
        payloadHash,
        variantCacheKey: decision.proof.variant.cacheKey,
      }),
    });

    expect(result).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_ARTIFACT_PROOF_MISMATCH",
        entryId: "layout:/dashboard",
        fields: {
          mismatchedFields: ["graphVersion", "deploymentVersion"],
        },
      },
    });
  });

  for (const [label, artifactCompatibility, reason] of [
    ["graph", createCompatibility({ graphVersion: "graph-b" }), "graphVersionMismatch"],
    [
      "deployment",
      createCompatibility({ deploymentVersion: "deploy-b" }),
      "deploymentVersionMismatch",
    ],
    [
      "root boundary",
      createCompatibility({ rootBoundaryId: "layout:/other-root" }),
      "rootBoundaryIdMismatch",
    ],
    ["render epoch", createCompatibility({ renderEpoch: "epoch-b" }), "renderEpochMismatch"],
  ] as const) {
    it(`rejects ${label} mismatches between the client hint and cache artifact`, () => {
      const fixture = createVerifiedFixture();

      const result = crossCheckClientReuseManifestEntryWithCache({
        artifact: fixture.artifact,
        cacheDecision: fixture.decision,
        entry: {
          ...fixture.entry,
          artifactCompatibility,
        },
      });

      expect(result).toMatchObject({
        kind: "rejected",
        rejection: {
          code: "SKIP_CACHE_ARTIFACT_COMPATIBILITY_INCOMPATIBLE",
          entryId: "layout:/dashboard",
          fields: {
            compatibilityFallback: "renderFresh",
            reason,
          },
        },
      });
    });
  }

  it("rejects unknown graph compatibility between the client hint and cache artifact", () => {
    const fixture = createVerifiedFixture();

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      entry: {
        ...fixture.entry,
        artifactCompatibility: createCompatibility({ graphVersion: null }),
      },
    });

    expect(result).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_ARTIFACT_COMPATIBILITY_UNKNOWN",
        entryId: "layout:/dashboard",
        fields: {
          compatibilityFallback: "renderFresh",
          reason: "graphVersionUnknown",
        },
      },
    });
  });

  it("rejects manifest entries whose layout id differs from the accepted cache proof", () => {
    const fixture = createVerifiedFixture();

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      entry: createManifestEntry({
        artifactCompatibility: fixture.artifact.compatibility,
        id: "layout:/billing",
        payloadHash: fixture.entry.payloadHash,
        variantCacheKey: fixture.decision.proof.variant.cacheKey,
      }),
    });

    expect(result).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_ENTRY_ID_MISMATCH",
        entryId: "layout:/billing",
        fields: {
          cacheEntryId: "layout:/dashboard",
          manifestEntryId: "layout:/billing",
        },
      },
    });
  });

  it("rejects variant cache key mismatches", () => {
    const fixture = createVerifiedFixture();
    const staleVariantCacheKey = "cp1:stale-client-variant";

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      entry: {
        ...fixture.entry,
        variantCacheKey: staleVariantCacheKey,
      },
    });

    expect(result).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_VARIANT_MISMATCH",
        fields: {
          cacheVariantCacheKeyHash: createClientReusePayloadHash(
            fixture.decision.proof.variant.cacheKey,
          ),
          entryVariantCacheKeyHash: createClientReusePayloadHash(staleVariantCacheKey),
        },
      },
    });
  });

  it("rejects payload hash mismatches", () => {
    const fixture = createVerifiedFixture();
    const stalePayloadHash = createClientReusePayloadHash("stale-client-payload");

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      entry: {
        ...fixture.entry,
        payloadHash: stalePayloadHash,
      },
    });

    expect(result).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_PAYLOAD_HASH_MISMATCH",
        fields: {
          cachePayloadHash: createClientReusePayloadHash("dashboard-layout-payload"),
          entryPayloadHash: stalePayloadHash,
        },
      },
    });
  });

  it("rejects missing payload hash proof from the cache artifact", () => {
    const fixture = createVerifiedFixture({ payloadHash: null });

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      entry: fixture.entry,
    });

    expect(result).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_PAYLOAD_HASH_MISSING",
      },
    });
  });

  for (const [invalidation, code] of [
    [{ kind: "unknown" }, "SKIP_CACHE_INVALIDATION_UNKNOWN"],
    [{ kind: "invalidated", invalidationEpoch: "tag-floor-7" }, "SKIP_CACHE_INVALIDATED"],
  ] satisfies readonly [SkipCacheInvalidationProof, string][]) {
    it(`rejects ${invalidation.kind} invalidation proof`, () => {
      const fixture = createVerifiedFixture({ invalidation });

      const result = crossCheckClientReuseManifestEntryWithCache({
        artifact: fixture.artifact,
        cacheDecision: fixture.decision,
        entry: fixture.entry,
      });

      expect(result).toMatchObject({
        kind: "rejected",
        rejection: {
          code,
          entryId: "layout:/dashboard",
        },
      });
    });
  }

  it("rejects missing or rejected cache proof instead of treating cache presence as authority", () => {
    const fixture = createVerifiedFixture();
    const rejectedDecision = createReuseDecision({
      candidateArtifactCompatibility: createCompatibility({ deploymentVersion: "deploy-b" }),
    });

    const missing = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: null,
      entry: fixture.entry,
    });
    const rejected = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: rejectedDecision,
      entry: fixture.entry,
    });

    expect(missing).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_PROOF_MISSING",
      },
    });
    expect(rejected).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_PROOF_REJECTED",
        fields: {
          cacheProofCode: "CP_ARTIFACT_COMPATIBILITY_INCOMPATIBLE",
        },
      },
    });
  });
});
