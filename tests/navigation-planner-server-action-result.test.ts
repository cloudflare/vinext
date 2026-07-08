import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
} from "../packages/vinext/src/server/navigation-trace.js";
import {
  navigationPlanner,
  type RscNavigationErrorDecision,
  type RscNavigationErrorFacts,
  type ServerActionResultDecision,
  type ServerActionResultFacts,
} from "../packages/vinext/src/server/navigation-planner.js";

function createFacts(overrides: Partial<ServerActionResultFacts> = {}): ServerActionResultFacts {
  return {
    actionRedirectHref: null,
    actionRedirectType: "replace",
    clientCompatibilityId: "client-build",
    compatibilityIdHeader: "client-build",
    currentHref: "https://example.com/dashboard",
    isRscContentType: true,
    origin: "https://example.com",
    responseUrl: "https://example.com/dashboard",
    ...overrides,
  };
}

function classify(overrides: Partial<ServerActionResultFacts> = {}): ServerActionResultDecision {
  return navigationPlanner.classifyServerActionResult(createFacts(overrides));
}

function expectSingleTraceEntry(
  decision: ServerActionResultDecision | RscNavigationErrorDecision,
  code: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  expect(decision.trace).toEqual({
    schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
    entries: [{ code, fields }],
  });
}

describe("navigationPlanner server-action result classification", () => {
  it("hard-navigates a push action redirect with an incompatible compatibility id", () => {
    const decision = classify({
      actionRedirectHref: "https://example.com/target?tab=1",
      actionRedirectType: "push",
      compatibilityIdHeader: "server-build",
    });

    expect(decision).toEqual({
      kind: "hardNavigate",
      url: "https://example.com/target?tab=1",
      historyMode: "assign",
      clearClientNavigationCaches: true,
      reason: "serverActionRedirectCompatibilityMismatch",
      trace: decision.trace,
    });
    expectSingleTraceEntry(
      decision,
      NavigationTraceReasonCodes.serverActionRedirectCompatibilityMismatch,
      { targetHref: "https://example.com/target?tab=1" },
    );
  });

  it("uses replace history mode for an incompatible replace action redirect", () => {
    const decision = classify({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "replace",
      compatibilityIdHeader: "server-build",
    });

    expect(decision).toMatchObject({
      kind: "hardNavigate",
      url: "https://example.com/target",
      historyMode: "replace",
      clearClientNavigationCaches: true,
      reason: "serverActionRedirectCompatibilityMismatch",
    });
  });

  it("hard-navigates a no-redirect RSC response with an incompatible compatibility id to the current href", () => {
    const decision = classify({
      actionRedirectHref: null,
      actionRedirectType: "replace",
      compatibilityIdHeader: "server-build",
      currentHref: "https://example.com/dashboard?view=grid",
    });

    expect(decision).toEqual({
      kind: "hardNavigate",
      url: "https://example.com/dashboard?view=grid",
      clearClientNavigationCaches: false,
      reason: "serverActionRscCompatibilityMismatch",
      trace: decision.trace,
    });
    expect(decision).not.toHaveProperty("historyMode");
    expectSingleTraceEntry(
      decision,
      NavigationTraceReasonCodes.serverActionRscCompatibilityMismatch,
      { targetHref: "https://example.com/dashboard?view=grid" },
    );
  });

  it("proceeds when an action redirect carries a compatible compatibility id", () => {
    const decision = classify({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "push",
      compatibilityIdHeader: "client-build",
    });

    expect(decision).toMatchObject({ kind: "proceed" });
  });

  it("proceeds when a no-redirect RSC response carries a compatible compatibility id", () => {
    const decision = classify();

    expect(decision).toMatchObject({ kind: "proceed" });
  });

  it("proceeds for a non-RSC action redirect response", () => {
    const decision = classify({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "push",
      isRscContentType: false,
      compatibilityIdHeader: null,
    });

    expect(decision).toMatchObject({ kind: "proceed" });
  });

  it("proceeds for a no-redirect non-RSC response", () => {
    const decision = classify({
      isRscContentType: false,
      compatibilityIdHeader: null,
    });

    expect(decision).toMatchObject({ kind: "proceed" });
  });

  it("treats a null client compatibility id as always compatible", () => {
    // A client without a compatibility id cannot prove skew, so even a
    // mismatched response header must not force a hard navigation.
    const decision = classify({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "push",
      clientCompatibilityId: null,
      compatibilityIdHeader: "server-build",
    });

    expect(decision).toMatchObject({ kind: "proceed" });
  });
});

describe("navigationPlanner RSC navigation error classification", () => {
  function classifyError(
    overrides: Partial<RscNavigationErrorFacts> = {},
  ): RscNavigationErrorDecision {
    return navigationPlanner.classifyRscNavigationError({
      currentHref: "https://example.com/current",
      ...overrides,
    });
  }

  it("hard-navigates to the current document href on any navigation error", () => {
    const decision = classifyError({ currentHref: "https://example.com/feed?page=2" });

    expect(decision).toEqual({
      kind: "hardNavigate",
      url: "https://example.com/feed?page=2",
      reason: "rscNavigationError",
      trace: decision.trace,
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.rscNavigationError, {
      targetHref: "https://example.com/feed?page=2",
    });
  });
});

describe("navigationPlanner server-action result integration with executor contract", () => {
  it("produces a decision the executor can consume for redirect hard-navigation", () => {
    const decision = classify({
      actionRedirectHref: "https://example.com/target?tab=1",
      actionRedirectType: "push",
      compatibilityIdHeader: "server-build",
    });

    // Executor contract: if kind === "hardNavigate" and historyMode is present,
    // performHardNavigation(url, historyMode) and clearClientNavigationCaches.
    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") throw new Error("Expected hardNavigate");
    expect(decision.url).toBe("https://example.com/target?tab=1");
    expect(decision.historyMode).toBe("assign");
    expect(decision.clearClientNavigationCaches).toBe(true);
    expect(decision.reason).toBe("serverActionRedirectCompatibilityMismatch");
    expect(decision.trace).toBeDefined();
    expect(decision.trace.entries).toHaveLength(1);
  });

  it("produces a decision the executor can consume for no-redirect RSC hard-navigation", () => {
    const decision = classify({
      actionRedirectHref: null,
      actionRedirectType: "replace",
      compatibilityIdHeader: "server-build",
      currentHref: "https://example.com/dashboard?view=grid",
    });

    // Executor contract: if kind === "hardNavigate" and historyMode is absent,
    // performHardNavigation(url) without explicit history mode (falls back to default).
    expect(decision.kind).toBe("hardNavigate");
    if (decision.kind !== "hardNavigate") throw new Error("Expected hardNavigate");
    expect(decision.url).toBe("https://example.com/dashboard?view=grid");
    expect(decision).not.toHaveProperty("historyMode");
    expect(decision.clearClientNavigationCaches).toBe(false);
    expect(decision.reason).toBe("serverActionRscCompatibilityMismatch");
    expect(decision.trace).toBeDefined();
    expect(decision.trace.entries).toHaveLength(1);
  });

  it("produces a proceed decision with a valid trace for the executor", () => {
    const decision = classify();

    // Executor contract: if kind === "proceed", continue with normal action processing.
    expect(decision.kind).toBe("proceed");
    if (decision.kind !== "proceed") throw new Error("Expected proceed");
    expect(decision.trace.entries).toHaveLength(1);
  });

  it("produces consistent trace schema version across all decision types", () => {
    const redirectDecision = classify({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "push",
      compatibilityIdHeader: "server-build",
    });

    const noRedirectDecision = classify({
      compatibilityIdHeader: "server-build",
    });

    const proceedDecision = classify();

    const errorDecision = navigationPlanner.classifyRscNavigationError({
      currentHref: "https://example.com/current",
    });

    for (const decision of [redirectDecision, noRedirectDecision, proceedDecision, errorDecision]) {
      expect(decision.trace.schemaVersion).toBe(NAVIGATION_TRACE_SCHEMA_VERSION);
      expect(decision.trace.entries.length).toBeGreaterThan(0);
      for (const entry of decision.trace.entries) {
        expect(entry.code).toBeTruthy();
        expect(typeof entry.fields).toBe("object");
      }
    }
  });

  it("preserves the full URL including search params for no-redirect hard-navigation", () => {
    const decision = classify({
      actionRedirectHref: null,
      actionRedirectType: "replace",
      compatibilityIdHeader: "server-build",
      currentHref: "https://example.com/page?foo=bar&baz=qux#section",
    });

    expect(decision).toMatchObject({
      kind: "hardNavigate",
      url: "https://example.com/page?foo=bar&baz=qux#section",
      clearClientNavigationCaches: false,
      reason: "serverActionRscCompatibilityMismatch",
    });
  });

  it("maps replace action redirects to replace history mode for the executor", () => {
    const decision = classify({
      actionRedirectHref: "https://example.com/replace-target",
      actionRedirectType: "replace",
      compatibilityIdHeader: "server-build",
    });

    expect(decision).toMatchObject({
      kind: "hardNavigate",
      url: "https://example.com/replace-target",
      historyMode: "replace",
      clearClientNavigationCaches: true,
      reason: "serverActionRedirectCompatibilityMismatch",
    });
  });

  it("produces a valid trace entry for server action redirect compatibility mismatch", () => {
    const decision = classify({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "push",
      compatibilityIdHeader: "server-build",
    });

    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.serverActionRedirectCompatibilityMismatch,
      fields: {
        targetHref: "https://example.com/target",
      },
    });
  });

  it("produces a valid trace entry for server action RSC compatibility mismatch", () => {
    const decision = classify({
      actionRedirectHref: null,
      actionRedirectType: "replace",
      compatibilityIdHeader: "server-build",
      currentHref: "https://example.com/dashboard",
    });

    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.serverActionRscCompatibilityMismatch,
      fields: {
        targetHref: "https://example.com/dashboard",
      },
    });
  });

  it("produces a valid trace entry for RSC navigation error", () => {
    const decision = navigationPlanner.classifyRscNavigationError({
      currentHref: "https://example.com/error-page",
    });

    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.rscNavigationError,
      fields: {
        targetHref: "https://example.com/error-page",
      },
    });
  });

  it("produces a valid trace entry for proceed decisions", () => {
    const decision = classify();

    expect(decision.trace.entries[0]).toEqual({
      code: NavigationTraceReasonCodes.proceedToCommit,
      fields: {},
    });
  });
});
