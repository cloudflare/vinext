import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
} from "../packages/vinext/src/server/navigation-trace.js";
import {
  navigationPlanner,
  type NavigationReuseDecision,
  type NavigationReuseFacts,
  type VisitedResponseCacheCandidateFacts,
} from "../packages/vinext/src/server/navigation-planner.js";

function createReuseFacts(overrides: Partial<NavigationReuseFacts> = {}): NavigationReuseFacts {
  return {
    bypassNavigationCache: false,
    navigationKind: "navigate",
    optimisticRouteShell: { status: "available" },
    prefetch: { status: "unavailable" },
    targetHref: "/dashboard",
    visitedResponse: { status: "unavailable" },
    ...overrides,
  };
}

function classifyReuse(overrides: Partial<NavigationReuseFacts> = {}): NavigationReuseDecision {
  return navigationPlanner.classifyNavigationReuse(createReuseFacts(overrides));
}

describe("navigationPlanner prefetch reuse classification", () => {
  it("skips prefetch probes when a visited response is already reusable", () => {
    expect(
      navigationPlanner.classifyNavigationPrefetchProbe({
        bypassNavigationCache: false,
        navigationKind: "navigate",
        visitedResponse: { status: "available" },
      }),
    ).toEqual({
      kind: "skip",
      reason: "visitedResponseAvailable",
    });
  });

  it("probes prefetch only for non-refresh cacheable visited-response misses", () => {
    expect(
      navigationPlanner.classifyNavigationPrefetchProbe({
        bypassNavigationCache: false,
        navigationKind: "navigate",
        visitedResponse: { status: "unavailable" },
      }),
    ).toEqual({ kind: "probe" });

    expect(
      navigationPlanner.classifyNavigationPrefetchProbe({
        bypassNavigationCache: false,
        navigationKind: "refresh",
        visitedResponse: { status: "unavailable" },
      }),
    ).toEqual({
      kind: "skip",
      reason: "refresh",
    });

    expect(
      navigationPlanner.classifyNavigationPrefetchProbe({
        bypassNavigationCache: true,
        navigationKind: "navigate",
        visitedResponse: { status: "unavailable" },
      }),
    ).toEqual({
      kind: "skip",
      reason: "cacheBypassed",
    });
  });

  it("reuses visited responses before prefetch or optimistic candidates", () => {
    const decision = classifyReuse({
      prefetch: { status: "available" },
      visitedResponse: { status: "available" },
    });

    expect(decision).toEqual({
      kind: "reuseVisitedResponse",
      trace: {
        schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
        entries: [
          {
            code: NavigationTraceReasonCodes.visitedResponseReuse,
            fields: {
              eventKind: "navigate",
              targetHref: "/dashboard",
            },
          },
        ],
      },
    });
  });

  it("consumes an eligible prefetch when no visited response exists", () => {
    const decision = classifyReuse({
      prefetch: { status: "available" },
    });

    expect(decision).toMatchObject({
      kind: "consumePrefetch",
      trace: {
        entries: [
          {
            code: NavigationTraceReasonCodes.prefetchResponseReuse,
          },
        ],
      },
    });
  });

  it("attempts an optimistic route shell for navigate misses with a route manifest", () => {
    const decision = classifyReuse();

    expect(decision).toMatchObject({
      kind: "attemptOptimisticRouteShell",
      trace: {
        entries: [
          {
            code: NavigationTraceReasonCodes.optimisticRouteShell,
          },
        ],
      },
    });
  });

  it("skips visited and prefetch reuse when navigation cache is bypassed", () => {
    const decision = classifyReuse({
      bypassNavigationCache: true,
      prefetch: { status: "available" },
      visitedResponse: { status: "available" },
    });

    expect(decision.kind).toBe("attemptOptimisticRouteShell");
  });

  it("fetches fresh for refresh even when cache candidates exist", () => {
    const decision = classifyReuse({
      navigationKind: "refresh",
      prefetch: { status: "available" },
      visitedResponse: { status: "available" },
    });

    expect(decision).toEqual({
      kind: "fetchFresh",
      reason: "refresh",
      trace: {
        schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
        entries: [
          {
            code: NavigationTraceReasonCodes.fetchFresh,
            fields: {
              eventKind: "refresh",
              freshFetchReason: "refresh",
              targetHref: "/dashboard",
            },
          },
        ],
      },
    });
  });

  it("fetches fresh for traverse misses instead of attempting optimistic shells", () => {
    const decision = classifyReuse({
      navigationKind: "traverse",
    });

    expect(decision).toMatchObject({
      kind: "fetchFresh",
      reason: "cacheMiss",
    });
  });

  it("fetches fresh for navigate misses without an optimistic shell candidate", () => {
    const decision = classifyReuse({
      optimisticRouteShell: { reason: "routeManifestMissing", status: "unavailable" },
    });

    expect(decision).toMatchObject({
      kind: "fetchFresh",
      reason: "routeManifestMissing",
    });
  });

  it("fetches fresh for bypassed navigate misses without an optimistic shell candidate", () => {
    const decision = classifyReuse({
      bypassNavigationCache: true,
      optimisticRouteShell: { reason: "routeManifestMissing", status: "unavailable" },
      prefetch: { status: "available" },
      visitedResponse: { status: "available" },
    });

    expect(decision).toMatchObject({
      kind: "fetchFresh",
      reason: "cacheBypassed",
    });
  });
});

describe("navigationPlanner visited-response cache candidate classification", () => {
  function classifyVisited(
    overrides: Partial<Extract<VisitedResponseCacheCandidateFacts, { candidate: "present" }>> = {},
  ) {
    return navigationPlanner.classifyVisitedResponseCacheCandidate({
      candidate: "present",
      fresh: true,
      mountedSlotsMatch: true,
      navigationKind: "navigate",
      ...overrides,
    });
  }

  it("reuses fresh matching candidates", () => {
    expect(classifyVisited()).toEqual({ kind: "reuse" });
  });

  it("misses absent candidates", () => {
    expect(
      navigationPlanner.classifyVisitedResponseCacheCandidate({
        candidate: "missing",
        navigationKind: "navigate",
      }),
    ).toEqual({ kind: "miss" });
  });

  it("evicts slot-mismatched candidates before evaluating freshness", () => {
    expect(
      classifyVisited({
        fresh: false,
        mountedSlotsMatch: false,
      }),
    ).toEqual({
      kind: "evict",
      reason: "mountedSlotsMismatch",
    });
  });

  it("evicts refresh candidates even when still fresh", () => {
    expect(
      classifyVisited({
        navigationKind: "refresh",
      }),
    ).toEqual({
      kind: "evict",
      reason: "refresh",
    });
  });

  it("evicts stale candidates", () => {
    expect(
      classifyVisited({
        fresh: false,
      }),
    ).toEqual({
      kind: "evict",
      reason: "stale",
    });
  });
});
