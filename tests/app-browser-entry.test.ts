import React from "react";
import { describe, expect, it } from "vite-plus/test";
import {
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
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
  extraEntries: Record<string, unknown> = {},
) {
  return normalizeAppElements({
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
    const previousElements = createResolvedElements("route:/initial", "/", {
      "layout:/": React.createElement("div", null, "layout"),
    });
    const nextElements = createResolvedElements("route:/next", "/", {
      "page:/next": React.createElement("main", null, "next"),
    });

    const nextState = routerReducer(
      createState({
        elements: previousElements,
      }),
      {
        elements: nextElements,
        navigationSnapshot: createState().navigationSnapshot,
        renderId: 1,
        rootLayoutTreePath: "/",
        routeId: "route:/next",
        type: "navigate",
      },
    );

    expect(nextState.routeId).toBe("route:/next");
    expect(nextState.rootLayoutTreePath).toBe("/");
    expect(nextState.elements).toMatchObject({
      "layout:/": expect.anything(),
      "page:/next": expect.anything(),
    });
  });

  it("replaces elements on replace", () => {
    const nextElements = createResolvedElements("route:/next", "/", {
      "page:/next": React.createElement("main", null, "next"),
    });

    const nextState = routerReducer(createState(), {
      elements: nextElements,
      navigationSnapshot: createState().navigationSnapshot,
      renderId: 1,
      rootLayoutTreePath: "/",
      routeId: "route:/next",
      type: "replace",
    });

    expect(nextState.elements).toBe(nextElements);
    expect(nextState.elements).toMatchObject({
      "page:/next": expect.anything(),
    });
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
});
