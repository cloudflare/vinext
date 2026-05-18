import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
} from "../packages/vinext/src/server/navigation-trace.js";
import {
  navigationPlanner,
  type FlightResultV0,
  type MountedParallelSlotSnapshotV0,
  type NavigationDecisionV0,
  type NavigationEvent,
  type NavigationPlannerInput,
  type NavigationPlannerStateV0,
  type OperationToken,
  type ParallelSlotBindingSnapshotV0,
  type RefreshScope,
  type RouteSnapshotV0,
  type InterceptionSnapshotV0,
  type RootBoundaryTransition,
} from "../packages/vinext/src/server/navigation-planner.js";

function createRouteSnapshot(
  rootBoundaryId: string | null,
  layoutIds: readonly string[] = rootBoundaryId === null ? [] : [`layout:${rootBoundaryId}`],
  mountedParallelSlots: readonly MountedParallelSlotSnapshotV0[] = [],
  slotBindings: readonly ParallelSlotBindingSnapshotV0[] = [],
): RouteSnapshotV0 {
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
  overrides: Partial<InterceptionSnapshotV0> = {},
): InterceptionSnapshotV0 {
  return {
    sourceMatchedUrl: "/feed",
    sourceRouteId: "route:/feed",
    slotId: "slot:modal:/feed",
    targetMatchedUrl: "/photos/42",
    targetRouteId: "route:/photos/42",
    ...overrides,
  };
}

function createSlotBinding(
  slotId: string,
  ownerLayoutId: string,
  state: ParallelSlotBindingSnapshotV0["state"] = "active",
): ParallelSlotBindingSnapshotV0 {
  return { ownerLayoutId, slotId, state };
}

function createOperationToken(overrides: Partial<OperationToken> = {}): OperationToken {
  return {
    baseVisibleCommitVersion: 2,
    deploymentVersion: null,
    graphVersion: null,
    lane: "navigation",
    operationId: 7,
    targetSnapshotFingerprint: "route:/dashboard|root:/",
    ...overrides,
  };
}

function planFlightResponse(rootBoundaryId: string | null): NavigationDecisionV0 {
  const token = createOperationToken({
    targetSnapshotFingerprint: `route:/dashboard|root:${rootBoundaryId ?? "unknown"}`,
  });
  const result: FlightResultV0 = {
    href: "https://example.com/dashboard",
    targetSnapshot: createRouteSnapshot(rootBoundaryId),
  };
  const state: NavigationPlannerStateV0 = {
    nextOperationToken: token,
    traceFields: {
      currentRootLayoutTreePath: "/",
      currentVisibleCommitVersion: 2,
      nextRootLayoutTreePath: rootBoundaryId,
      startedVisibleCommitVersion: 2,
    },
    visibleCommitVersion: 2,
    visibleSnapshot: createRouteSnapshot("/"),
  };
  const event: NavigationEvent = {
    kind: "flightResponseArrived",
    result,
    token,
  };
  const input: NavigationPlannerInput = {
    event,
    routeManifest: null,
    state,
  };

  return navigationPlanner.plan(input);
}

function planFlightResponseFromRootBoundaries(options: {
  currentRootBoundaryId: string | null;
  nextRootBoundaryId: string | null;
}): NavigationDecisionV0 {
  const token = createOperationToken({
    targetSnapshotFingerprint: `route:/dashboard|root:${options.nextRootBoundaryId ?? "unknown"}`,
  });

  return navigationPlanner.plan({
    event: {
      kind: "flightResponseArrived",
      result: {
        href: "https://example.com/dashboard",
        targetSnapshot: createRouteSnapshot(options.nextRootBoundaryId),
      },
      token,
    },
    routeManifest: null,
    state: {
      nextOperationToken: token,
      traceFields: {
        currentRootLayoutTreePath: options.currentRootBoundaryId,
        currentVisibleCommitVersion: 2,
        nextRootLayoutTreePath: options.nextRootBoundaryId,
        startedVisibleCommitVersion: 2,
      },
      visibleCommitVersion: 2,
      visibleSnapshot: createRouteSnapshot(options.currentRootBoundaryId),
    },
  });
}

function planFlightResponseFromSnapshots(options: {
  currentSnapshot: RouteSnapshotV0;
  lane?: OperationToken["lane"];
  targetSnapshot: RouteSnapshotV0;
}): NavigationDecisionV0 {
  const token = createOperationToken({
    lane: options.lane ?? "navigation",
    targetSnapshotFingerprint: `${options.targetSnapshot.routeId}|root:${
      options.targetSnapshot.rootBoundaryId ?? "unknown"
    }`,
  });

  return navigationPlanner.plan({
    event: {
      kind: "flightResponseArrived",
      result: {
        href: options.targetSnapshot.displayUrl,
        targetSnapshot: options.targetSnapshot,
      },
      token,
    },
    routeManifest: null,
    state: {
      nextOperationToken: token,
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

  it("uses the current soft fallback when the target root identity is unknown", () => {
    const decision = planFlightResponse(null);

    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("rootBoundaryUnknownFallback");
    expect(decision.proposal.preserveAbsentSlots).toBe(true);
    expect(decision.proposal.preserveElementIds).toEqual([]);
    expect(decision.proposal.preservePreviousSlotIds).toEqual([]);
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.rootBoundaryUnknown);
  });

  it("uses the current soft fallback when the visible root identity is unknown", () => {
    const transition = navigationPlanner.classifyRootBoundaryTransition(null, "/");
    const decision = planFlightResponseFromRootBoundaries({
      currentRootBoundaryId: null,
      nextRootBoundaryId: "/",
    });

    expect(transition).toBe("rootBoundaryUnknownFallback");
    expect(decision.kind).toBe("proposeCommit");
    if (decision.kind !== "proposeCommit") {
      throw new Error("Expected proposeCommit decision");
    }
    expect(decision.proposal.reason).toBe("rootBoundaryUnknownFallback");
    expect(decision.proposal.preserveAbsentSlots).toBe(true);
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
    const currentSnapshot: RouteSnapshotV0 = {
      ...createRouteSnapshot(
        "/",
        ["layout:/", "layout:/feed"],
        [{ ownerLayoutId: "layout:/feed", slotId: "slot:modal:/feed" }],
      ),
      displayUrl: "https://example.com/feed",
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshotV0 = {
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
      routeManifest: null,
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
    const token = createOperationToken({
      targetSnapshotFingerprint: "route:/dashboard/settings|root:/",
    });

    const decision = navigationPlanner.plan({
      event: {
        kind: "flightResponseArrived",
        result: {
          href: "https://example.com/dashboard/settings",
          targetSnapshot,
        },
        token,
      },
      routeManifest: null,
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
    const token = createOperationToken({
      targetSnapshotFingerprint: "route:/dashboard/settings|root:/",
    });

    const decision = navigationPlanner.plan({
      event: {
        kind: "flightResponseArrived",
        result: {
          href: "https://example.com/dashboard/settings",
          targetSnapshot,
        },
        token,
      },
      routeManifest: null,
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
    const currentSnapshot = createRouteSnapshot(
      "/",
      ["layout:/", "layout:/feed"],
      [],
      [createSlotBinding("slot:modal:/dashboard", "layout:/dashboard", "active")],
    );
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

  it("approves intercepted preservation only from explicit source and slot proof", () => {
    // Core-15 oracle, porting the visible behavior from Next.js:
    // test/e2e/app-dir/parallel-routes-and-interception-catchall/parallel-routes-and-interception-catchall.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception-catchall/parallel-routes-and-interception-catchall.test.ts
    const currentSnapshot: RouteSnapshotV0 = {
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
    const targetSnapshot: RouteSnapshotV0 = {
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
    const currentSnapshot: RouteSnapshotV0 = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshotV0 = {
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
    const currentSnapshot: RouteSnapshotV0 = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/gallery"]),
      matchedUrl: "/gallery",
      routeId: "route:/gallery",
    };
    const targetSnapshot: RouteSnapshotV0 = {
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
    const currentSnapshot: RouteSnapshotV0 = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshotV0 = {
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

  it("rejects intercepted preservation when source and target share no layout root", () => {
    const currentSnapshot: RouteSnapshotV0 = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshotV0 = {
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
      NavigationTraceReasonCodes.interceptedRejectedIncompatibleRoot,
    );
  });

  it("rejects intercepted preservation when the target slot is not proven active", () => {
    const currentSnapshot: RouteSnapshotV0 = {
      ...createRouteSnapshot("/", ["layout:/", "layout:/feed"]),
      matchedUrl: "/feed",
      routeId: "route:/feed",
    };
    const targetSnapshot: RouteSnapshotV0 = {
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
    const currentSnapshot: RouteSnapshotV0 = {
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
    const targetSnapshot: RouteSnapshotV0 = {
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
