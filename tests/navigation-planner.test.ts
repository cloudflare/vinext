import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
} from "../packages/vinext/src/server/navigation-trace.js";
import {
  navigationPlanner,
  type FlightResultV0,
  type NavigationDecisionV0,
  type NavigationEvent,
  type NavigationPlannerInput,
  type NavigationPlannerStateV0,
  type OperationToken,
  type RefreshScope,
  type RouteSnapshotV0,
  type RootBoundaryTransition,
} from "../packages/vinext/src/server/navigation-planner.js";

function createRouteSnapshot(
  rootBoundaryId: string | null,
  layoutIds: readonly string[] = rootBoundaryId === null ? [] : [`layout:${rootBoundaryId}`],
): RouteSnapshotV0 {
  return {
    displayUrl: "https://example.com/dashboard",
    layoutIds,
    matchedUrl: "/dashboard",
    rootBoundaryId,
    routeId: "route:/dashboard",
  };
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
    expect(decision.proposal.targetSnapshot.rootBoundaryId).toBe("/");
    expect(decision.proposal.preserveElementIds).toEqual(["layout:/"]);
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
    expect(decision.proposal.preserveElementIds).toEqual([]);
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
    expect(decision.proposal.preserveElementIds).toEqual([]);
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
  });
});
