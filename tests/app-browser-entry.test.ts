import React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createOnUncaughtError } from "../packages/vinext/src/server/app-browser-error.js";
import { createAppBrowserNavigationController } from "../packages/vinext/src/server/app-browser-navigation-controller.js";
import { devOnCaughtError } from "../packages/vinext/src/server/dev-error-overlay.js";
import {
  APP_INTERCEPTION_CONTEXT_KEY,
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
  createOperationRecord,
  createPendingNavigationCommit,
  readHistoryStatePreviousNextUrl,
  resolveAndClassifyNavigationCommit,
  resolveInterceptionContextFromPreviousNextUrl,
  resolveServerActionRequestState,
  routerReducer,
  resolvePendingNavigationCommitDisposition,
  shouldHardNavigate,
  type AppRouterState,
} from "../packages/vinext/src/server/app-browser-state.js";

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

function createTestOperation(
  state: AppRouterState,
  id = 1,
): ReturnType<typeof createOperationRecord> {
  return createOperationRecord({
    id,
    lane: "navigation",
    startedVisibleCommitVersion: state.visibleCommitVersion,
  });
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

  it("merges elements on navigate", async () => {
    const previousElements = createResolvedElements("route:/initial", "/", null, {
      "layout:/": React.createElement("div", null, "layout"),
    });
    const nextElements = createResolvedElements("route:/next", "/", null, {
      "page:/next": React.createElement("main", null, "next"),
    });
    const state = createState({
      elements: previousElements,
    });

    const nextState = routerReducer(state, {
      elements: nextElements,
      interceptionContext: null,
      layoutFlags: {},
      navigationSnapshot: createState().navigationSnapshot,
      operation: createTestOperation(state),
      previousNextUrl: null,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/next",
      type: "navigate",
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

  it("replaces elements on replace", () => {
    const nextElements = createResolvedElements("route:/next", "/", null, {
      "page:/next": React.createElement("main", null, "next"),
    });

    const state = createState();
    const nextState = routerReducer(state, {
      elements: nextElements,
      interceptionContext: null,
      layoutFlags: {},
      navigationSnapshot: createState().navigationSnapshot,
      operation: createTestOperation(state),
      previousNextUrl: null,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/next",
      type: "replace",
    });

    expect(nextState.elements).toBe(nextElements);
    expect(nextState.interceptionContext).toBeNull();
    expect(nextState.previousNextUrl).toBeNull();
    expect(nextState.elements).toMatchObject({
      "page:/next": expect.anything(),
    });
  });

  it("increments the visible commit version once per visible reducer commit", () => {
    const initialState = createState();
    const firstState = routerReducer(initialState, {
      elements: createResolvedElements("route:/one", "/"),
      interceptionContext: null,
      layoutFlags: {},
      navigationSnapshot: initialState.navigationSnapshot,
      operation: createTestOperation(initialState, 101),
      previousNextUrl: null,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/one",
      type: "navigate",
    });
    const secondState = routerReducer(firstState, {
      elements: createResolvedElements("route:/two", "/"),
      interceptionContext: null,
      layoutFlags: {},
      navigationSnapshot: firstState.navigationSnapshot,
      operation: createTestOperation(firstState, 102),
      previousNextUrl: null,
      renderId: 2,
      rootLayoutTreePath: "/",
      routeId: "route:/two",
      type: "navigate",
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
        currentRootLayoutTreePath: currentState.rootLayoutTreePath,
        nextRootLayoutTreePath: pending.rootLayoutTreePath,
        startedNavigationId: 3,
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

    const committedState = routerReducer(currentState, pending.action);
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
        currentRootLayoutTreePath: currentState.rootLayoutTreePath,
        nextRootLayoutTreePath: pending.rootLayoutTreePath,
        startedNavigationId: 4,
      }),
    ).toBe("skip");
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

  it("merges layoutFlags on navigate", () => {
    const state = createState({ layoutFlags: { "layout:/": "s", "layout:/old": "d" } });
    const nextState = routerReducer(state, {
      elements: createResolvedElements("route:/next", "/"),
      interceptionContext: null,
      layoutFlags: { "layout:/": "s", "layout:/blog": "d" },
      navigationSnapshot: createState().navigationSnapshot,
      operation: createTestOperation(state),
      previousNextUrl: null,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/next",
      type: "navigate",
    });

    // Navigate merges: old flags preserved, new flags override
    expect(nextState.layoutFlags).toEqual({
      "layout:/": "s",
      "layout:/old": "d",
      "layout:/blog": "d",
    });
  });

  it("replaces layoutFlags on replace", () => {
    const state = createState({ layoutFlags: { "layout:/": "s", "layout:/old": "d" } });
    const nextState = routerReducer(state, {
      elements: createResolvedElements("route:/next", "/"),
      interceptionContext: null,
      layoutFlags: { "layout:/": "d" },
      navigationSnapshot: createState().navigationSnapshot,
      operation: createTestOperation(state),
      previousNextUrl: null,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/next",
      type: "replace",
    });

    // Replace: only new flags
    expect(nextState.layoutFlags).toEqual({ "layout:/": "d" });
  });

  it("stores previousNextUrl on navigate actions", () => {
    const state = createState();
    const nextState = routerReducer(state, {
      elements: createResolvedElements("route:/photos/42\0/feed", "/", "/feed"),
      interceptionContext: "/feed",
      layoutFlags: {},
      navigationSnapshot: createState().navigationSnapshot,
      operation: createTestOperation(state),
      previousNextUrl: "/feed",
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/photos/42\0/feed",
      type: "navigate",
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

      await expect(renderPromise).resolves.toBeUndefined();
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

    expect(result.disposition).toBe("hard-navigate");
    expect(result.pending.routeId).toBe("route:/dashboard");
    expect(result.pending.action.renderId).toBe(3);
  });

  it("treats null root-layout identities as soft-navigation compatible", () => {
    expect(shouldHardNavigate(null, null)).toBe(false);
    expect(shouldHardNavigate(null, "/")).toBe(false);
    expect(shouldHardNavigate("/", null)).toBe(false);
  });

  it("clears stale parallel slots on traverse", () => {
    const state = createState({
      elements: createResolvedElements("route:/feed", "/", null, {
        "slot:modal:/feed": React.createElement("div", null, "modal"),
      }),
    });
    const nextElements = createResolvedElements("route:/feed", "/");

    const nextState = routerReducer(state, {
      elements: nextElements,
      interceptionContext: null,
      layoutFlags: {},
      navigationSnapshot: createState().navigationSnapshot,
      operation: createTestOperation(state),
      previousNextUrl: null,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/feed",
      type: "traverse",
    });

    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(false);
  });

  it("preserves absent parallel slots on navigate", () => {
    const state = createState({
      elements: createResolvedElements("route:/feed", "/", null, {
        "slot:modal:/feed": React.createElement("div", null, "modal"),
      }),
    });
    const nextElements = createResolvedElements("route:/feed/comments", "/");

    const nextState = routerReducer(state, {
      elements: nextElements,
      interceptionContext: null,
      layoutFlags: {},
      navigationSnapshot: createState().navigationSnapshot,
      operation: createTestOperation(state),
      previousNextUrl: null,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/feed/comments",
      type: "navigate",
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
