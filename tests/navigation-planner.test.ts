import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
} from "../packages/vinext/src/server/navigation-trace.js";
import {
  navigationPlanner,
  type FlightResult,
  type MountedParallelSlotSnapshot,
  type NavigationDecision,
  type NavigationEvent,
  type NavigationPlannerInput,
  type NavigationPlannerState,
  type OperationToken,
  type ParallelSlotBindingSnapshot,
  type RefreshScope,
  type RouteSnapshot,
  type InterceptionSnapshot,
  type RootBoundaryTransition,
} from "../packages/vinext/src/server/navigation-planner.js";
import type {
  GraphVersion,
  RootBoundaryId,
  RouteManifest,
  RouteManifestInterception,
  RouteManifestRoute,
  RouteManifestRootBoundary,
  RouteManifestSlotBinding,
  StaticSegmentGraph,
} from "../packages/vinext/src/routing/app-route-graph.js";
import {
  createCacheEntryReuseProof,
  type CacheEntryReuseProof,
} from "../packages/vinext/src/server/cache-proof.js";

type TestManifestRoute = {
  id?: string;
  layoutIds: readonly string[];
  pattern: string;
  patternParts?: readonly string[];
  rootBoundaryId: string | null;
  slotBindings?: readonly ParallelSlotBindingSnapshot[];
  interceptions?: readonly TestManifestInterception[];
};

type TestManifestInterception = {
  sourcePattern: string;
  targetPattern: string;
  slotId: string;
  ownerLayoutId: string | null;
};

function createRouteSnapshot(
  rootBoundaryId: string | null,
  layoutIds: readonly string[] = rootBoundaryId === null ? [] : [`layout:${rootBoundaryId}`],
  mountedParallelSlots: readonly MountedParallelSlotSnapshot[] = [],
  slotBindings: readonly ParallelSlotBindingSnapshot[] = [],
): RouteSnapshot {
  return {
    displayUrl: "https://example.com/dashboard",
    interception: null,
    interceptionContext: null,
    layoutIds,
    matchedUrl: "/dashboard",
    mountedParallelSlots,
    rootBoundaryId,
    routeId: "route:/dashboard",
    slotBindings,
  };
}

function createInterceptionSnapshot(
  overrides: Partial<InterceptionSnapshot> = {},
): InterceptionSnapshot {
  return {
    sourceMatchedUrl: "/feed",
    sourceRouteId: "route:/feed",
    slotId: "slot:modal:/feed",
    targetMatchedUrl: "/photos/42",
    targetRouteId: "route:/photos/42",
    ...overrides,
  };
}

function createAcceptedStaticLayoutCacheEntryReuseProof(): CacheEntryReuseProof {
  return {
    kind: "runtime-cache-entry",
    decision: {
      canReuse: true,
      code: "CP_STATIC_LAYOUT_REUSE_PROVEN",
      kind: "reuse",
      reuseClass: "static-layout",
    },
  };
}

function createSlotBinding(
  slotId: string,
  ownerLayoutId: string,
  state: ParallelSlotBindingSnapshot["state"] = "active",
): ParallelSlotBindingSnapshot {
  return { ownerLayoutId, slotId, state };
}

function createTestRouteManifest(routes: readonly TestManifestRoute[]): RouteManifest {
  const manifestRoutes = new Map<string, RouteManifestRoute>();
  const slotBindings = new Map<string, RouteManifestSlotBinding>();
  const interceptions = new Map<string, RouteManifestInterception>();
  const interceptionsBySlotId = new Map<string, RouteManifestInterception[]>();
  const rootBoundaries = new Map<RootBoundaryId, RouteManifestRootBoundary>();
  const routeIdByPattern = new Map(
    routes.map((route) => [route.pattern, route.id ?? `route:${route.pattern}`]),
  );

  for (const route of routes) {
    const routeId = routeIdByPattern.get(route.pattern) ?? `route:${route.pattern}`;
    const rootBoundaryId =
      route.rootBoundaryId === null ? null : (route.rootBoundaryId as RootBoundaryId);
    const routeSlotBindings = route.slotBindings ?? [];
    const slotIds = routeSlotBindings.map((binding) => binding.slotId).sort();
    const patternParts =
      route.patternParts ?? route.pattern.split("/").filter((segment) => segment.length > 0);
    manifestRoutes.set(routeId, {
      id: routeId,
      isDynamic: patternParts.some((part) => part.startsWith(":")),
      layoutIds: route.layoutIds,
      pageId: null,
      paramNames: patternParts
        .filter((part) => part.startsWith(":"))
        .map((part) => part.replace(/^:/, "").replace(/[+*]$/, "")),
      pattern: route.pattern,
      patternParts,
      rootBoundaryId,
      rootParamNames: [],
      routeHandlerId: null,
      slotIds,
      templateIds: [],
    });

    for (const binding of routeSlotBindings) {
      slotBindings.set(`${routeId}::${binding.slotId}`, {
        defaultId: binding.state === "default" ? `default:${binding.slotId}` : null,
        id: `${routeId}::${binding.slotId}`,
        ownerLayoutId: binding.ownerLayoutId,
        routeId,
        routeSegments: null,
        slotId: binding.slotId,
        state: binding.state,
      });
    }

    for (const interception of route.interceptions ?? []) {
      const targetPatternParts = interception.targetPattern
        .split("/")
        .filter((segment) => segment.length > 0);
      const id = `interception:${interception.slotId}:${interception.sourcePattern}->${interception.targetPattern}`;
      const manifestInterception = {
        id,
        interceptingRouteId: routeIdByPattern.get(interception.sourcePattern) ?? null,
        ownerLayoutId: interception.ownerLayoutId,
        slotId: interception.slotId,
        sourcePattern: interception.sourcePattern,
        sourcePatternParts: interception.sourcePattern
          .split("/")
          .filter((segment) => segment.length > 0),
        targetPattern: interception.targetPattern,
        targetPatternParts,
        targetRouteId: routeIdByPattern.get(interception.targetPattern) ?? null,
      };
      interceptions.set(id, manifestInterception);
      const slotInterceptions = interceptionsBySlotId.get(interception.slotId);
      if (slotInterceptions) {
        slotInterceptions.push(manifestInterception);
      } else {
        interceptionsBySlotId.set(interception.slotId, [manifestInterception]);
      }
    }

    const rootLayoutId = route.layoutIds[0];
    if (rootBoundaryId !== null && rootLayoutId !== undefined) {
      rootBoundaries.set(rootBoundaryId, {
        id: rootBoundaryId,
        layoutId: rootLayoutId,
        treePath: route.rootBoundaryId?.replace(/^root-boundary:/, "") ?? "/",
      });
    }
  }

  const segmentGraph: StaticSegmentGraph = {
    boundaries: new Map(),
    defaults: new Map(),
    interceptions,
    interceptionsBySlotId,
    layouts: new Map(),
    pages: new Map(),
    rootBoundaries,
    routeHandlers: new Map(),
    routes: manifestRoutes,
    slotBindings,
    slots: new Map(),
    templates: new Map(),
  };

  return {
    graphVersion: "graph:test" as GraphVersion,
    segmentGraph,
  };
}

function rootBoundaryIdForManifest(rootBoundaryId: string | null): string | null {
  return rootBoundaryId === null ? null : `root-boundary:${rootBoundaryId}`;
}

function createRouteManifestForSnapshots(
  currentSnapshot: RouteSnapshot,
  targetSnapshot: RouteSnapshot,
): RouteManifest {
  if (targetSnapshot.interception !== null) {
    const proof = targetSnapshot.interception;
    const routes: TestManifestRoute[] = [
      {
        id: currentSnapshot.routeId,
        layoutIds: currentSnapshot.layoutIds,
        pattern: currentSnapshot.matchedUrl,
        rootBoundaryId: rootBoundaryIdForManifest(currentSnapshot.rootBoundaryId),
      },
    ];
    if (
      proof.sourceRouteId !== currentSnapshot.routeId ||
      proof.sourceMatchedUrl !== currentSnapshot.matchedUrl
    ) {
      routes.push({
        id: proof.sourceRouteId,
        layoutIds: targetSnapshot.layoutIds,
        pattern: proof.sourceMatchedUrl,
        rootBoundaryId: rootBoundaryIdForManifest(targetSnapshot.rootBoundaryId),
      });
    }
    routes.push(
      {
        id: proof.sourceRouteId,
        interceptions: [
          {
            ownerLayoutId:
              targetSnapshot.slotBindings.find((binding) => binding.slotId === proof.slotId)
                ?.ownerLayoutId ?? null,
            slotId: proof.slotId,
            sourcePattern: proof.sourceMatchedUrl,
            targetPattern: proof.targetMatchedUrl,
          },
        ],
        layoutIds: currentSnapshot.layoutIds,
        pattern: proof.sourceMatchedUrl,
        rootBoundaryId: rootBoundaryIdForManifest(currentSnapshot.rootBoundaryId),
        slotBindings: targetSnapshot.slotBindings,
      },
      {
        id: proof.targetRouteId,
        layoutIds: targetSnapshot.layoutIds,
        pattern: proof.targetMatchedUrl,
        rootBoundaryId: rootBoundaryIdForManifest(targetSnapshot.rootBoundaryId),
      },
    );
    return createTestRouteManifest(routes);
  }

  return createTestRouteManifest([
    {
      id: currentSnapshot.routeId,
      layoutIds: currentSnapshot.layoutIds,
      pattern: currentSnapshot.matchedUrl,
      rootBoundaryId: rootBoundaryIdForManifest(currentSnapshot.rootBoundaryId),
      slotBindings: currentSnapshot.slotBindings,
    },
    {
      id: targetSnapshot.routeId,
      layoutIds: targetSnapshot.layoutIds,
      pattern: targetSnapshot.matchedUrl,
      rootBoundaryId: rootBoundaryIdForManifest(targetSnapshot.rootBoundaryId),
      slotBindings: targetSnapshot.slotBindings,
    },
  ]);
}

function createOperationToken(overrides: Partial<OperationToken> = {}): OperationToken {
  return {
    baseVisibleCommitVersion: 2,
    deploymentVersion: null,
    graphVersion: null,
    lane: "navigation",
    navigationId: 1,
    operationId: 7,
    targetSnapshotFingerprint: "route:/dashboard|root:/",
    ...overrides,
  };
}

function createRejectedCacheEntryReuseProof(
  code: "CP_ARTIFACT_COMPATIBILITY_INCOMPATIBLE" | "CP_ROUTE_VARIANT_CEILING_EXCEEDED",
): CacheEntryReuseProof {
  return {
    kind: "runtime-cache-entry",
    decision: {
      canReuse: false,
      code,
      kind: "reject",
      mode: code === "CP_ROUTE_VARIANT_CEILING_EXCEEDED" ? "privateUncacheable" : "renderFresh",
      scope: code === "CP_ROUTE_VARIANT_CEILING_EXCEEDED" ? "route" : "affectedOutput",
    },
  };
}

function planFlightResponse(rootBoundaryId: string | null): NavigationDecision {
  const token = createOperationToken({
    targetSnapshotFingerprint: `route:/dashboard|root:${rootBoundaryId ?? "unknown"}`,
  });
  const routeManifest = createTestRouteManifest([
    {
      layoutIds: ["layout:/"],
      pattern: "/current",
      rootBoundaryId: "root-boundary:/",
    },
    {
      layoutIds: rootBoundaryId === null ? [] : [`layout:${rootBoundaryId}`],
      pattern: "/dashboard",
      rootBoundaryId: rootBoundaryId === null ? null : `root-boundary:${rootBoundaryId}`,
    },
  ]);
  const result: FlightResult = {
    href: "https://example.com/dashboard",
    targetSnapshot: {
      ...createRouteSnapshot(rootBoundaryId),
      matchedUrl: "/dashboard",
      routeId: "route:/dashboard",
    },
  };
  const state: NavigationPlannerState = {
    nextOperationToken: token,
    traceFields: {
      currentRootLayoutTreePath: "/",
      currentVisibleCommitVersion: 2,
      nextRootLayoutTreePath: rootBoundaryId,
      startedVisibleCommitVersion: 2,
    },
    visibleCommitVersion: 2,
    visibleSnapshot: {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/current",
      matchedUrl: "/current",
      routeId: "route:/current",
    },
  };
  const event: NavigationEvent = {
    kind: "flightResponseArrived",
    result,
    token,
  };
  const input: NavigationPlannerInput = {
    event,
    routeManifest,
    state,
  };

  return navigationPlanner.plan(input);
}

function planFlightResponseFromRootBoundaries(options: {
  currentRootBoundaryId: string | null;
  nextRootBoundaryId: string | null;
}): NavigationDecision {
  const token = createOperationToken({
    targetSnapshotFingerprint: `route:/dashboard|root:${options.nextRootBoundaryId ?? "unknown"}`,
  });

  const routeManifest = createTestRouteManifest([
    {
      layoutIds:
        options.currentRootBoundaryId === null ? [] : [`layout:${options.currentRootBoundaryId}`],
      pattern: "/current",
      rootBoundaryId:
        options.currentRootBoundaryId === null
          ? null
          : `root-boundary:${options.currentRootBoundaryId}`,
    },
    {
      layoutIds:
        options.nextRootBoundaryId === null ? [] : [`layout:${options.nextRootBoundaryId}`],
      pattern: "/dashboard",
      rootBoundaryId:
        options.nextRootBoundaryId === null ? null : `root-boundary:${options.nextRootBoundaryId}`,
    },
  ]);

  return navigationPlanner.plan({
    event: {
      kind: "flightResponseArrived",
      result: {
        href: "https://example.com/dashboard",
        targetSnapshot: {
          ...createRouteSnapshot(options.nextRootBoundaryId),
          matchedUrl: "/dashboard",
          routeId: "route:/dashboard",
        },
      },
      token,
    },
    routeManifest,
    state: {
      nextOperationToken: token,
      traceFields: {
        currentRootLayoutTreePath: options.currentRootBoundaryId,
        currentVisibleCommitVersion: 2,
        nextRootLayoutTreePath: options.nextRootBoundaryId,
        startedVisibleCommitVersion: 2,
      },
      visibleCommitVersion: 2,
      visibleSnapshot: {
        ...createRouteSnapshot(options.currentRootBoundaryId),
        displayUrl: "https://example.com/current",
        matchedUrl: "/current",
        routeId: "route:/current",
      },
    },
  });
}

function planFlightResponseFromSnapshots(options: {
  cacheEntryReuseProof?: CacheEntryReuseProof;
  currentSnapshot: RouteSnapshot;
  lane?: OperationToken["lane"];
  routeManifest?: RouteManifest | null;
  targetSnapshot: RouteSnapshot;
  tokenGraphVersion?: string | null;
  traceFields?: NavigationPlannerState["traceFields"];
}): NavigationDecision {
  const token = createOperationToken({
    lane: options.lane ?? "navigation",
    ...(options.tokenGraphVersion !== undefined ? { graphVersion: options.tokenGraphVersion } : {}),
    targetSnapshotFingerprint: `${options.targetSnapshot.routeId}|root:${
      options.targetSnapshot.rootBoundaryId ?? "unknown"
    }`,
  });

  return navigationPlanner.plan({
    event: {
      kind: "flightResponseArrived",
      result: {
        ...(options.cacheEntryReuseProof
          ? { cacheEntryReuseProof: options.cacheEntryReuseProof }
          : {}),
        href: options.targetSnapshot.displayUrl,
        targetSnapshot: options.targetSnapshot,
      },
      token,
    },
    routeManifest:
      options.routeManifest === undefined
        ? createRouteManifestForSnapshots(options.currentSnapshot, options.targetSnapshot)
        : options.routeManifest,
    state: {
      nextOperationToken: token,
      traceFields: options.traceFields,
      visibleCommitVersion: 2,
      visibleSnapshot: options.currentSnapshot,
    },
  });
}

describe("navigationPlanner root-boundary decisions", () => {
  // Root-layout MPA semantics match Next.js coverage:
  // .nextjs-ref/test/e2e/app-dir/root-layout/root-layout.test.ts
  // .nextjs-ref/test/e2e/app-dir/segment-cache/mpa-navigations/mpa-navigations.test.ts
  it("proposes a visible commit for same-root flight responses", () => {
    const decision = planFlightResponse("/");

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preserveAbsentSlots).toBe(false);
    expect(decision.proposal.targetSnapshot.rootBoundaryId).toBe("/");
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/"]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
    expect(decision.trace).toEqual({
      schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
      entries: [
        {
          code: NavigationTraceReasonCodes.commitCurrent,
          fields: {
            currentRootLayoutTreePath: "/",
            currentVisibleCommitVersion: 2,
            nextRootLayoutTreePath: "/",
            startedVisibleCommitVersion: 2,
          },
        },
      ],
    });
  });

  it("rejects runtime cache entries when the cache proof is missing", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/profile",
      matchedUrl: "/dashboard/profile",
      routeId: "route:/dashboard/profile",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };

    const decision = planFlightResponseFromSnapshots({
      cacheEntryReuseProof: createCacheEntryReuseProof(null),
      currentSnapshot,
      targetSnapshot,
    });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected cache proof rejection to hard navigate");
    }
    expect(decision.reason).toBe("cacheProofRejected");
    expect(decision.url).toBe("https://example.com/dashboard/settings");
    expect(decision.trace.entries).toEqual([
      {
        code: NavigationTraceReasonCodes.cacheProofRejected,
        fields: {
          cacheProofCode: "CP_CACHE_ENTRY_PROOF_MISSING",
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 2,
          nextRootLayoutTreePath: "/",
          startedVisibleCommitVersion: 2,
        },
      },
    ]);
  });

  it("rejects incompatible runtime cache entries before route-topology commit approval", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/profile",
      matchedUrl: "/dashboard/profile",
      routeId: "route:/dashboard/profile",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };

    const decision = planFlightResponseFromSnapshots({
      cacheEntryReuseProof: createRejectedCacheEntryReuseProof(
        "CP_ARTIFACT_COMPATIBILITY_INCOMPATIBLE",
      ),
      currentSnapshot,
      targetSnapshot,
    });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected incompatible cache entry to hard navigate");
    }
    expect(decision.reason).toBe("cacheProofRejected");
    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.cacheProofRejected,
      fields: {
        cacheProofCode: "CP_ARTIFACT_COMPATIBILITY_INCOMPATIBLE",
        cacheProofMode: "renderFresh",
        cacheProofScope: "affectedOutput",
        currentRootLayoutTreePath: "/",
        currentVisibleCommitVersion: 2,
        nextRootLayoutTreePath: "/",
        startedVisibleCommitVersion: 2,
      },
    });
  });

  it("keeps accepted runtime cache proof visible on the commit proposal", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/profile",
      matchedUrl: "/dashboard/profile",
      routeId: "route:/dashboard/profile",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };
    const cacheEntryReuseProof = createAcceptedStaticLayoutCacheEntryReuseProof();

    const decision = planFlightResponseFromSnapshots({
      cacheEntryReuseProof,
      currentSnapshot,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proven cache entry to remain committable");
    }
    expect(decision.proposal.cacheEntryReuseDecision).toEqual(cacheEntryReuseProof.decision);
    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.commitCurrent,
      fields: {
        cacheProofCode: "CP_STATIC_LAYOUT_REUSE_PROVEN",
        cacheProofReuseClass: "static-layout",
        currentRootLayoutTreePath: "/",
        currentVisibleCommitVersion: 2,
        nextRootLayoutTreePath: "/",
        startedVisibleCommitVersion: 2,
      },
    });
  });

  it("hard navigates a proven cache entry whose token graph version no longer matches the route graph", () => {
    // Commits and cache reuse share the OperationToken authority: a proven cache
    // entry may only be reused under the graph version it was produced for. A
    // token minted under a stale graph version must not reuse a cache entry
    // against a newer route graph — it hard navigates and refetches.
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/profile",
      matchedUrl: "/dashboard/profile",
      routeId: "route:/dashboard/profile",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };

    const decision = planFlightResponseFromSnapshots({
      cacheEntryReuseProof: createAcceptedStaticLayoutCacheEntryReuseProof(),
      currentSnapshot,
      targetSnapshot,
      // The test manifest declares graphVersion "graph:test".
      tokenGraphVersion: "graph:stale",
    });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected a stale-graph cache reuse to hard navigate");
    }
    expect(decision.reason).toBe("cacheReuseTokenRejected");
    expect(decision.url).toBe("https://example.com/dashboard/settings");
    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.cacheReuseTokenRejected,
      fields: {
        cacheReuseTokenReason: "graphVersionMismatch",
        currentRootLayoutTreePath: "/",
        currentVisibleCommitVersion: 2,
        nextRootLayoutTreePath: "/",
        startedVisibleCommitVersion: 2,
      },
    });
  });

  it("commits a proven cache entry when its token graph version still matches the route graph", () => {
    // The cache-reuse token gate must not disturb the normal proven-reuse path:
    // a token minted under the installed graph version commits as before.
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/profile",
      matchedUrl: "/dashboard/profile",
      routeId: "route:/dashboard/profile",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };

    const decision = planFlightResponseFromSnapshots({
      cacheEntryReuseProof: createAcceptedStaticLayoutCacheEntryReuseProof(),
      currentSnapshot,
      targetSnapshot,
      tokenGraphVersion: "graph:test",
    });

    expect(decision.kind).toBe("proposeCommit");
  });

  it("hard-navigates cross-root flight responses", () => {
    const transition: RootBoundaryTransition = navigationPlanner.classifyRootBoundaryTransition(
      "/",
      "/(dashboard)",
    );
    const decision = planFlightResponse("/(dashboard)");

    expect(transition).toBe("rootBoundaryChanged");
    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("rootBoundaryChanged");
    expect(decision.url).toBe("https://example.com/dashboard");
    expect(decision.trace.entries).toEqual([
      {
        code: NavigationTraceReasonCodes.rootBoundaryChanged,
        fields: {
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 2,
          nextRootLayoutTreePath: "/(dashboard)",
          startedVisibleCommitVersion: 2,
        },
      },
    ]);
  });

  it("keeps accepted runtime cache proof fields on later root-boundary rejections", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/"),
      displayUrl: "https://example.com/current",
      matchedUrl: "/current",
      routeId: "route:/current",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/(dashboard)"),
      displayUrl: "https://example.com/dashboard",
      matchedUrl: "/dashboard",
      routeId: "route:/dashboard",
    };

    const decision = planFlightResponseFromSnapshots({
      cacheEntryReuseProof: createAcceptedStaticLayoutCacheEntryReuseProof(),
      currentSnapshot,
      targetSnapshot,
    });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("rootBoundaryChanged");
    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.rootBoundaryChanged,
      fields: {
        cacheProofCode: "CP_STATIC_LAYOUT_REUSE_PROVEN",
        cacheProofReuseClass: "static-layout",
        currentRootLayoutTreePath: "/",
        currentVisibleCommitVersion: 2,
        nextRootLayoutTreePath: "/(dashboard)",
        startedVisibleCommitVersion: 2,
      },
    });
  });

  it("uses an unproven payload fallback when the target root identity is unknown", () => {
    const decision = planFlightResponse(null);

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("unprovenTopologyFallback");
    expect(decision.proposal.preserveAbsentSlots).toBe(false);
    expect(decision.proposal.preserveElementIds).toEqual([]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.rootBoundaryUnknown);
  });

  it("uses an unproven payload fallback when the visible root identity is unknown", () => {
    const transition = navigationPlanner.classifyRootBoundaryTransition(null, "/");
    const decision = planFlightResponseFromRootBoundaries({
      currentRootBoundaryId: null,
      nextRootBoundaryId: "/",
    });

    expect(transition).toBe("rootBoundaryUnknown");
    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("unprovenTopologyFallback");
    expect(decision.proposal.preserveAbsentSlots).toBe(false);
    expect(decision.proposal.preserveElementIds).toEqual([]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.rootBoundaryUnknown);
  });

  it("preserves only the common same-root layout ancestor prefix", () => {
    const currentSnapshot = createRouteSnapshot("/", [
      "layout:/",
      "layout:/dashboard",
      "layout:/dashboard/settings",
    ]);
    const targetSnapshot = createRouteSnapshot("/", [
      "layout:/",
      "layout:/dashboard",
      "layout:/dashboard/profile",
    ]);

    expect(
      navigationPlanner.resolveSameLayoutAncestorPersistence(currentSnapshot, targetSnapshot),
    ).toEqual(["layout:/", "layout:/dashboard"]);
  });

  it("preserves mounted parallel slots owned by approved same-layout ancestors", () => {
    // Mirrors Next.js mounted parallel route preservation covered by:
    // .nextjs-ref/test/e2e/app-dir/parallel-routes-and-interception-catchall/parallel-routes-and-interception-catchall.test.ts
    const currentSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/feed"],
      [
        { ownerLayoutId: "layout:/feed", slotId: "slot:modal:/feed" },
        { ownerLayoutId: "layout:/other", slotId: "slot:stale:/other" },
      ],
    );
    const targetSnapshot = createRouteSnapshot("/", [
      "layout:/",
      "layout:/feed",
      "layout:/feed/comments",
    ]);

    expect(
      navigationPlanner.resolveMountedParallelSlotPersistence(currentSnapshot, targetSnapshot),
    ).toEqual(["slot:modal:/feed"]);
    expect(
      navigationPlanner.resolveCurrentRootBoundaryElementPersistence(
        currentSnapshot,
        targetSnapshot,
      ),
    ).toEqual(["layout:/", "layout:/feed", "slot:modal:/feed"]);
  });

  it("does not preserve mounted parallel slots when their owner layout is not retained", () => {
    const currentSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/feed"],
      [{ ownerLayoutId: "layout:/feed", slotId: "slot:modal:/feed" }],
    );
    const targetSnapshot = createRouteSnapshot("/", ["layout:/", "layout:/settings"]);

    expect(
      navigationPlanner.resolveMountedParallelSlotPersistence(currentSnapshot, targetSnapshot),
    ).toEqual([]);
    expect(
      navigationPlanner.resolveCurrentRootBoundaryElementPersistence(
        currentSnapshot,
        targetSnapshot,
      ),
    ).toEqual(["layout:/"]);
  });

  it("does not approve mounted parallel slot preservation for traverse commits", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [{ ownerLayoutId: "layout:/feed", slotId: "slot:modal:/feed" }],
      ),
      displayUrl: "https://example.com/feed",
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed", "layout:/feed/comments"]),
      displayUrl: "https://example.com/feed/comments",
      matchedUrl: "/feed/comments",
      routeId: "route:/feed/comments",
    };
    const token = createOperationToken({
      lane: "traverse",
      targetSnapshotFingerprint: "route:/feed/comments|root:/",
    });

    const decision = navigationPlanner.plan({
      event: {
        kind: "flightResponseArrived",
        result: {
          href: "https://example.com/feed/comments",
          targetSnapshot,
        },
        token,
      },
      routeManifest: createRouteManifestForSnapshots(currentSnapshot, targetSnapshot),
      state: {
        nextOperationToken: token,
        traceFields: {
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 2,
          nextRootLayoutTreePath: "/",
          startedVisibleCommitVersion: 2,
        },
        visibleCommitVersion: 2,
        visibleSnapshot: currentSnapshot,
      },
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preserveAbsentSlots).toBe(false);
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/", "layout:/feed"]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
  });

  it("preserves previous slot ids for default and unmatched target bindings", () => {
    // Mirrors Next.js default-slot reuse semantics:
    // .nextjs-ref/packages/next/src/client/components/router-reducer/ppr-navigations.ts
    const currentSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard"],
      [],
      [
        createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "active"),
        createSlotBinding("slot:analytics:/dashboard", "layout:/dashboard", "default"),
        createSlotBinding("slot:reports:/dashboard", "layout:/dashboard", "active"),
      ],
    );
    const targetSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
      [],
      [
        createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "default"),
        createSlotBinding("slot:analytics:/dashboard", "layout:/dashboard", "unmatched"),
        createSlotBinding("slot:reports:/dashboard", "layout:/dashboard", "active"),
      ],
    );
    const targetSettingsSnapshot: RouteSnapshot = {
      ...targetSnapshot,
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };
    const token = createOperationToken({
      targetSnapshotFingerprint: "route:/dashboard/settings|root:/",
    });

    const decision = navigationPlanner.plan({
      event: {
        kind: "flightResponseArrived",
        result: {
          href: "https://example.com/dashboard/settings",
          targetSnapshot: targetSettingsSnapshot,
        },
        token,
      },
      routeManifest: createRouteManifestForSnapshots(currentSnapshot, targetSettingsSnapshot),
      state: {
        nextOperationToken: token,
        traceFields: {
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 2,
          nextRootLayoutTreePath: "/",
          startedVisibleCommitVersion: 2,
        },
        visibleCommitVersion: 2,
        visibleSnapshot: currentSnapshot,
      },
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/", "layout:/dashboard"]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([
      "slot:analytics:/dashboard",
      "slot:team:/dashboard",
    ]);
  });

  it("does not preserve default or unmatched target slots without visible route-state proof", () => {
    const currentSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard"],
      [],
      [createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "active")],
    );
    const targetSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
      [],
      [
        createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "default"),
        createSlotBinding("slot:analytics:/dashboard", "layout:/dashboard", "unmatched"),
      ],
    );
    const targetSettingsSnapshot: RouteSnapshot = {
      ...targetSnapshot,
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };
    const token = createOperationToken({
      targetSnapshotFingerprint: "route:/dashboard/settings|root:/",
    });

    const decision = navigationPlanner.plan({
      event: {
        kind: "flightResponseArrived",
        result: {
          href: "https://example.com/dashboard/settings",
          targetSnapshot: targetSettingsSnapshot,
        },
        token,
      },
      routeManifest: createRouteManifestForSnapshots(currentSnapshot, targetSettingsSnapshot),
      state: {
        nextOperationToken: token,
        visibleCommitVersion: 2,
        visibleSnapshot: currentSnapshot,
      },
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preservePreviousSlotIds).toEqual(["slot:team:/dashboard"]);
  });

  it("does not preserve default target slots when their owner layout is not retained", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [createSlotBinding("slot:modal:/dashboard", "layout:/dashboard", "active")],
      ),
      displayUrl: "https://example.com/feed",
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard"],
      [],
      [createSlotBinding("slot:modal:/dashboard", "layout:/dashboard", "default")],
    );

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/"]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
  });

  it("does not preserve target slots when the current binding is unmatched", () => {
    const currentSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard"],
      [],
      [createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "unmatched")],
    );
    const targetSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
      [],
      [createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "default")],
    );

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
  });

  it("does not preserve active target slot bindings", () => {
    const currentSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard"],
      [],
      [createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "active")],
    );
    const targetSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
      [],
      [createSlotBinding("slot:team:/dashboard", "layout:/dashboard", "active")],
    );

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
  });

  it("uses RouteManifest root boundaries instead of stale snapshot roots", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/app"],
        pattern: "/app",
        rootBoundaryId: "root-boundary:/app",
      },
      {
        layoutIds: ["layout:/marketing"],
        pattern: "/marketing",
        rootBoundaryId: "root-boundary:/marketing",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/stale-app"]),
      matchedUrl: "/app",
      routeId: "route:/app",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/stale-app", "layout:/stale-marketing"]),
      displayUrl: "https://example.com/marketing",
      matchedUrl: "/marketing",
      routeId: "route:/marketing",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
      traceFields: {
        currentRootLayoutTreePath: "/",
        currentVisibleCommitVersion: 2,
        nextRootLayoutTreePath: "/",
        startedVisibleCommitVersion: 2,
      },
    });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("rootBoundaryChanged");
    expect(decision.trace.entries[0]?.fields.currentRootLayoutTreePath).toBe("/app");
    expect(decision.trace.entries[0]?.fields.nextRootLayoutTreePath).toBe("/marketing");
  });

  it("uses RouteManifest topology to commit when snapshot root identities are missing", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/dashboard"],
        pattern: "/dashboard",
        rootBoundaryId: "root-boundary:/",
      },
      {
        layoutIds: ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
        pattern: "/dashboard/settings",
        rootBoundaryId: "root-boundary:/",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      matchedUrl: "/dashboard",
      routeId: "route:/dashboard",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("currentRootBoundary");
    expect(decision.proposal.preserveAbsentSlots).toBe(false);
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/", "layout:/dashboard"]);
  });

  it("uses concrete route ids when middleware rewrites hide dynamic source params", () => {
    const slotId = "slot:modal:/interception-mw/:locale";
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/interception-mw/:locale"],
        pattern: "/interception-mw/:locale",
        rootBoundaryId: "root-boundary:/",
        slotBindings: [createSlotBinding(slotId, "layout:/interception-mw/:locale", "active")],
        interceptions: [
          {
            sourcePattern: "/interception-mw/:locale",
            targetPattern: "/interception-mw/:locale/:username/p/:id",
            slotId,
            ownerLayoutId: "layout:/interception-mw/:locale",
          },
        ],
      },
      {
        layoutIds: ["layout:/", "layout:/interception-mw/:locale"],
        pattern: "/interception-mw/:locale/:username/p/:id",
        rootBoundaryId: "root-boundary:/",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "root-boundary:/",
        ["layout:/", "layout:/interception-mw/:locale"],
        [{ ownerLayoutId: "layout:/interception-mw/:locale", slotId }],
        [createSlotBinding(slotId, "layout:/interception-mw/:locale", "active")],
      ),
      displayUrl: "https://example.com/interception-mw",
      matchedUrl: "/interception-mw",
      routeId: "route:/interception-mw/en",
    };
    const targetSnapshot: RouteSnapshot = {
      ...currentSnapshot,
      displayUrl: "https://example.com/interception-mw/foo/p/1",
      interception: {
        sourceMatchedUrl: "/interception-mw/en",
        sourceRouteId: "route:/interception-mw/en",
        slotId,
        targetMatchedUrl: "/interception-mw/en/foo/p/1",
        targetRouteId: "route:/interception-mw/en/foo/p/1",
      },
      interceptionContext: "/interception-mw/en",
      matchedUrl: "/interception-mw/en/foo/p/1",
      routeId: "route:/interception-mw/en",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
  });

  it("does not let stale manifest route IDs override the matched URL", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/app"],
        pattern: "/app",
        rootBoundaryId: "root-boundary:/app",
      },
      {
        layoutIds: ["layout:/marketing"],
        pattern: "/marketing",
        rootBoundaryId: "root-boundary:/marketing",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      displayUrl: "https://example.com/app",
      matchedUrl: "/app",
      routeId: "route:/app",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      displayUrl: "https://example.com/app",
      matchedUrl: "/app",
      routeId: "route:/marketing",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("currentRootBoundary");
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/app"]);
  });

  it("matches concrete dynamic URLs to manifest route patterns", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/blog"],
        pattern: "/blog/:slug",
        rootBoundaryId: "root-boundary:/",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      displayUrl: "https://example.com/blog/hello",
      matchedUrl: "/blog/hello",
      routeId: "route:/blog/hello",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      displayUrl: "https://example.com/blog/world",
      matchedUrl: "/blog/world",
      routeId: "route:/blog/world",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("currentRootBoundary");
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/", "layout:/blog"]);
  });

  it("uses manifest target slot bindings while keeping visible snapshot as content proof", () => {
    const modalSlot = "slot:modal:/dashboard";
    const staleSlot = "slot:stale:/dashboard";
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/dashboard"],
        pattern: "/dashboard",
        rootBoundaryId: "root-boundary:/",
      },
      {
        layoutIds: ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
        pattern: "/dashboard/settings",
        rootBoundaryId: "root-boundary:/",
        slotBindings: [createSlotBinding(modalSlot, "layout:/dashboard", "default")],
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        null,
        [],
        [],
        [
          createSlotBinding(modalSlot, "layout:/dashboard", "active"),
          createSlotBinding(staleSlot, "layout:/dashboard", "active"),
        ],
      ),
      matchedUrl: "/dashboard",
      routeId: "route:/dashboard",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        null,
        [],
        [],
        [createSlotBinding(staleSlot, "layout:/dashboard", "default")],
      ),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preservePreviousSlotIds).toEqual([modalSlot]);
  });

  it("does not use manifest current slots as visible content proof", () => {
    const modalSlot = "slot:modal:/dashboard";
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/dashboard"],
        pattern: "/dashboard",
        rootBoundaryId: "root-boundary:/",
        slotBindings: [createSlotBinding(modalSlot, "layout:/dashboard", "active")],
      },
      {
        layoutIds: ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
        pattern: "/dashboard/settings",
        rootBoundaryId: "root-boundary:/",
        slotBindings: [createSlotBinding(modalSlot, "layout:/dashboard", "default")],
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, [], [], []),
      matchedUrl: "/dashboard",
      routeId: "route:/dashboard",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, [], [], []),
      displayUrl: "https://example.com/dashboard/settings",
      matchedUrl: "/dashboard/settings",
      routeId: "route:/dashboard/settings",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
  });

  it("uses the manifest source route topology for intercepted payloads", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/feed"],
        pattern: "/feed",
        rootBoundaryId: "root-boundary:/",
        interceptions: [
          {
            ownerLayoutId: "layout:/feed",
            slotId: "slot:modal:/feed",
            sourcePattern: "/feed",
            targetPattern: "/photos/:id",
          },
        ],
      },
      {
        layoutIds: ["layout:/photos", "layout:/photos/photo"],
        pattern: "/photos/:id",
        rootBoundaryId: "root-boundary:/photos",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        null,
        [],
        [],
        [createSlotBinding("slot:modal:/feed", "layout:/feed", "active")],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("interceptedCurrentRootBoundary");
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/", "layout:/feed"]);
  });

  it("approves manifest-declared dynamic interception topology with concrete wire route ids", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/[locale]", "layout:/[locale]/feed"],
        pattern: "/:locale/feed",
        rootBoundaryId: "root-boundary:/",
        interceptions: [
          {
            ownerLayoutId: "layout:/[locale]/feed",
            slotId: "slot:modal:/[locale]/feed",
            sourcePattern: "/:locale/feed",
            targetPattern: "/:locale/photos/:id",
          },
        ],
      },
      {
        layoutIds: ["layout:/", "layout:/[locale]", "layout:/[locale]/photos"],
        pattern: "/:locale/photos/:id",
        rootBoundaryId: "root-boundary:/",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      matchedUrl: "/en/feed",
      routeId: "route:/en/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        null,
        [],
        [],
        [createSlotBinding("slot:modal:/[locale]/feed", "layout:/[locale]/feed", "active")],
      ),
      displayUrl: "https://example.com/en/photos/42",
      interception: createInterceptionSnapshot({
        sourceMatchedUrl: "/en/feed",
        sourceRouteId: "route:/en/feed",
        slotId: "slot:modal:/[locale]/feed",
        targetMatchedUrl: "/en/photos/42",
        targetRouteId: "route:/en/photos/42",
      }),
      interceptionContext: "/en/feed",
      matchedUrl: "/en/photos/42",
      routeId: "route:/en/photos/42\u0000/en/feed",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("interceptedCurrentRootBoundary");
    expect(decision.proposal.preserveElementIds).toEqual([
      "layout:/",
      "layout:/[locale]",
      "layout:/[locale]/feed",
    ]);
  });

  it("rejects intercepted preservation when RouteManifest does not declare the topology", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/feed"],
        pattern: "/feed",
        rootBoundaryId: "root-boundary:/",
      },
      {
        layoutIds: ["layout:/", "layout:/photos"],
        pattern: "/photos/:id",
        rootBoundaryId: "root-boundary:/",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        null,
        [],
        [],
        [createSlotBinding("slot:modal:/feed", "layout:/feed", "active")],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({
      cacheEntryReuseProof: createAcceptedStaticLayoutCacheEntryReuseProof(),
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("interceptionProofRejected");
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedRejectedUndeclaredTopology,
    );
    expect(decision.trace.entries[0]?.fields).toMatchObject({
      cacheProofCode: "CP_STATIC_LAYOUT_REUSE_PROVEN",
      cacheProofReuseClass: "static-layout",
    });
  });

  it("rejects intercepted preservation when RouteManifest declares a different slot owner", () => {
    const routeManifest = createTestRouteManifest([
      {
        layoutIds: ["layout:/", "layout:/feed", "layout:/other"],
        pattern: "/feed",
        rootBoundaryId: "root-boundary:/",
        interceptions: [
          {
            ownerLayoutId: "layout:/feed",
            slotId: "slot:modal:/feed",
            sourcePattern: "/feed",
            targetPattern: "/photos/:id",
          },
        ],
      },
      {
        layoutIds: ["layout:/", "layout:/photos"],
        pattern: "/photos/:id",
        rootBoundaryId: "root-boundary:/",
      },
    ]);
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(null, []),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        null,
        [],
        [],
        [createSlotBinding("slot:modal:/feed", "layout:/other", "active")],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      routeManifest,
      targetSnapshot,
    });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("interceptionProofRejected");
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedRejectedUndeclaredTopology,
    );
  });

  it("approves intercepted preservation only from explicit source and slot proof", () => {
    // Core-15 oracle, porting the visible behavior from Next.js:
    // test/e2e/app-dir/parallel-routes-and-interception-catchall/parallel-routes-and-interception-catchall.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception-catchall/parallel-routes-and-interception-catchall.test.ts
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [
          createSlotBinding("slot:modal:/feed", "layout:/feed", "default"),
          createSlotBinding("slot:activity:/feed", "layout:/feed", "active"),
        ],
      ),
      displayUrl: "https://example.com/feed",
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [
          createSlotBinding("slot:activity:/feed", "layout:/feed", "default"),
          createSlotBinding("slot:modal:/feed", "layout:/feed", "active"),
        ],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("interceptedCurrentRootBoundary");
    expect(decision.proposal.preserveAbsentSlots).toBe(false);
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/", "layout:/feed"]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual(["slot:activity:/feed"]);
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedCommitCurrent,
    );
  });

  it("does not treat legacy context-only payloads as intercepted preservation proof", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      displayUrl: "https://example.com/photos/42",
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("currentRootBoundary");
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/", "layout:/feed"]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.commitCurrent);
  });

  it("rejects intercepted preservation when the visible source route is stale", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/gallery"]),
      matchedUrl: "/gallery",
      routeId: "route:/gallery",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [createSlotBinding("slot:modal:/feed", "layout:/feed", "active")],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("interceptionProofRejected");
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedRejectedUnknownSource,
    );
  });

  it("rejects intercepted preservation when proof target does not match the rendered route", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [createSlotBinding("slot:modal:/feed", "layout:/feed", "active")],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot({ targetMatchedUrl: "/photos/99" }),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("interceptionProofRejected");
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedRejectedTargetMismatch,
    );
  });

  it("does not use intercepted snapshot root topology as preservation authority", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/marketing",
        ["layout:/marketing"],
        [],
        [createSlotBinding("slot:modal:/feed", "layout:/marketing", "active")],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("interceptionProofRejected");
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedRejectedMissingSlotProof,
    );
  });

  it("rejects intercepted preservation when the target slot is not proven active", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [createSlotBinding("slot:modal:/feed", "layout:/feed", "default")],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({ currentSnapshot, targetSnapshot });

    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") {
      throw new Error("Expected hardNavigate decision");
    }
    expect(decision.reason).toBe("interceptionProofRejected");
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedRejectedMissingSlotProof,
    );
  });

  it("allows traverse to restore an intercepted visible world only with proof", () => {
    const currentSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [createSlotBinding("slot:activity:/feed", "layout:/feed", "active")],
      ),
      displayUrl: "https://example.com/feed",
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshot = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [],
        [
          createSlotBinding("slot:activity:/feed", "layout:/feed", "default"),
          createSlotBinding("slot:modal:/feed", "layout:/feed", "active"),
        ],
      ),
      displayUrl: "https://example.com/photos/42",
      interception: createInterceptionSnapshot(),
      interceptionContext: "/feed",
      matchedUrl: "/photos/42",
      routeId: "route:/photos/42\u0000/feed",
    };

    const decision = planFlightResponseFromSnapshots({
      currentSnapshot,
      lane: "traverse",
      targetSnapshot,
    });

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("interceptedCurrentRootBoundary");
    expect(decision.proposal.preservePreviousSlotIds).toEqual(["slot:activity:/feed"]);
  });

  it("does not preserve layouts across root-boundary uncertainty", () => {
    const currentSnapshot = createRouteSnapshot("/", ["layout:/"]);
    const targetSnapshot = createRouteSnapshot(null, ["layout:/"]);

    expect(
      navigationPlanner.resolveSameLayoutAncestorPersistence(currentSnapshot, targetSnapshot),
    ).toEqual([]);
  });

  it("never hard-navigates prefetch flight responses", () => {
    const token = createOperationToken({
      lane: "prefetch",
      targetSnapshotFingerprint: "route:/dashboard|root:/(dashboard)",
    });
    const decision = navigationPlanner.plan({
      routeManifest: null,
      state: {
        nextOperationToken: token,
        traceFields: {
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 2,
          nextRootLayoutTreePath: "/(dashboard)",
          startedVisibleCommitVersion: 2,
        },
        visibleCommitVersion: 2,
        visibleSnapshot: createRouteSnapshot("/"),
      },
      event: {
        kind: "flightResponseArrived",
        result: {
          href: "https://example.com/dashboard",
          targetSnapshot: createRouteSnapshot("/(dashboard)"),
        },
        token,
      },
    });

    expect(decision.kind).toBe("noCommit");
    if (decision.kind !== "noCommit") {
      throw new Error("Expected noCommit decision");
    }
    expect(decision.reason).toBe("prefetchOnly");
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.prefetchOnly);
  });

  it("returns requestWork for initial navigation intent events", () => {
    const token = createOperationToken();
    const input: NavigationPlannerInput = {
      routeManifest: null,
      state: {
        nextOperationToken: token,
        visibleCommitVersion: 2,
        visibleSnapshot: createRouteSnapshot("/"),
      },
      event: {
        href: "https://example.com/dashboard",
        kind: "navigate",
        mode: "push",
      },
    };
    const decision = navigationPlanner.plan(input);

    expect(decision.kind).toBe("requestWork");
    if (decision.kind !== "requestWork") {
      throw new Error("Expected requestWork decision");
    }
    expect(decision.token).toBe(token);
    expect(decision.work).toEqual({
      href: "https://example.com/dashboard",
      kind: "flight",
      mode: "push",
    });
  });

  it("returns requestWork for refresh intent events", () => {
    const token = createOperationToken({
      targetSnapshotFingerprint: "route:/dashboard|root:/|refresh",
    });
    const scope: RefreshScope = "visible";
    const event: NavigationEvent = { kind: "refresh", scope };
    const decision = navigationPlanner.plan({
      event,
      routeManifest: null,
      state: {
        nextOperationToken: token,
        visibleCommitVersion: 2,
        visibleSnapshot: createRouteSnapshot("/"),
      },
    });

    expect(decision.kind).toBe("requestWork");
    if (decision.kind !== "requestWork") {
      throw new Error("Expected requestWork decision");
    }
    expect(decision.work).toEqual({
      href: "https://example.com/dashboard",
      kind: "flight",
      mode: "refresh",
    });
  });

  it("does not invent a target href for traverse intent events", () => {
    const token = createOperationToken();
    const historyState = { key: "previous-entry" };
    const decision = navigationPlanner.plan({
      routeManifest: null,
      state: {
        nextOperationToken: token,
        visibleCommitVersion: 2,
        visibleSnapshot: createRouteSnapshot("/"),
      },
      event: {
        direction: "back",
        historyState,
        kind: "traverse",
      },
    });

    expect(decision.kind).toBe("requestWork");
    if (decision.kind !== "requestWork") {
      throw new Error("Expected requestWork decision");
    }
    expect(decision.work).toEqual({
      direction: "back",
      historyState,
      kind: "traverseFlight",
    });
    expect(decision.trace.entries[0]?.fields.targetHref).toBeNull();
    expect(decision.trace.entries[0]?.fields.traverseDirection).toBe("back");
  });

  it("keeps unknown traversal direction explicit instead of guessing", () => {
    const token = createOperationToken();
    const historyState = { key: "external-entry" };
    const decision = navigationPlanner.plan({
      routeManifest: null,
      state: {
        nextOperationToken: token,
        visibleCommitVersion: 2,
        visibleSnapshot: createRouteSnapshot("/"),
      },
      event: {
        direction: "unknown",
        historyState,
        kind: "traverse",
      },
    });

    expect(decision.kind).toBe("requestWork");
    if (decision.kind !== "requestWork") {
      throw new Error("Expected requestWork decision");
    }
    expect(decision.work).toEqual({
      direction: "unknown",
      historyState,
      kind: "traverseFlight",
    });
    expect(decision.trace.entries[0]?.fields.traverseDirection).toBe("unknown");
  });
});
