import { describe, expect, it } from "vite-plus/test";
import {
  createArtifactCompatibilityEnvelope,
  type ArtifactCompatibilityEnvelope,
} from "../packages/vinext/src/server/artifact-compatibility.js";
import {
  DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
  createClientReuseManifest,
  createClientReusePayloadHash,
  parseClientReuseManifestHeader,
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
  createClientReuseSkipTransportPlan,
  createStaticLayoutClientReuseArtifactCompatibility,
  createStaticLayoutClientReusePayloadHash,
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
    currentArtifactCompatibility: artifactCompatibility,
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
  it("enables static-layout skip transport for a verified public layout entry", () => {
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
        code: "SKIP_STATIC_LAYOUT_VERIFIED",
        enabled: true,
        mode: "skipStaticLayout",
        skippedEntryIds: ["layout:/dashboard"],
      },
    });
  });

  it("enables static-layout skip for sibling routes using the real proof helpers", () => {
    // Layout /dashboard rendered during a visit to /dashboard/settings is
    // reused when navigating to sibling route /dashboard/profile.  The test
    // exercises the three exported static-layout proof helpers —
    // createStaticLayoutClientReusePayloadHash,
    // createStaticLayoutClientReuseArtifactCompatibility, and the variant
    // cache key from buildCacheVariantWithRouteBudget — to prove sibling
    // routes produce identical proof identity when routeId is excluded.
    const baseCompatibility = createCompatibility();
    const dashboardLayoutId = "layout:/dashboard";
    const rootBoundaryId = "layout:/";
    const settingsRouteId = "route:/dashboard/settings";
    const profileRouteId = "route:/dashboard/profile";

    const candidateOutput: LayoutOutputScope = {
      kind: "layout",
      layoutId: dashboardLayoutId,
      rootBoundaryId,
      routeId: settingsRouteId,
    };
    const currentOutput: LayoutOutputScope = {
      kind: "layout",
      layoutId: dashboardLayoutId,
      rootBoundaryId,
      routeId: profileRouteId,
    };

    // Build real variant cache keys for both the cache proof (candidate)
    // and the client manifest entry.  Both originate from the same candidate
    // render, so the variant cache key is identical.
    const candidateVariant = buildCacheVariantWithRouteBudget({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      output: candidateOutput,
      routeBudget: { routeId: candidateOutput.routeId, variantCacheKeys: [] },
    });
    if (candidateVariant.kind !== "variant") throw new Error("Expected variant");
    const variantCacheKey = candidateVariant.variant.cacheKey;

    // Build artifact compatibilities with the exported helper.
    // routeId is excluded from renderEpoch, so sibling routes produce
    // layout-scoped identity.
    const serverArtifact = createStaticLayoutClientReuseArtifactCompatibility({
      artifactCompatibility: baseCompatibility,
      layoutId: dashboardLayoutId,
      rootBoundaryId,
      routeId: profileRouteId,
      variantCacheKey,
    });
    const clientArtifact = createStaticLayoutClientReuseArtifactCompatibility({
      artifactCompatibility: baseCompatibility,
      layoutId: dashboardLayoutId,
      rootBoundaryId,
      routeId: settingsRouteId,
      variantCacheKey,
    });

    // Build payload hashes with the exported helper.  routeId is excluded
    // from the hash, so sibling routes produce identical payload hashes.
    const serverPayloadHash = createStaticLayoutClientReusePayloadHash({
      artifactCompatibility: serverArtifact,
      layoutId: dashboardLayoutId,
      rootBoundaryId,
      routeId: profileRouteId,
      variantCacheKey,
    });
    const clientPayloadHash = createStaticLayoutClientReusePayloadHash({
      artifactCompatibility: clientArtifact,
      layoutId: dashboardLayoutId,
      rootBoundaryId,
      routeId: settingsRouteId,
      variantCacheKey,
    });
    expect(serverPayloadHash).toBe(clientPayloadHash);

    // Build the cache decision with sibling-route topology: the candidate
    // (cached) output is the settings route; the current output is the
    // profile route.  The proof authorizes static-layout reuse across routes.
    const decision = createStaticLayoutArtifactReuseDecision({
      currentArtifactCompatibility: serverArtifact,
      candidateArtifactCompatibility: serverArtifact,
      candidateObservation: buildRenderObservation({
        boundaryOutcome: { kind: "success" },
        cacheability: "public",
        cacheTags: ["dashboard"],
        completeness: "complete",
        dynamicFetches: [],
        output: candidateOutput,
        pathTags: ["/dashboard"],
        requestApis: buildRenderRequestApiObservations({
          completeness: "complete",
          observed: [],
        }),
      }),
      candidateVariant,
      currentOutput,
    });
    expectReuseDecision(decision);

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: {
        compatibility: serverArtifact,
        invalidation: { kind: "valid" },
        payloadHash: serverPayloadHash,
      },
      cacheDecision: decision,
      entry: createManifestEntry({
        artifactCompatibility: clientArtifact,
        payloadHash: clientPayloadHash,
        variantCacheKey,
      }),
    });

    expect(result).toMatchObject({
      code: "SKIP_CACHE_CROSS_CHECK_PASSED",
      entryId: dashboardLayoutId,
      kind: "verified",
      skipDisposition: {
        code: "SKIP_STATIC_LAYOUT_VERIFIED",
        enabled: true,
        mode: "skipStaticLayout",
        skippedEntryIds: [dashboardLayoutId],
      },
    });
  });

  it("builds a skip transport plan from verified entries while preserving rejection traces", () => {
    const fixture = createVerifiedFixture();
    const manifest = parseClientReuseManifestHeader(
      JSON.stringify(
        createClientReuseManifest({
          entries: [
            fixture.entry,
            createManifestEntry({
              artifactCompatibility: fixture.artifact.compatibility,
              id: "layout:/billing",
              payloadHash: fixture.entry.payloadHash,
              variantCacheKey: fixture.decision.proof.variant.cacheKey,
            }),
          ],
          visibleCommitVersion: 1,
        }),
      ),
    );
    let verificationCount = 0;

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      verifyEntry(entry) {
        verificationCount++;
        return crossCheckClientReuseManifestEntryWithCache({
          artifact: fixture.artifact,
          cacheDecision: fixture.decision,
          entry,
        });
      },
    });

    expect(verificationCount).toBe(2);
    expect(plan).toMatchObject({
      kind: "skip",
      skippedEntryIds: ["layout:/dashboard"],
      skipDisposition: {
        code: "SKIP_STATIC_LAYOUT_VERIFIED",
        enabled: true,
        mode: "skipStaticLayout",
        skippedEntryIds: ["layout:/dashboard"],
      },
      entryRejections: [
        {
          code: "SKIP_CACHE_ENTRY_ID_MISMATCH",
          entryId: "layout:/billing",
        },
      ],
    });
  });

  it("uses the verified manifest entry id instead of trusting verifier-provided skipped ids", () => {
    const fixture = createVerifiedFixture();
    const manifest = parseClientReuseManifestHeader(
      JSON.stringify(
        createClientReuseManifest({
          entries: [fixture.entry],
          visibleCommitVersion: 1,
        }),
      ),
    );

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      verifyEntry(entry) {
        const verified = crossCheckClientReuseManifestEntryWithCache({
          artifact: fixture.artifact,
          cacheDecision: fixture.decision,
          entry,
        });
        if (verified.kind !== "verified") {
          throw new Error("Expected fixture entry to verify");
        }
        return {
          ...verified,
          skipDisposition: {
            ...verified.skipDisposition,
            skippedEntryIds: ["layout:/unverified"],
          },
        };
      },
    });

    expect(plan).toMatchObject({
      kind: "skip",
      skippedEntryIds: ["layout:/dashboard"],
    });
  });

  it("rejects verified results whose entry id does not match the manifest entry", () => {
    const fixture = createVerifiedFixture();
    const manifest = parseClientReuseManifestHeader(
      JSON.stringify(
        createClientReuseManifest({
          entries: [fixture.entry],
          visibleCommitVersion: 1,
        }),
      ),
    );

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      verifyEntry(entry) {
        const verified = crossCheckClientReuseManifestEntryWithCache({
          artifact: fixture.artifact,
          cacheDecision: fixture.decision,
          entry,
        });
        if (verified.kind !== "verified") {
          throw new Error("Expected fixture entry to verify");
        }
        // Buggy verifier: returns a verified result for a different entry.
        return {
          ...verified,
          entryId: "layout:/billing",
        };
      },
    });

    expect(plan).toMatchObject({
      kind: "renderAndSend",
      skippedEntryIds: [],
      entryRejections: [
        {
          code: "SKIP_CACHE_ENTRY_ID_MISMATCH",
          entryId: "layout:/dashboard",
          fields: {
            verifierEntryId: "layout:/billing",
            manifestEntryId: "layout:/dashboard",
          },
        },
      ],
    });
  });

  it("falls back without verifier work for oversized manifests", () => {
    const manifest = parseClientReuseManifestHeader('{"entries":[]}', {
      limits: { ...DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS, maxManifestBytes: 8 },
    });
    let verifierCalled = false;

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      verifyEntry() {
        verifierCalled = true;
        throw new Error("oversized manifests must not enter skip verification");
      },
    });

    expect(verifierCalled).toBe(false);
    expect(plan).toEqual({
      kind: "renderAndSend",
      entryRejections: [],
      manifestRejection: {
        code: "SKIP_MANIFEST_TOO_LARGE",
        fields: {
          manifestBytes: 14,
          maxManifestBytes: 8,
        },
      },
      skipDisposition: {
        code: "SKIP_MODEL_DISABLED",
        enabled: false,
        mode: "renderAndSend",
      },
      skipIneligibleEntryIds: [],
      skippedEntryIds: [],
    });
  });

  it("falls back without verifier work when verification would exceed the local budget", () => {
    const fixture = createVerifiedFixture();
    const manifest = parseClientReuseManifestHeader(
      JSON.stringify(
        createClientReuseManifest({
          entries: [
            fixture.entry,
            createManifestEntry({
              artifactCompatibility: fixture.artifact.compatibility,
              id: "layout:/profile",
              payloadHash: fixture.entry.payloadHash,
              variantCacheKey: fixture.decision.proof.variant.cacheKey,
            }),
          ],
          visibleCommitVersion: 1,
        }),
      ),
    );
    let verifierCalled = false;

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      maxWireEntriesToVerify: 1,
      verifyEntry() {
        verifierCalled = true;
        throw new Error("over-budget manifests must not enter skip verification");
      },
    });

    expect(verifierCalled).toBe(false);
    expect(plan).toMatchObject({
      kind: "renderAndSend",
      manifestRejection: {
        code: "SKIP_VERIFICATION_BUDGET_EXCEEDED",
        fields: {
          totalWireEntries: 2,
          maxWireEntriesToVerify: 1,
        },
      },
      skippedEntryIds: [],
    });
  });

  it("throws for invalid local verification budgets", () => {
    const fixture = createVerifiedFixture();
    const manifest = parseClientReuseManifestHeader(
      JSON.stringify(
        createClientReuseManifest({
          entries: [fixture.entry],
          visibleCommitVersion: 1,
        }),
      ),
    );

    expect(() =>
      createClientReuseSkipTransportPlan({
        manifest,
        maxWireEntriesToVerify: -1,
        verifyEntry() {
          throw new Error("invalid budgets must fail before verification");
        },
      }),
    ).toThrow("maxWireEntriesToVerify must be a non-negative safe integer");
  });

  it("falls back without verifier work for absent manifests", () => {
    const manifest = parseClientReuseManifestHeader(null);
    let verifierCalled = false;

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      verifyEntry() {
        verifierCalled = true;
        throw new Error("absent manifests must not enter skip verification");
      },
    });

    expect(verifierCalled).toBe(false);
    expect(plan).toEqual({
      kind: "renderAndSend",
      entryRejections: [],
      skipDisposition: {
        code: "SKIP_MODEL_DISABLED",
        enabled: false,
        mode: "renderAndSend",
      },
      skipIneligibleEntryIds: [],
      skippedEntryIds: [],
    });
  });

  it("falls back without verifier work when malicious entries all reject at parse time", () => {
    const manifest = parseClientReuseManifestHeader(
      JSON.stringify(
        createClientReuseManifest({
          entries: [
            {
              artifactCompatibility: createCompatibility(),
              id: "layout:/account",
              payloadHash: createClientReusePayloadHash("account"),
              privacy: "private",
              variantCacheKey: "cp1:account",
            },
            {
              artifactCompatibility: createCompatibility(),
              id: "opaque:future-entry",
              payloadHash: createClientReusePayloadHash("future"),
              privacy: "public",
              variantCacheKey: "cp1:future",
            },
          ],
          visibleCommitVersion: 1,
        }),
      ),
    );
    let verifierCalled = false;

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      verifyEntry() {
        verifierCalled = true;
        throw new Error("parse-rejected entries must not enter skip verification");
      },
    });

    expect(verifierCalled).toBe(false);
    expect(plan).toMatchObject({
      kind: "renderAndSend",
      entryRejections: [
        { code: "SKIP_PRIVATE_ENTRY", entryId: "layout:/account" },
        { code: "SKIP_UNKNOWN_ENTRY", entryId: "opaque:future-entry" },
      ],
      skippedEntryIds: [],
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

  it("verifies canary and rollback skip hints without enabling transport skips", () => {
    const rollbackCompatibility = createCompatibility({
      deploymentVersion: "deploy-rollback",
    });
    const fixture = createVerifiedFixture({ artifactCompatibility: rollbackCompatibility });

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      compatibilityMap: {
        deploymentVersions: [["deploy-stable", "deploy-canary", "deploy-rollback"]],
      },
      entry: {
        ...fixture.entry,
        artifactCompatibility: createCompatibility({
          deploymentVersion: "deploy-canary",
        }),
      },
    });

    expect(result).toMatchObject({
      code: "SKIP_CACHE_CROSS_CHECK_PASSED",
      entryId: "layout:/dashboard",
      kind: "verified",
      skipDisposition: {
        enabled: false,
        mode: "renderAndSend",
      },
    });
  });

  it("rejects canary and rollback skip hints when the compatibility map is stale", () => {
    const rollbackCompatibility = createCompatibility({
      deploymentVersion: "deploy-rollback",
    });
    const fixture = createVerifiedFixture({ artifactCompatibility: rollbackCompatibility });

    const result = crossCheckClientReuseManifestEntryWithCache({
      artifact: fixture.artifact,
      cacheDecision: fixture.decision,
      compatibilityMap: {
        deploymentVersions: [["deploy-stable", "deploy-canary"]],
      },
      entry: {
        ...fixture.entry,
        artifactCompatibility: createCompatibility({
          deploymentVersion: "deploy-canary",
        }),
      },
    });

    expect(result).toMatchObject({
      kind: "rejected",
      rejection: {
        code: "SKIP_CACHE_ARTIFACT_COMPATIBILITY_INCOMPATIBLE",
        entryId: "layout:/dashboard",
        fields: {
          compatibilityFallback: "renderFresh",
          reason: "deploymentVersionNotDeclaredCompatible",
        },
      },
      skipDisposition: {
        enabled: false,
        mode: "renderAndSend",
      },
    });
  });

  it("builds a renderAndSend plan for compatibility-bridged entries that pass cross-check but fail exact equality", () => {
    const rollbackCompatibility = createCompatibility({
      deploymentVersion: "deploy-rollback",
    });
    const fixture = createVerifiedFixture({ artifactCompatibility: rollbackCompatibility });
    const manifest = parseClientReuseManifestHeader(
      JSON.stringify(
        createClientReuseManifest({
          entries: [
            {
              ...fixture.entry,
              artifactCompatibility: createCompatibility({
                deploymentVersion: "deploy-canary",
              }),
            },
          ],
          visibleCommitVersion: 1,
        }),
      ),
    );
    let verifierCalled = false;

    const plan = createClientReuseSkipTransportPlan({
      manifest,
      verifyEntry(entry) {
        verifierCalled = true;
        return crossCheckClientReuseManifestEntryWithCache({
          artifact: fixture.artifact,
          cacheDecision: fixture.decision,
          compatibilityMap: {
            deploymentVersions: [["deploy-stable", "deploy-canary", "deploy-rollback"]],
          },
          entry,
        });
      },
    });

    expect(verifierCalled).toBe(true);
    expect(plan).toMatchObject({
      kind: "renderAndSend",
      skipIneligibleEntryIds: ["layout:/dashboard"],
      skippedEntryIds: [],
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
