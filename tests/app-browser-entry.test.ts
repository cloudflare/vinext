import React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createOnUncaughtError } from "../packages/vinext/src/server/app-browser-error.js";
import { createAppBrowserNavigationController } from "../packages/vinext/src/server/app-browser-navigation-controller.js";
import { devOnCaughtError } from "../packages/vinext/src/server/dev-error-overlay.js";
import {
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_LAYOUT_FLAGS_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  UNMATCHED_SLOT,
  getMountedSlotIds,
  getMountedSlotIdsHeader,
  normalizeAppElements,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import { createClientNavigationRenderSnapshot } from "../packages/vinext/src/shims/navigation.js";
import * as navigationShim from "../packages/vinext/src/shims/navigation.js";
import {
  createHistoryStateWithPreviousNextUrl,
  createPendingNavigationCommit,
  readHistoryStatePreviousNextUrl,
  resolveInterceptionContextFromPreviousNextUrl,
  resolveServerActionRequestState,
  resolvePendingNavigationCommitDisposition,
  resolvePendingNavigationCommitDispositionDecision,
  shouldHardNavigate,
  type AppRouterState,
  type OperationLane,
} from "../packages/vinext/src/server/app-browser-state.js";
import {
  applyApprovedVisibleCommit,
  approveHmrVisibleCommit,
  approvePendingNavigationCommit,
  resolveAndClassifyNavigationCommit,
} from "../packages/vinext/src/server/app-browser-visible-commit.js";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
  NavigationTraceTransactionCodes,
  createNavigationTrace,
} from "../packages/vinext/src/server/navigation-trace.js";

function createResolvedElements(
  routeId: string,
  rootLayoutTreePath: string | null,
  interceptionContext: string | null = null,
  extraEntries: Record<string, unknown> = {},
) {
  return normalizeAppElements({
    [APP_INTERCEPTION_CONTEXT_KEY]: interceptionContext,
    [APP_ROUTE_KEY]: routeId,
    [APP_ROOT_LAYOUT_KEY]: rootLayoutTreePath,
    ...extraEntries,
  });
}

function createState(overrides: Partial<AppRouterState> = {}): AppRouterState {
  return {
    elements: createResolvedElements("route:/initial", "/"),
    layoutFlags: {},
    navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
    renderId: 0,
    activeOperation: null,
    interceptionContext: null,
    previousNextUrl: null,
    rootLayoutTreePath: "/",
    routeId: "route:/initial",
    visibleCommitVersion: 0,
    ...overrides,
  };
}

function createControllerHarness(initialState: AppRouterState = createState()) {
  const controller = createAppBrowserNavigationController();
  const stateRef: { current: AppRouterState } = { current: initialState };
  const setBrowserRouterState = vi.fn((value: AppRouterState | Promise<AppRouterState>) => {
    if (!(value instanceof Promise)) {
      stateRef.current = value;
    }
  });
  const detach = controller.attachBrowserRouterState(setBrowserRouterState, stateRef);

  return {
    controller,
    detach,
    setBrowserRouterState,
    stateRef,
  };
}

type ApprovedTestCommitOptions = {
  activeNavigationId?: number;
  extraEntries?: Record<string, unknown>;
  interceptionContext?: string | null;
  layoutFlags?: AppRouterState["layoutFlags"];
  navigationSnapshot?: AppRouterState["navigationSnapshot"];
  operationLane?: OperationLane;
  previousNextUrl?: string | null;
  renderId?: number;
  rootLayoutTreePath: string | null;
  routeId: string;
  startedNavigationId?: number;
  type?: "navigate" | "replace" | "traverse";
};

async function applyApprovedTestCommit(
  state: AppRouterState,
  options: ApprovedTestCommitOptions,
): Promise<AppRouterState> {
  const pending = await createPendingNavigationCommit({
    currentState: state,
    nextElements: Promise.resolve(
      createResolvedElements(
        options.routeId,
        options.rootLayoutTreePath,
        options.interceptionContext ?? null,
        {
          [APP_LAYOUT_FLAGS_KEY]: options.layoutFlags ?? {},
          ...options.extraEntries,
        },
      ),
    ),
    navigationSnapshot: options.navigationSnapshot ?? state.navigationSnapshot,
    operationLane: options.operationLane ?? "navigation",
    previousNextUrl: options.previousNextUrl,
    renderId: options.renderId ?? 1,
    type: options.type ?? "navigate",
  });
  const activeNavigationId = options.activeNavigationId ?? 1;
  const approval = approvePendingNavigationCommit({
    activeNavigationId,
    currentState: state,
    pending,
    startedNavigationId: options.startedNavigationId ?? activeNavigationId,
  });

  if (approval.approvedCommit === null) {
    throw new Error("Expected approved visible commit");
  }

  return applyApprovedVisibleCommit(state, approval.approvedCommit);
}

function stubWindow(href: string) {
  const assign = vi.fn();

  vi.stubGlobal("window", {
    history: { state: null },
    location: {
      assign,
      href,
      origin: new URL(href).origin,
    },
  });

  return { assign };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("app browser entry state helpers", () => {
  it("requires renderId when creating pending commits", () => {
    // @ts-expect-error renderId is required to avoid duplicate commit ids.
    void createPendingNavigationCommit({
      currentState: createState(),
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: createState().navigationSnapshot,
      operationLane: "navigation",
      type: "navigate",
    });
  });

  it("merges elements on approved navigate commits", async () => {
    const previousElements = createResolvedElements("route:/initial", "/", null, {
      "layout:/": React.createElement("div", null, "layout"),
    });
    const state = createState({
      elements: previousElements,
    });

    const nextState = await applyApprovedTestCommit(state, {
      extraEntries: {
        "page:/next": React.createElement("main", null, "next"),
      },
      rootLayoutTreePath: "/",
      routeId: "route:/next",
    });

    expect(nextState.routeId).toBe("route:/next");
    expect(nextState.interceptionContext).toBeNull();
    expect(nextState.previousNextUrl).toBeNull();
    expect(nextState.rootLayoutTreePath).toBe("/");
    expect(nextState.visibleCommitVersion).toBe(1);
    expect(nextState.activeOperation).toMatchObject({
      id: 1,
      lane: "navigation",
      startedVisibleCommitVersion: 0,
      state: "committed",
      visibleCommitVersion: 1,
    });
    expect(nextState.elements).toMatchObject({
      "layout:/": expect.anything(),
      "page:/next": expect.anything(),
    });
  });

  it("replaces elements on approved replace commits", async () => {
    const nextElements = createResolvedElements("route:/next", "/", null, {
      "page:/next": React.createElement("main", null, "next"),
    });

    const state = createState();
    const pending = await createPendingNavigationCommit({
      currentState: state,
      nextElements: Promise.resolve(nextElements),
      navigationSnapshot: state.navigationSnapshot,
      operationLane: "navigation",
      renderId: 1,
      type: "replace",
    });
    const approval = approvePendingNavigationCommit({
      activeNavigationId: 1,
      currentState: state,
      pending,
      startedNavigationId: 1,
    });
    if (approval.approvedCommit === null) {
      throw new Error("Expected approved visible commit");
    }

    const nextState = applyApprovedVisibleCommit(state, approval.approvedCommit);

    expect(nextState.elements).toBe(nextElements);
    expect(nextState.interceptionContext).toBeNull();
    expect(nextState.previousNextUrl).toBeNull();
    expect(nextState.elements).toMatchObject({
      "page:/next": expect.anything(),
    });
  });

  it("increments the visible commit version once per approved visible commit", async () => {
    const initialState = createState();
    const firstState = await applyApprovedTestCommit(initialState, {
      renderId: 101,
      rootLayoutTreePath: "/",
      routeId: "route:/one",
    });
    const secondState = await applyApprovedTestCommit(firstState, {
      renderId: 102,
      rootLayoutTreePath: "/",
      routeId: "route:/two",
    });

    expect(firstState.visibleCommitVersion).toBe(1);
    expect(secondState.visibleCommitVersion).toBe(2);
    expect(secondState.activeOperation).toMatchObject({
      id: 102,
      startedVisibleCommitVersion: 1,
      state: "committed",
      visibleCommitVersion: 2,
    });
  });

  it("does not export a raw visible state reducer outside the approved commit boundary", async () => {
    const stateModule = await import("../packages/vinext/src/server/app-browser-state.js");

    expect(Object.hasOwn(stateModule, "routerReducer")).toBe(false);
  });

  it("carries interception context through pending navigation commits", async () => {
    const pending = await createPendingNavigationCommit({
      currentState: createState(),
      nextElements: Promise.resolve(
        createResolvedElements("route:/photos/42\0/feed", "/", "/feed", {
          "page:/photos/42": React.createElement("main", null, "photo"),
        }),
      ),
      navigationSnapshot: createState().navigationSnapshot,
      operationLane: "navigation",
      previousNextUrl: "/feed",
      renderId: 1,
      type: "navigate",
    });

    expect(pending.routeId).toBe("route:/photos/42\0/feed");
    expect(pending.interceptionContext).toBe("/feed");
    expect(pending.previousNextUrl).toBe("/feed");
    expect(pending.action.interceptionContext).toBe("/feed");
    expect(pending.action.previousNextUrl).toBe("/feed");
  });

  it("clears previousNextUrl when traversing to a non-intercepted entry", async () => {
    // Traversing back from an intercepted modal (/photos/42 from /feed) to
    // /feed itself. The traverse branch reads null from /feed's history state
    // and passes previousNextUrl: null explicitly — meaning "not intercepted".
    // This must not inherit the current state's stale "/feed" value.
    const interceptedState = createState({
      interceptionContext: "/feed",
      previousNextUrl: "/feed",
      routeId: "route:/photos/42\0/feed",
    });

    const pending = await createPendingNavigationCommit({
      currentState: interceptedState,
      nextElements: Promise.resolve(createResolvedElements("route:/feed", "/")),
      navigationSnapshot: createState().navigationSnapshot,
      operationLane: "traverse",
      previousNextUrl: null,
      renderId: 2,
      type: "traverse",
    });

    expect(pending.previousNextUrl).toBeNull();
    expect(pending.action.previousNextUrl).toBeNull();
  });

  it("hard navigates instead of merging when the root layout changes", async () => {
    const currentState = createState({
      rootLayoutTreePath: "/(marketing)",
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/(dashboard)")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 1,
      type: "navigate",
    });

    expect(
      resolvePendingNavigationCommitDisposition({
        activeNavigationId: 3,
        currentVisibleCommitVersion: currentState.visibleCommitVersion,
        currentRootLayoutTreePath: currentState.rootLayoutTreePath,
        nextRootLayoutTreePath: pending.rootLayoutTreePath,
        startedNavigationId: 3,
        startedVisibleCommitVersion: pending.action.operation.startedVisibleCommitVersion,
      }),
    ).toBe("hard-navigate");
  });

  it("defers commit classification until the payload has resolved", async () => {
    let resolveElements: ((value: AppElements) => void) | undefined;
    const nextElements = new Promise<AppElements>((resolve) => {
      resolveElements = resolve;
    });
    let resolved = false;
    const pending = createPendingNavigationCommit({
      currentState: createState(),
      nextElements,
      navigationSnapshot: createState().navigationSnapshot,
      operationLane: "navigation",
      renderId: 1,
      type: "navigate",
    }).then((result) => {
      resolved = true;
      return result;
    });

    expect(resolved).toBe(false);

    if (!resolveElements) {
      throw new Error("Expected deferred elements resolver");
    }

    resolveElements(
      normalizeAppElements({
        [APP_ROUTE_KEY]: "route:/dashboard",
        [APP_ROOT_LAYOUT_KEY]: "/",
        "page:/dashboard": React.createElement("main", null, "dashboard"),
      }),
    );

    const result = await pending;

    expect(resolved).toBe(true);
    expect(result.routeId).toBe("route:/dashboard");
  });

  it("creates pending operation records from the current visible commit version", async () => {
    const currentState = createState({
      visibleCommitVersion: 4,
    });

    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "refresh",
      renderId: 9,
      type: "navigate",
    });

    expect(pending.action.operation).toEqual({
      id: 9,
      lane: "refresh",
      startedVisibleCommitVersion: 4,
      state: "pending",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 1,
      currentState,
      pending,
      startedNavigationId: 1,
    });
    if (approval.approvedCommit === null) {
      throw new Error("Expected approved visible commit");
    }

    const committedState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);
    expect(committedState.visibleCommitVersion).toBe(5);
    expect(committedState.activeOperation).toEqual({
      id: 9,
      lane: "refresh",
      startedVisibleCommitVersion: 4,
      state: "committed",
      visibleCommitVersion: 5,
    });
  });

  it("skips a pending commit when a newer navigation has become active", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 1,
      type: "navigate",
    });

    expect(
      resolvePendingNavigationCommitDisposition({
        activeNavigationId: 5,
        currentVisibleCommitVersion: currentState.visibleCommitVersion,
        currentRootLayoutTreePath: currentState.rootLayoutTreePath,
        nextRootLayoutTreePath: pending.rootLayoutTreePath,
        startedNavigationId: 4,
        startedVisibleCommitVersion: pending.action.operation.startedVisibleCommitVersion,
      }),
    ).toBe("skip");
  });

  it("skips a refresh commit when visible state changed after the refresh started", async () => {
    const refreshStartState = createState({ visibleCommitVersion: 4 });
    const latestState = createState({
      routeId: "route:/hmr",
      visibleCommitVersion: 5,
    });
    const pending = await createPendingNavigationCommit({
      currentState: refreshStartState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: refreshStartState.navigationSnapshot,
      operationLane: "refresh",
      renderId: 22,
      type: "navigate",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 7,
      currentState: latestState,
      pending,
      startedNavigationId: 7,
    });

    expect(approval.decision.disposition).toBe("no-commit");
    expect(approval.decision.trace.entries).toEqual([
      {
        code: NavigationTraceTransactionCodes.noCommit,
        fields: {
          operationLane: "refresh",
          pendingOperationId: 22,
          startedVisibleCommitVersion: 4,
        },
      },
      {
        code: NavigationTraceReasonCodes.staleOperation,
        fields: {
          activeNavigationId: 7,
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 5,
          nextRootLayoutTreePath: "/",
          startedNavigationId: 7,
          startedVisibleCommitVersion: 4,
        },
      },
    ]);
    expect(approval.approvedCommit).toBeNull();
  });

  it("skips a traverse commit when visible state changed after traversal started", async () => {
    const traverseStartState = createState({ visibleCommitVersion: 2 });
    const latestState = createState({
      routeId: "route:/newer",
      visibleCommitVersion: 3,
    });
    const pending = await createPendingNavigationCommit({
      currentState: traverseStartState,
      nextElements: Promise.resolve(createResolvedElements("route:/previous", "/")),
      navigationSnapshot: traverseStartState.navigationSnapshot,
      operationLane: "traverse",
      previousNextUrl: null,
      renderId: 23,
      type: "traverse",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 8,
      currentState: latestState,
      pending,
      startedNavigationId: 8,
    });

    expect(approval.decision.disposition).toBe("no-commit");
    expect(approval.decision.trace.entries).toEqual([
      {
        code: NavigationTraceTransactionCodes.noCommit,
        fields: {
          operationLane: "traverse",
          pendingOperationId: 23,
          startedVisibleCommitVersion: 2,
        },
      },
      {
        code: NavigationTraceReasonCodes.staleOperation,
        fields: {
          activeNavigationId: 8,
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 3,
          nextRootLayoutTreePath: "/",
          startedNavigationId: 8,
          startedVisibleCommitVersion: 2,
        },
      },
    ]);
    expect(approval.approvedCommit).toBeNull();
  });

  it("traces stale pending commits with compact reason codes and structured fields", () => {
    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 5,
      currentVisibleCommitVersion: 0,
      currentRootLayoutTreePath: "/",
      nextRootLayoutTreePath: "/(dashboard)",
      startedNavigationId: 4,
      startedVisibleCommitVersion: 0,
    });

    expect(decision.disposition).toBe("skip");
    expect(decision.trace).toEqual({
      schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
      entries: [
        {
          code: NavigationTraceReasonCodes.staleOperation,
          fields: {
            activeNavigationId: 5,
            currentRootLayoutTreePath: "/",
            currentVisibleCommitVersion: 0,
            nextRootLayoutTreePath: "/(dashboard)",
            startedNavigationId: 4,
            startedVisibleCommitVersion: 0,
          },
        },
      ],
    });
  });

  it("treats a visible commit version mismatch as stale before root-boundary decisions", () => {
    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 2,
      currentVisibleCommitVersion: 1,
      currentRootLayoutTreePath: "/(marketing)",
      nextRootLayoutTreePath: "/(dashboard)",
      startedNavigationId: 2,
      startedVisibleCommitVersion: 0,
    });

    expect(decision.disposition).toBe("skip");
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.staleOperation);
  });

  it("traces root-boundary hard navigation decisions", () => {
    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 2,
      currentVisibleCommitVersion: 0,
      currentRootLayoutTreePath: "/(marketing)",
      nextRootLayoutTreePath: "/(dashboard)",
      startedNavigationId: 2,
      startedVisibleCommitVersion: 0,
    });

    expect(decision.disposition).toBe("hard-navigate");
    expect(decision.trace.entries).toEqual([
      {
        code: NavigationTraceReasonCodes.rootBoundaryChanged,
        fields: {
          activeNavigationId: 2,
          currentRootLayoutTreePath: "/(marketing)",
          currentVisibleCommitVersion: 0,
          nextRootLayoutTreePath: "/(dashboard)",
          startedNavigationId: 2,
          startedVisibleCommitVersion: 0,
        },
      },
    ]);
  });

  it("traces unknown root-layout identity as a legacy soft-commit fallback", () => {
    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 2,
      currentVisibleCommitVersion: 0,
      currentRootLayoutTreePath: "/",
      nextRootLayoutTreePath: null,
      startedNavigationId: 2,
      startedVisibleCommitVersion: 0,
    });

    expect(decision.disposition).toBe("dispatch");
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.rootBoundaryUnknown);
  });

  it("traces matching root-layout dispatches as current commits", () => {
    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 2,
      currentVisibleCommitVersion: 0,
      currentRootLayoutTreePath: "/",
      nextRootLayoutTreePath: "/",
      startedNavigationId: 2,
      startedVisibleCommitVersion: 0,
    });

    expect(decision.disposition).toBe("dispatch");
    expect(decision.trace.entries).toEqual([
      {
        code: NavigationTraceReasonCodes.commitCurrent,
        fields: {
          activeNavigationId: 2,
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 0,
          nextRootLayoutTreePath: "/",
          startedNavigationId: 2,
          startedVisibleCommitVersion: 0,
        },
      },
    ]);
  });

  it("builds a merge commit for refresh and server-action payloads", async () => {
    const refreshCommit = await createPendingNavigationCommit({
      currentState: createState(),
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: createState().navigationSnapshot,
      operationLane: "refresh",
      previousNextUrl: "/feed",
      renderId: 1,
      type: "navigate",
    });

    expect(refreshCommit.action.type).toBe("navigate");
    expect(refreshCommit.routeId).toBe("route:/dashboard");
    expect(refreshCommit.rootLayoutTreePath).toBe("/");
    expect(refreshCommit.previousNextUrl).toBe("/feed");
  });

  it("creates an approved visible commit only after the current operation decision allows mutation", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(
        createResolvedElements("route:/dashboard", "/", null, {
          "page:/dashboard": React.createElement("main", null, "dashboard"),
        }),
      ),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 11,
      type: "navigate",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 4,
      currentState,
      pending,
      startedNavigationId: 4,
    });

    expect(approval.decision.disposition).toBe("commit");
    if (approval.decision.disposition !== "commit") {
      throw new Error("Expected visible commit approval");
    }
    if (approval.approvedCommit === null) {
      throw new Error("Expected approved visible commit");
    }
    expect(approval.decision.trace.entries).toEqual([
      {
        code: NavigationTraceTransactionCodes.visibleCommit,
        fields: {
          operationLane: "navigation",
          pendingOperationId: 11,
          startedVisibleCommitVersion: 0,
        },
      },
      {
        code: NavigationTraceReasonCodes.commitCurrent,
        fields: {
          activeNavigationId: 4,
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 0,
          nextRootLayoutTreePath: "/",
          startedNavigationId: 4,
          startedVisibleCommitVersion: 0,
        },
      },
    ]);

    const nextState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);
    expect(nextState.routeId).toBe("route:/dashboard");
    expect(nextState.visibleCommitVersion).toBe(1);
    expect(nextState.activeOperation).toMatchObject({
      id: 11,
      lane: "navigation",
      startedVisibleCommitVersion: 0,
      state: "committed",
      visibleCommitVersion: 1,
    });
  });

  it("traces unknown root-layout approval as a visible commit with an uncertainty reason", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/legacy-payload", null)),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 16,
      type: "navigate",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 6,
      currentState,
      pending,
      startedNavigationId: 6,
    });

    expect(approval.decision.disposition).toBe("commit");
    expect(approval.decision.trace.entries[0]?.code).toBe(
      NavigationTraceTransactionCodes.visibleCommit,
    );
    expect(approval.decision.trace.entries[1]?.code).toBe(
      NavigationTraceReasonCodes.rootBoundaryUnknown,
    );
    expect(approval.approvedCommit).not.toBeNull();
  });

  it("approves HMR visible commits through a named trusted recovery path", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(
        createResolvedElements("route:/hmr", "/", null, {
          "page:/hmr": React.createElement("main", null, "hmr"),
        }),
      ),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "hmr",
      renderId: 14,
      type: "replace",
    });

    const approvedCommit = approveHmrVisibleCommit(pending);
    expect(approvedCommit.decision.trace.entries[0]).toEqual({
      code: NavigationTraceTransactionCodes.visibleCommit,
      fields: {
        operationLane: "hmr",
        pendingOperationId: 14,
        startedVisibleCommitVersion: 0,
      },
    });
    const nextState = applyApprovedVisibleCommit(currentState, approvedCommit);

    expect(nextState.routeId).toBe("route:/hmr");
    expect(nextState.activeOperation).toMatchObject({
      id: 14,
      lane: "hmr",
      state: "committed",
    });
  });

  it("rejects non-HMR commits on the HMR approval path", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 15,
      type: "replace",
    });

    expect(() => approveHmrVisibleCommit(pending)).toThrow(
      "[vinext] HMR visible commit approval requires an HMR pending operation",
    );
  });

  it("applies approved replace commits without preserving old elements", async () => {
    const currentState = createState({
      elements: createResolvedElements("route:/initial", "/", null, {
        "layout:/old": React.createElement("div", null, "old"),
      }),
    });
    const nextElements = createResolvedElements("route:/next", "/", null, {
      "page:/next": React.createElement("main", null, "next"),
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(nextElements),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 12,
      type: "replace",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 4,
      currentState,
      pending,
      startedNavigationId: 4,
    });

    if (approval.approvedCommit === null) {
      throw new Error("Expected approved visible commit");
    }

    const nextState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);
    expect(nextState.elements).toBe(nextElements);
    expect(Object.hasOwn(nextState.elements, "layout:/old")).toBe(false);
    expect(nextState.activeOperation).toMatchObject({
      id: 12,
      lane: "navigation",
      state: "committed",
    });
  });

  it("applies approved traverse commits with stale slot cleanup", async () => {
    const currentState = createState({
      elements: createResolvedElements("route:/feed/comments", "/", null, {
        "slot:modal:/feed": React.createElement("div", null, "modal"),
      }),
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/feed", "/")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "traverse",
      previousNextUrl: null,
      renderId: 13,
      type: "traverse",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 4,
      currentState,
      pending,
      startedNavigationId: 4,
    });

    if (approval.approvedCommit === null) {
      throw new Error("Expected approved visible commit");
    }

    const nextState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);
    expect(nextState.routeId).toBe("route:/feed");
    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(false);
    expect(nextState.activeOperation).toMatchObject({
      id: 13,
      lane: "traverse",
      state: "committed",
    });
  });

  it("does not create approved visible commits for stale or hard-navigation decisions", async () => {
    const currentState = createState({
      rootLayoutTreePath: "/(marketing)",
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/(dashboard)")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 12,
      type: "navigate",
    });

    const staleApproval = approvePendingNavigationCommit({
      activeNavigationId: 8,
      currentState,
      pending,
      startedNavigationId: 7,
    });
    expect(staleApproval.decision.disposition).toBe("no-commit");
    expect(staleApproval.decision.trace.entries[0]?.code).toBe(
      NavigationTraceTransactionCodes.noCommit,
    );
    expect(staleApproval.decision.trace.entries[1]?.code).toBe(
      NavigationTraceReasonCodes.staleOperation,
    );
    expect(staleApproval.approvedCommit).toBeNull();

    const hardNavigateApproval = approvePendingNavigationCommit({
      activeNavigationId: 8,
      currentState,
      pending,
      startedNavigationId: 8,
    });
    expect(hardNavigateApproval.decision.disposition).toBe("hard-navigate");
    expect(hardNavigateApproval.decision.trace.entries[0]?.code).toBe(
      NavigationTraceTransactionCodes.hardNavigate,
    );
    expect(hardNavigateApproval.decision.trace.entries[1]?.code).toBe(
      NavigationTraceReasonCodes.rootBoundaryChanged,
    );
    expect(hardNavigateApproval.approvedCommit).toBeNull();
  });

  it("merges layoutFlags on approved navigate commits", async () => {
    const state = createState({ layoutFlags: { "layout:/": "s", "layout:/old": "d" } });
    const nextState = await applyApprovedTestCommit(state, {
      layoutFlags: { "layout:/": "s", "layout:/blog": "d" },
      rootLayoutTreePath: "/",
      routeId: "route:/next",
    });

    // Navigate merges: old flags preserved, new flags override
    expect(nextState.layoutFlags).toEqual({
      "layout:/": "s",
      "layout:/old": "d",
      "layout:/blog": "d",
    });
  });

  it("replaces layoutFlags on approved replace commits", async () => {
    const state = createState({ layoutFlags: { "layout:/": "s", "layout:/old": "d" } });
    const nextState = await applyApprovedTestCommit(state, {
      layoutFlags: { "layout:/": "d" },
      rootLayoutTreePath: "/",
      routeId: "route:/next",
      type: "replace",
    });

    // Replace: only new flags
    expect(nextState.layoutFlags).toEqual({ "layout:/": "d" });
  });

  it("stores previousNextUrl on approved navigate commits", async () => {
    const state = createState();
    const nextState = await applyApprovedTestCommit(state, {
      interceptionContext: "/feed",
      previousNextUrl: "/feed",
      rootLayoutTreePath: "/",
      routeId: "route:/photos/42\0/feed",
    });

    expect(nextState.interceptionContext).toBe("/feed");
    expect(nextState.previousNextUrl).toBe("/feed");
  });
});

describe("app browser navigation controller", () => {
  it("tracks active navigation ids and clears the pending pathname only for the current navigation", () => {
    const { controller, detach } = createControllerHarness();
    const clearSpy = vi.spyOn(navigationShim, "clearPendingPathname").mockImplementation(() => {});

    try {
      const firstNavId = controller.beginNavigation();
      const secondNavId = controller.beginNavigation();

      expect(controller.isCurrentNavigation(firstNavId)).toBe(false);
      expect(controller.isCurrentNavigation(secondNavId)).toBe(true);

      controller.finalizeNavigation(firstNavId, null);
      expect(clearSpy).not.toHaveBeenCalled();

      controller.finalizeNavigation(secondNavId, null);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledWith(secondNavId);
    } finally {
      detach();
    }
  });

  it("uses render ids independent from navigation ids", async () => {
    const { controller, detach, stateRef } = createControllerHarness();
    const clearSpy = vi.spyOn(navigationShim, "clearPendingPathname").mockImplementation(() => {});

    try {
      // Navigation counter advances independently from render-id counter.
      controller.beginNavigation(); // 1
      controller.beginNavigation(); // 2
      const navId = controller.beginNavigation(); // 3

      const nextElements = Promise.resolve(
        createResolvedElements("route:/dashboard", "/", null, {
          "page:/dashboard": React.createElement("main", null, "dashboard"),
        }),
      );

      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => vi.fn(),
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements,
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId,
        useTransition: false,
      });

      // Yield microticks so the async function reaches dispatch and sets state.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // renderId is 1 (first render allocation), independent from navId = 3.
      expect(stateRef.current.renderId).toBe(1);
      expect(stateRef.current.routeId).toBe("route:/dashboard");
    } finally {
      clearSpy.mockRestore();
      detach();
    }
  });

  it("settles the previous pending browser-router promise when a newer pending state begins", async () => {
    const { controller, detach, stateRef } = createControllerHarness();
    const clearSpy = vi.spyOn(navigationShim, "clearPendingPathname").mockImplementation(() => {});

    try {
      const firstPending = controller.beginPendingBrowserRouterState();
      expect(firstPending.settled).toBe(false);

      const secondPending = controller.beginPendingBrowserRouterState();

      await expect(firstPending.promise).resolves.toBe(stateRef.current);
      expect(firstPending.settled).toBe(true);

      controller.finalizeNavigation(controller.beginNavigation(), secondPending);
      await expect(secondPending.promise).resolves.toBe(stateRef.current);
      expect(secondPending.settled).toBe(true);
    } finally {
      clearSpy.mockRestore();
      detach();
    }
  });

  it("queues pre-paint commit effects and resolves the pending browser-router state on dispatch", async () => {
    const { controller, detach, setBrowserRouterState, stateRef } = createControllerHarness();
    const pendingRouterState = controller.beginPendingBrowserRouterState();
    const commitEffect = vi.fn();
    const createNavigationCommitEffect = vi.fn(() => commitEffect);
    const nextElements = Promise.resolve(
      createResolvedElements("route:/dashboard", "/", null, {
        "page:/dashboard": React.createElement("main", null, "dashboard"),
      }),
    );

    try {
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect,
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements,
        operationLane: "navigation",
        params: {},
        pendingRouterState,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId: controller.beginNavigation(),
        useTransition: false,
      });

      await expect(pendingRouterState.promise).resolves.toMatchObject({
        renderId: 1,
        routeId: "route:/dashboard",
      });
      expect(createNavigationCommitEffect).toHaveBeenCalledTimes(1);
      expect(commitEffect).not.toHaveBeenCalled();
      expect(setBrowserRouterState).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
  });

  it("skips stale browser navigations before committing their payload", async () => {
    const { controller, detach } = createControllerHarness();
    const { assign } = stubWindow("https://example.com/initial");
    const createNavigationCommitEffect = vi.fn(() => vi.fn());
    let resolveNextElements: ((value: AppElements) => void) | undefined;
    const nextElements = new Promise<AppElements>((resolve) => {
      resolveNextElements = resolve;
    });

    try {
      const navId = controller.beginNavigation();
      const renderPromise = controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect,
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
        nextElements,
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId,
        useTransition: false,
      });

      controller.beginNavigation();

      if (!resolveNextElements) {
        throw new Error("Expected deferred navigation payload resolver");
      }
      resolveNextElements(
        createResolvedElements("route:/dashboard", "/", null, {
          "page:/dashboard": React.createElement("main", null, "dashboard"),
        }),
      );

      await expect(renderPromise).resolves.toBe("no-commit");
      expect(createNavigationCommitEffect).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it("renderNavigationPayload stays pending until NavigationCommitSignal settles the commit", async () => {
    const { controller, detach, stateRef } = createControllerHarness();
    const commitEffect = vi.fn();
    const nextElements = Promise.resolve(
      createResolvedElements("route:/dashboard", "/", null, {
        "page:/dashboard": React.createElement("main", null, "dashboard"),
      }),
    );

    try {
      const navId = controller.beginNavigation();
      const renderPromise = controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => commitEffect,
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements,
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId,
        useTransition: false,
      });

      // Yield enough microticks for the async function to reach dispatch
      // and return the committed promise.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Pre-paint effect is queued but not yet run (drainPrePaintEffects
      // only fires inside NavigationCommitSignal's useLayoutEffect).
      expect(commitEffect).not.toHaveBeenCalled();

      // The promise must not resolve — NavigationCommitSignal has not
      // mounted, so resolveCommittedNavigations has no way to fire.
      const settled = await Promise.race([
        renderPromise.then(() => true),
        Promise.resolve().then(() => false),
      ]);
      expect(settled).toBe(false);
    } finally {
      detach();
    }
  });

  it("dispatches same-URL server action payloads into the browser router state", async () => {
    const initialState = createState({
      rootLayoutTreePath: "/",
      routeId: "route:/settings",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {
        tab: "profile",
      }),
    });
    const { controller, detach, stateRef } = createControllerHarness(initialState);
    const { assign } = stubWindow("https://example.com/settings");
    const nextElements = Promise.resolve(
      createResolvedElements("route:/settings/account", "/", null, {
        "page:/settings/account": React.createElement("main", null, "account"),
      }),
    );

    try {
      const result = await controller.commitSameUrlNavigatePayload(
        nextElements,
        stateRef.current.navigationSnapshot,
        {
          data: "server-action-result",
          ok: true,
        },
      );

      expect(result).toBe("server-action-result");
      expect(assign).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/settings/account");
      expect(stateRef.current.previousNextUrl).toBeNull();
      expect(stateRef.current.visibleCommitVersion).toBe(1);
      expect(stateRef.current.activeOperation).toMatchObject({
        lane: "server-action",
        startedVisibleCommitVersion: 0,
        state: "committed",
        visibleCommitVersion: 1,
      });
    } finally {
      detach();
    }
  });

  it("does not let older same-URL server action payloads overwrite newer visible commits", async () => {
    const initialState = createState({
      rootLayoutTreePath: "/",
      routeId: "route:/settings",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {
        tab: "profile",
      }),
    });
    const { controller, detach, stateRef } = createControllerHarness(initialState);
    const { assign } = stubWindow("https://example.com/settings");
    let resolveOlderPayload!: (elements: AppElements) => void;
    const olderPayload = new Promise<AppElements>((resolve) => {
      resolveOlderPayload = resolve;
    });

    try {
      const olderResult = controller.commitSameUrlNavigatePayload(
        olderPayload,
        stateRef.current.navigationSnapshot,
        {
          data: "older-action-result",
          ok: true,
        },
      );

      const newerResult = await controller.commitSameUrlNavigatePayload(
        Promise.resolve(
          createResolvedElements("route:/settings/newer", "/", null, {
            "page:/settings/newer": React.createElement("main", null, "newer"),
          }),
        ),
        stateRef.current.navigationSnapshot,
        {
          data: "newer-action-result",
          ok: true,
        },
      );

      expect(newerResult).toBe("newer-action-result");
      expect(stateRef.current.routeId).toBe("route:/settings/newer");
      expect(stateRef.current.visibleCommitVersion).toBe(1);

      resolveOlderPayload(
        createResolvedElements("route:/settings/older", "/", null, {
          "page:/settings/older": React.createElement("main", null, "older"),
        }),
      );

      await expect(olderResult).resolves.toBe("older-action-result");
      expect(assign).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/settings/newer");
      expect(stateRef.current.visibleCommitVersion).toBe(1);
      expect(stateRef.current.activeOperation).toMatchObject({
        lane: "server-action",
        startedVisibleCommitVersion: 0,
        state: "committed",
        visibleCommitVersion: 1,
      });
    } finally {
      detach();
    }
  });

  it("revalidates same-URL server action commits immediately before dispatch", async () => {
    const controller = createAppBrowserNavigationController();
    const initialState = createState({
      rootLayoutTreePath: "/",
      routeId: "route:/settings",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {
        tab: "profile",
      }),
    });
    let currentState = initialState;
    let staleBeforeDispatch = false;
    const stateRef = {
      get current(): AppRouterState {
        if (staleBeforeDispatch) {
          staleBeforeDispatch = false;
          queueMicrotask(() => {
            currentState = createState({
              routeId: "route:/settings/newer",
              visibleCommitVersion: 1,
            });
          });
        }

        return currentState;
      },
      set current(value: AppRouterState) {
        currentState = value;
      },
    };
    const setBrowserRouterState = vi.fn((value: AppRouterState | Promise<AppRouterState>) => {
      if (!(value instanceof Promise)) {
        stateRef.current = value;
      }
    });
    const detach = controller.attachBrowserRouterState(setBrowserRouterState, stateRef);
    const { assign } = stubWindow("https://example.com/settings");
    let resolvePayload!: (elements: AppElements) => void;
    const payload = new Promise<AppElements>((resolve) => {
      resolvePayload = resolve;
    });

    try {
      const result = controller.commitSameUrlNavigatePayload(
        payload,
        stateRef.current.navigationSnapshot,
        {
          data: "older-action-result",
          ok: true,
        },
      );

      staleBeforeDispatch = true;
      resolvePayload(
        createResolvedElements("route:/settings/older", "/", null, {
          "page:/settings/older": React.createElement("main", null, "older"),
        }),
      );

      await expect(result).resolves.toBe("older-action-result");
      expect(assign).not.toHaveBeenCalled();
      expect(currentState.routeId).toBe("route:/settings/newer");
      expect(currentState.visibleCommitVersion).toBe(1);
    } finally {
      detach();
    }
  });

  it("uses the server-action initiation state when the response is processed after a newer commit", async () => {
    const initialState = createState({
      rootLayoutTreePath: "/",
      routeId: "route:/settings",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {
        tab: "profile",
      }),
    });
    const { controller, detach, stateRef } = createControllerHarness(initialState);
    const { assign } = stubWindow("https://example.com/settings");
    const actionInitiationState = stateRef.current;

    try {
      const newerResult = await controller.commitSameUrlNavigatePayload(
        Promise.resolve(
          createResolvedElements("route:/settings/newer", "/", null, {
            "page:/settings/newer": React.createElement("main", null, "newer"),
          }),
        ),
        stateRef.current.navigationSnapshot,
        {
          data: "newer-action-result",
          ok: true,
        },
      );

      expect(newerResult).toBe("newer-action-result");
      expect(stateRef.current.routeId).toBe("route:/settings/newer");
      expect(stateRef.current.visibleCommitVersion).toBe(1);

      const olderResult = await controller.commitSameUrlNavigatePayload(
        Promise.resolve(
          createResolvedElements("route:/settings/older", "/", null, {
            "page:/settings/older": React.createElement("main", null, "older"),
          }),
        ),
        actionInitiationState.navigationSnapshot,
        {
          data: "older-action-result",
          ok: true,
        },
        actionInitiationState,
      );

      expect(olderResult).toBe("older-action-result");
      expect(assign).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/settings/newer");
      expect(stateRef.current.visibleCommitVersion).toBe(1);
    } finally {
      detach();
    }
  });

  it("hard-navigates same-URL server action payloads when the root layout changes", async () => {
    const initialState = createState({
      rootLayoutTreePath: "/(marketing)",
      routeId: "route:/marketing",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/marketing", {}),
    });
    const { controller, detach, stateRef } = createControllerHarness(initialState);
    const { assign } = stubWindow("https://example.com/marketing");
    const nextElements = Promise.resolve(
      createResolvedElements("route:/dashboard", "/(dashboard)", null, {
        "page:/dashboard": React.createElement("main", null, "dashboard"),
      }),
    );

    try {
      const result = await controller.commitSameUrlNavigatePayload(
        nextElements,
        stateRef.current.navigationSnapshot,
      );

      expect(result).toBeUndefined();
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith("https://example.com/marketing");
      expect(stateRef.current.routeId).toBe("route:/marketing");
    } finally {
      detach();
    }
  });
});

describe("app browser navigation lifecycle settlement", () => {
  it("most recent navigation commits when three are started and payloads resolve in reverse order", async () => {
    const { controller, detach, stateRef } = createControllerHarness();
    let resolveA!: (elements: AppElements) => void;
    let resolveB!: (elements: AppElements) => void;

    const payloadA = new Promise<AppElements>((r) => {
      resolveA = r;
    });
    const payloadB = new Promise<AppElements>((r) => {
      resolveB = r;
    });
    const payloadC = Promise.resolve(
      createResolvedElements("route:/c", "/", null, {
        "page:/c": React.createElement("main", null, "C"),
      }),
    );

    const effectsRun: string[] = [];

    try {
      // Start three navigations. Only C is the current (winning) one.
      const navA = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => {
          effectsRun.push("A");
          return () => {};
        },
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: payloadA,
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/a",
        navId: navA,
        useTransition: false,
      });

      const navB = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => {
          effectsRun.push("B");
          return () => {};
        },
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: payloadB,
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/b",
        navId: navB,
        useTransition: false,
      });

      const navC = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => {
          effectsRun.push("C");
          return () => {};
        },
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: payloadC,
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/c",
        navId: navC,
        useTransition: false,
      });

      // Yield so C's async payload resolves and state is committed.
      // renderNavigationPayload returns a promise that settles only when
      // NavigationCommitSignal fires (a React component not mounted in
      // unit tests). The state mutation through dispatchApprovedVisibleCommit is
      // synchronous when useTransition=false, so we verify via stateRef.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(stateRef.current.routeId).toBe("route:/c");

      // B resolves after C was committed — stale, must be skipped.
      resolveB(
        createResolvedElements("route:/b", "/", null, {
          "page:/b": React.createElement("main", null, "B"),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(stateRef.current.routeId).toBe("route:/c");

      // A resolves last — most stale, must be skipped.
      resolveA(
        createResolvedElements("route:/a", "/", null, {
          "page:/a": React.createElement("main", null, "A"),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(stateRef.current.routeId).toBe("route:/c");

      // Only C's commit effect was queued. A and B were classified as
      // "skip" before createNavigationCommitEffect ever ran.
      expect(effectsRun).toEqual(["C"]);
    } finally {
      detach();
    }
  });

  it("stale cross-root navigation is skipped instead of hard-navigating", async () => {
    // A navigation that crosses a root-layout boundary requires a hard
    // navigation. But a stale navigation (superseded by a newer one) must NOT
    // hard-navigate, even if the payload says the roots differ. A "skip" for
    // the stale operation must take priority over a "hard-navigate" for a
    // navigation that is no longer current.
    const { controller, detach, stateRef } = createControllerHarness(
      createState({ rootLayoutTreePath: "/(marketing)" }),
    );
    const { assign } = stubWindow("https://example.com/marketing");
    let resolveCrossRoot!: (elements: AppElements) => void;
    const crossRootPayload = new Promise<AppElements>((r) => {
      resolveCrossRoot = r;
    });

    try {
      // Start cross-root navigation A (deferred, /(marketing) → /(dashboard)).
      const navA = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: crossRootPayload,
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId: navA,
        useTransition: false,
      });

      // Start new navigation B (same root). B advances activeNavigationId past A.
      const navB = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: Promise.resolve(
          createResolvedElements("route:/marketing/settings", "/(marketing)", null, {
            "page:/marketing/settings": React.createElement("main", null, "settings"),
          }),
        ),
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/marketing/settings",
        navId: navB,
        useTransition: false,
      });

      // Yield so B's async payload resolves and state commits.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(stateRef.current.routeId).toBe("route:/marketing/settings");

      // Now resolve the stale cross-root payload. It has a different root
      // layout, but the navigation it belongs to is no longer current.
      resolveCrossRoot(
        createResolvedElements("route:/dashboard", "/(dashboard)", null, {
          "page:/dashboard": React.createElement("main", null, "dashboard"),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      // Must NOT have hard-navigated. The stale operation is simply skipped.
      expect(assign).not.toHaveBeenCalled();
      // The visible route must be B's, not A's stale payload.
      expect(stateRef.current.routeId).toBe("route:/marketing/settings");
    } finally {
      detach();
    }
  });

  it("keeps a newer visible commit when an older refresh resolves late", async () => {
    const { controller, detach, stateRef } = createControllerHarness();
    let resolveRefresh!: (elements: AppElements) => void;
    const refreshPayload = new Promise<AppElements>((resolve) => {
      resolveRefresh = resolve;
    });

    try {
      const refreshNav = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: undefined,
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: refreshPayload,
        operationLane: "refresh",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/initial",
        navId: refreshNav,
        useTransition: false,
      });

      await controller.hmrReplaceTree(
        Promise.resolve(
          createResolvedElements("route:/hmr", "/", null, {
            "page:/hmr": React.createElement("main", null, "hmr"),
          }),
        ),
        stateRef.current.navigationSnapshot,
      );
      expect(stateRef.current.routeId).toBe("route:/hmr");

      resolveRefresh(
        createResolvedElements("route:/initial-refreshed", "/", null, {
          "page:/initial": React.createElement("main", null, "refreshed"),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(stateRef.current.routeId).toBe("route:/hmr");
      expect(stateRef.current.activeOperation).toMatchObject({
        lane: "hmr",
        state: "committed",
        visibleCommitVersion: 1,
      });
    } finally {
      detach();
    }
  });

  it("settles pending state without patching visible UI when an older traverse resolves late", async () => {
    const { controller, detach, stateRef } = createControllerHarness();
    let resolveTraverse!: (elements: AppElements) => void;
    const traversePayload = new Promise<AppElements>((resolve) => {
      resolveTraverse = resolve;
    });

    try {
      const traversePendingState = controller.beginPendingBrowserRouterState();
      const traverseNav = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "traverse",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: undefined,
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: traversePayload,
        operationLane: "traverse",
        params: {},
        pendingRouterState: traversePendingState,
        previousNextUrl: null,
        targetHref: "https://example.com/previous",
        navId: traverseNav,
        useTransition: false,
      });

      await controller.hmrReplaceTree(
        Promise.resolve(
          createResolvedElements("route:/hmr", "/", null, {
            "page:/hmr": React.createElement("main", null, "hmr"),
          }),
        ),
        stateRef.current.navigationSnapshot,
      );

      resolveTraverse(
        createResolvedElements("route:/previous", "/", null, {
          "page:/previous": React.createElement("main", null, "previous"),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      await expect(traversePendingState.promise).resolves.toBe(stateRef.current);
      expect(traversePendingState.settled).toBe(true);
      expect(stateRef.current.routeId).toBe("route:/hmr");
      expect(stateRef.current.activeOperation).toMatchObject({
        lane: "hmr",
        state: "committed",
        visibleCommitVersion: 1,
      });
    } finally {
      detach();
    }
  });

  it("resolveAndClassifyNavigationCommit classifies skip when IDs have diverged", async () => {
    const result = await resolveAndClassifyNavigationCommit({
      activeNavigationId: 9,
      currentState: createState(),
      navigationSnapshot: createState().navigationSnapshot,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      operationLane: "navigation",
      renderId: 3,
      startedNavigationId: 5,
      type: "navigate",
    });

    expect(result.decision.disposition).toBe("no-commit");
    expect(result.pending.routeId).toBe("route:/dashboard");
  });

  it("uses the active navigation getter after the payload resolves", async () => {
    const currentState = createState();
    let activeNavigationId = 5;
    let resolvePayload!: (elements: AppElements) => void;
    const payload = new Promise<AppElements>((resolve) => {
      resolvePayload = resolve;
    });

    const resultPromise = resolveAndClassifyNavigationCommit({
      activeNavigationId,
      currentState,
      getActiveNavigationId: () => activeNavigationId,
      navigationSnapshot: currentState.navigationSnapshot,
      nextElements: payload,
      operationLane: "server-action",
      renderId: 24,
      startedNavigationId: 5,
      type: "navigate",
    });

    activeNavigationId = 9;
    resolvePayload(createResolvedElements("route:/dashboard", "/"));

    const result = await resultPromise;
    expect(result.decision.disposition).toBe("no-commit");
    expect(result.approvedCommit).toBeNull();
    expect(result.trace.entries).toEqual([
      {
        code: NavigationTraceTransactionCodes.noCommit,
        fields: {
          operationLane: "server-action",
          pendingOperationId: 24,
          startedVisibleCommitVersion: 0,
        },
      },
      {
        code: NavigationTraceReasonCodes.staleOperation,
        fields: {
          activeNavigationId: 9,
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 0,
          nextRootLayoutTreePath: "/",
          startedNavigationId: 5,
          startedVisibleCommitVersion: 0,
        },
      },
    ]);
  });

  it("uses the approval state getter after the payload resolves", async () => {
    const startedState = createState({ visibleCommitVersion: 0 });
    let approvalState = startedState;
    let resolvePayload!: (elements: AppElements) => void;
    const payload = new Promise<AppElements>((resolve) => {
      resolvePayload = resolve;
    });

    const resultPromise = resolveAndClassifyNavigationCommit({
      activeNavigationId: 8,
      currentState: startedState,
      getCurrentStateForApproval: () => approvalState,
      navigationSnapshot: startedState.navigationSnapshot,
      nextElements: payload,
      operationLane: "server-action",
      renderId: 25,
      startedNavigationId: 8,
      type: "navigate",
    });

    approvalState = createState({
      routeId: "route:/newer",
      visibleCommitVersion: 1,
    });
    resolvePayload(createResolvedElements("route:/dashboard", "/"));

    const result = await resultPromise;
    expect(result.decision.disposition).toBe("no-commit");
    expect(result.approvedCommit).toBeNull();
    expect(result.trace.entries).toEqual([
      {
        code: NavigationTraceTransactionCodes.noCommit,
        fields: {
          operationLane: "server-action",
          pendingOperationId: 25,
          startedVisibleCommitVersion: 0,
        },
      },
      {
        code: NavigationTraceReasonCodes.staleOperation,
        fields: {
          activeNavigationId: 8,
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 1,
          nextRootLayoutTreePath: "/",
          startedNavigationId: 8,
          startedVisibleCommitVersion: 0,
        },
      },
    ]);
  });

  it("failed payload cleanly settles the pending router state without leaving it hanging", async () => {
    const { controller, detach } = createControllerHarness();
    const clearSpy = vi.spyOn(navigationShim, "clearPendingPathname").mockImplementation(() => {});
    const pendingRouterState = controller.beginPendingBrowserRouterState();

    try {
      const navId = controller.beginNavigation();
      const renderPromise = controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
        nextElements: Promise.reject(new Error("RSC fetch failed")),
        operationLane: "navigation",
        params: {},
        pendingRouterState,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId,
        useTransition: false,
      });

      await expect(renderPromise).rejects.toThrow("RSC fetch failed");

      // The pending router promise must be settled so callers don't hang.
      await expect(pendingRouterState.promise).resolves.toBeDefined();
      expect(pendingRouterState.settled).toBe(true);
    } finally {
      clearSpy.mockRestore();
      detach();
    }
  });
});

describe("app browser root-layout hard navigation", () => {
  it("renderNavigationPayload calls window.location.assign when root layout changes", async () => {
    const { controller, detach } = createControllerHarness(
      createState({ rootLayoutTreePath: "/(marketing)" }),
    );
    const { assign } = stubWindow("https://example.com/marketing");
    const createNavigationCommitEffect = vi.fn();

    try {
      const navId = controller.beginNavigation();
      const renderPromise = controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect,
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot(
          "https://example.com/marketing",
          {},
        ),
        nextElements: Promise.resolve(
          createResolvedElements("route:/dashboard", "/(dashboard)", null, {
            "page:/dashboard": React.createElement("main", null, "dashboard"),
          }),
        ),
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId,
        useTransition: false,
      });

      await expect(renderPromise).resolves.toBe("hard-navigate");
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith("https://example.com/dashboard");
      expect(createNavigationCommitEffect).not.toHaveBeenCalled();
    } finally {
      detach();
    }
  });

  it("hard-navigate settles the pending router state before navigating away", async () => {
    const { controller, detach } = createControllerHarness(
      createState({ rootLayoutTreePath: "/(marketing)" }),
    );
    const { assign } = stubWindow("https://example.com/marketing");
    const pendingRouterState = controller.beginPendingBrowserRouterState();
    assign.mockImplementation(() => {
      expect(pendingRouterState.settled).toBe(true);
    });

    try {
      const navId = controller.beginNavigation();
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot(
          "https://example.com/marketing",
          {},
        ),
        nextElements: Promise.resolve(
          createResolvedElements("route:/dashboard", "/(dashboard)", null, {
            "page:/dashboard": React.createElement("main", null, "dashboard"),
          }),
        ),
        operationLane: "navigation",
        params: {},
        pendingRouterState,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId,
        useTransition: false,
      });

      // Yield so the async function runs the settle+hard-navigate path.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(assign).toHaveBeenCalledTimes(1);
      await expect(pendingRouterState.promise).resolves.toBeDefined();
    } finally {
      detach();
    }
  });
});

describe("app browser entry previousNextUrl helpers", () => {
  it("stores previousNextUrl alongside existing history state", () => {
    expect(
      createHistoryStateWithPreviousNextUrl(
        {
          __vinext_scrollY: 120,
        },
        "/feed?tab=latest",
      ),
    ).toEqual({
      __vinext_previousNextUrl: "/feed?tab=latest",
      __vinext_scrollY: 120,
    });
  });

  it("drops previousNextUrl when cleared", () => {
    expect(
      createHistoryStateWithPreviousNextUrl(
        {
          __vinext_previousNextUrl: "/feed",
          __vinext_scrollY: 120,
        },
        null,
      ),
    ).toEqual({
      __vinext_scrollY: 120,
    });
  });

  it("reads previousNextUrl from history state", () => {
    expect(
      readHistoryStatePreviousNextUrl({
        __vinext_previousNextUrl: "/feed?tab=latest",
      }),
    ).toBe("/feed?tab=latest");
  });

  it("derives interception context from previousNextUrl pathname", () => {
    expect(resolveInterceptionContextFromPreviousNextUrl("/feed?tab=latest")).toBe("/feed");
  });

  it("returns null when previousNextUrl is missing", () => {
    expect(readHistoryStatePreviousNextUrl({})).toBeNull();
    expect(resolveInterceptionContextFromPreviousNextUrl(null)).toBeNull();
  });

  it("classifies pending commits in one step for same-url payloads", async () => {
    const currentState = createState({
      rootLayoutTreePath: "/(marketing)",
    });

    const result = await resolveAndClassifyNavigationCommit({
      activeNavigationId: 7,
      currentState,
      navigationSnapshot: currentState.navigationSnapshot,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/(dashboard)")),
      operationLane: "server-action",
      renderId: 3,
      startedNavigationId: 7,
      type: "navigate",
    });

    expect(result.decision.disposition).toBe("hard-navigate");
    expect(result.pending.routeId).toBe("route:/dashboard");
    expect(result.pending.action.renderId).toBe(3);
    expect(result.trace.entries[0]?.code).toBe(NavigationTraceTransactionCodes.hardNavigate);
    expect(result.trace.entries[1]?.code).toBe(NavigationTraceReasonCodes.rootBoundaryChanged);
  });

  it("creates navigation trace entries without retaining field ownership", () => {
    const fields = { activeNavigationId: 1 };
    const trace = createNavigationTrace(NavigationTraceReasonCodes.commitCurrent, fields);

    fields.activeNavigationId = 2;

    expect(trace.entries).toEqual([
      {
        code: NavigationTraceReasonCodes.commitCurrent,
        fields: { activeNavigationId: 1 },
      },
    ]);
  });

  it("treats null root-layout identities as soft-navigation compatible", () => {
    expect(shouldHardNavigate(null, null)).toBe(false);
    expect(shouldHardNavigate(null, "/")).toBe(false);
    expect(shouldHardNavigate("/", null)).toBe(false);
  });

  it("clears stale parallel slots on approved traverse commits", async () => {
    const state = createState({
      elements: createResolvedElements("route:/feed", "/", null, {
        "slot:modal:/feed": React.createElement("div", null, "modal"),
      }),
    });

    const nextState = await applyApprovedTestCommit(state, {
      previousNextUrl: null,
      rootLayoutTreePath: "/",
      routeId: "route:/feed",
      type: "traverse",
    });

    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(false);
  });

  it("preserves absent parallel slots on approved navigate commits", async () => {
    const state = createState({
      elements: createResolvedElements("route:/feed", "/", null, {
        "slot:modal:/feed": React.createElement("div", null, "modal"),
      }),
    });

    const nextState = await applyApprovedTestCommit(state, {
      rootLayoutTreePath: "/",
      routeId: "route:/feed/comments",
    });

    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(true);
  });
});

describe("devOnCaughtError (hydrateRoot dev handler)", () => {
  it("logs caught errors to console.error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = new Error("Maximum update depth exceeded");
      devOnCaughtError(err, { componentStack: "\n    at List\n    at Apps" });
      expect(consoleSpy).toHaveBeenCalled();
      const loggedErrors = consoleSpy.mock.calls.map((args) => args[0]);
      expect(loggedErrors).toContain(err);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("includes the React component stack in the log when provided", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      devOnCaughtError(new Error("boom"), {
        componentStack: "\n    at List (apps/list.tsx:202)",
      });
      expect(consoleSpy).toHaveBeenCalledTimes(2);
      expect(String(consoleSpy.mock.calls[1][0])).toContain("apps/list.tsx:202");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not re-dispatch a window 'error' event (would trigger Vite overlay)", () => {
    // This test runs in a Node environment where `window` is undefined, so the
    // listener registration is skipped and windowErrorCount stays 0 trivially.
    // The test still documents the contract: devOnCaughtError must not dispatch
    // window error events (which would re-trigger the Vite overlay). If a DOM
    // environment is ever added to this project, this will become a live check.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let windowErrorCount = 0;
    const onError = (): void => {
      windowErrorCount += 1;
    };
    if (typeof window !== "undefined") {
      window.addEventListener("error", onError);
    }
    try {
      devOnCaughtError(new Error("caught by user error.tsx"), {});
      expect(windowErrorCount).toBe(0);
    } finally {
      if (typeof window !== "undefined") {
        window.removeEventListener("error", onError);
      }
      consoleSpy.mockRestore();
    }
  });

  it("is not a no-op (regression guard against `() => {}`)", () => {
    // Explicit regression guard: the original implementation was `() => {}`,
    // which silently swallowed all caught errors. This test ensures the handler
    // always calls console.error at least once.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      devOnCaughtError(new Error("regression"), {});
      expect(consoleSpy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("createOnUncaughtError (hydrateRoot uncaught handler)", () => {
  function withFakeWindow<T>(fn: (assignSpy: ReturnType<typeof vi.fn>) => T): T {
    const assignSpy = vi.fn();
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: { assign: assignSpy },
    };
    try {
      return fn(assignSpy);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  }

  it("hard-navigates to the recovery href when one is pending", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withFakeWindow((assignSpy) => {
        const handler = createOnUncaughtError(() => "/broken-route");
        handler(new Error("render boom"), {});
        expect(assignSpy).toHaveBeenCalledWith("/broken-route");
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not navigate when no navigation is in flight (initial hydration error)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withFakeWindow((assignSpy) => {
        const handler = createOnUncaughtError(() => null);
        handler(new Error("hydration boom"), {});
        expect(assignSpy).not.toHaveBeenCalled();
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("logs the error and component stack regardless of recovery", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withFakeWindow(() => {
        const handler = createOnUncaughtError(() => null);
        const err = new Error("boom");
        handler(err, { componentStack: "\n    at Page (page.tsx:10)" });
        const loggedFirst = consoleSpy.mock.calls[0]?.[0];
        expect(loggedFirst).toBe(err);
        expect(String(consoleSpy.mock.calls[1]?.[0])).toContain("page.tsx:10");
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("reads the recovery href lazily so newer navigations win", () => {
    // Module-level pendingNavigationRecoveryHref is reassigned across
    // navigations; the handler must read it at call time, not at construction.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withFakeWindow((assignSpy) => {
        let current: string | null = "/first";
        const handler = createOnUncaughtError(() => current);
        current = "/second";
        handler(new Error("late error"), {});
        expect(assignSpy).toHaveBeenCalledWith("/second");
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("mounted slot helpers", () => {
  it("collects only mounted slot ids", () => {
    const elements: AppElements = createResolvedElements("route:/dashboard", "/", null, {
      "layout:/": React.createElement("div", null, "layout"),
      "slot:modal:/": React.createElement("div", null, "modal"),
      "slot:sidebar:/": React.createElement("div", null, "sidebar"),
      "slot:ghost:/": null,
      "slot:missing:/": UNMATCHED_SLOT,
    });

    expect(getMountedSlotIds(elements)).toEqual(["slot:modal:/", "slot:sidebar:/"]);
  });

  it("serializes mounted slot ids into a stable header value", () => {
    const elements: AppElements = createResolvedElements("route:/dashboard", "/", null, {
      "slot:z:/": React.createElement("div", null, "z"),
      "slot:a:/": React.createElement("div", null, "a"),
    });

    expect(getMountedSlotIdsHeader(elements)).toBe("slot:a:/ slot:z:/");
  });

  it("returns null when there are no mounted slots", () => {
    const elements: AppElements = createResolvedElements("route:/dashboard", "/", null, {
      "slot:ghost:/": null,
      "slot:missing:/": UNMATCHED_SLOT,
    });

    expect(getMountedSlotIdsHeader(elements)).toBeNull();
  });
});

describe("resolveServerActionRequestState", () => {
  it("includes only the RSC markers and x-rsc-action when previousNextUrl is null and no slots are mounted", () => {
    const elements = createResolvedElements("route:/settings", "/");

    const { headers } = resolveServerActionRequestState({
      actionId: "action-abc",
      basePath: "",
      elements,
      previousNextUrl: null,
    });

    expect(Array.from(headers.keys()).sort()).toEqual(["accept", "rsc", "x-rsc-action"]);
    expect(headers.get("accept")).toBe("text/x-component");
    expect(headers.get("rsc")).toBe("1");
    expect(headers.get("x-rsc-action")).toBe("action-abc");
  });

  it("derives X-Vinext-Interception-Context from previousNextUrl", () => {
    const elements = createResolvedElements("route:/photos/42", "/");
    const previousNextUrl = "/feed?tab=latest";

    const { headers } = resolveServerActionRequestState({
      actionId: "bump-likes",
      basePath: "",
      elements,
      previousNextUrl,
    });

    expect(headers.get("X-Vinext-Interception-Context")).toBe(
      resolveInterceptionContextFromPreviousNextUrl(previousNextUrl, ""),
    );
  });

  it("strips the base path when deriving the interception context", () => {
    const elements = createResolvedElements("route:/photos/42", "/");
    const previousNextUrl = "/app/feed";

    const { headers } = resolveServerActionRequestState({
      actionId: "bump-likes",
      basePath: "/app",
      elements,
      previousNextUrl,
    });

    expect(headers.get("X-Vinext-Interception-Context")).toBe(
      resolveInterceptionContextFromPreviousNextUrl(previousNextUrl, "/app"),
    );
  });

  it("derives X-Vinext-Mounted-Slots from mounted slot keys", () => {
    const elements: AppElements = createResolvedElements("route:/feed", "/", null, {
      "slot:@modal:/feed": React.createElement("div", null, "modal"),
      "slot:@sidebar:/feed": React.createElement("div", null, "sidebar"),
    });

    const { headers } = resolveServerActionRequestState({
      actionId: "action-x",
      basePath: "",
      elements,
      previousNextUrl: null,
    });

    expect(headers.get("X-Vinext-Mounted-Slots")).toBe(getMountedSlotIdsHeader(elements));
  });

  it("omits headers whose derived values are null", () => {
    const elements: AppElements = createResolvedElements("route:/settings", "/", null, {
      "slot:ghost:/": null,
      "slot:missing:/": UNMATCHED_SLOT,
    });

    const { headers } = resolveServerActionRequestState({
      actionId: "action-y",
      basePath: "",
      elements,
      previousNextUrl: null,
    });

    expect(headers.has("X-Vinext-Interception-Context")).toBe(false);
    expect(headers.has("X-Vinext-Mounted-Slots")).toBe(false);
  });
});
