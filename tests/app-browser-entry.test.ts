import React from "react";
import { describe, expect, it } from "vite-plus/test";
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
import {
  createPendingNavigationCommit,
  resolveAndClassifyNavigationCommit,
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
    navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
    renderId: 0,
    interceptionContext: null,
    rootLayoutTreePath: "/",
    routeId: "route:/initial",
    ...overrides,
  };
}

describe("app browser entry state helpers", () => {
  it("requires renderId when creating pending commits", () => {
    // @ts-expect-error renderId is required to avoid duplicate commit ids.
    void createPendingNavigationCommit({
      currentState: createState(),
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: createState().navigationSnapshot,
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

    const nextState = routerReducer(
      createState({
        elements: previousElements,
      }),
      {
        elements: nextElements,
        interceptionContext: null,
        navigationSnapshot: createState().navigationSnapshot,
        renderId: 1,
        rootLayoutTreePath: "/",
        routeId: "route:/next",
        type: "navigate",
      },
    );

    expect(nextState.routeId).toBe("route:/next");
    expect(nextState.interceptionContext).toBeNull();
    expect(nextState.rootLayoutTreePath).toBe("/");
    expect(nextState.elements).toMatchObject({
      "layout:/": expect.anything(),
      "page:/next": expect.anything(),
    });
  });

  it("replaces elements on replace", () => {
    const nextElements = createResolvedElements("route:/next", "/", null, {
      "page:/next": React.createElement("main", null, "next"),
    });

    const nextState = routerReducer(createState(), {
      elements: nextElements,
      interceptionContext: null,
      navigationSnapshot: createState().navigationSnapshot,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/next",
      type: "replace",
    });

    expect(nextState.elements).toBe(nextElements);
    expect(nextState.interceptionContext).toBeNull();
    expect(nextState.elements).toMatchObject({
      "page:/next": expect.anything(),
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
      renderId: 1,
      type: "navigate",
    });

    expect(pending.routeId).toBe("route:/photos/42\0/feed");
    expect(pending.interceptionContext).toBe("/feed");
    expect(pending.action.interceptionContext).toBe("/feed");
  });

  it("hard navigates instead of merging when the root layout changes", async () => {
    const currentState = createState({
      rootLayoutTreePath: "/(marketing)",
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/(dashboard)")),
      navigationSnapshot: currentState.navigationSnapshot,
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

  it("skips a pending commit when a newer navigation has become active", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: currentState.navigationSnapshot,
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
      renderId: 1,
      type: "navigate",
    });

    expect(refreshCommit.action.type).toBe("navigate");
    expect(refreshCommit.routeId).toBe("route:/dashboard");
    expect(refreshCommit.rootLayoutTreePath).toBe("/");
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
      navigationSnapshot: createState().navigationSnapshot,
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
      navigationSnapshot: createState().navigationSnapshot,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/feed/comments",
      type: "navigate",
    });

    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(true);
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
