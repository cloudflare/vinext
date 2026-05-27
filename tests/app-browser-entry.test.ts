import React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createOnUncaughtError } from "../packages/vinext/src/server/app-browser-error.js";
import {
  createDiscardedServerActionRefreshScheduler,
  createServerActionInitiationSnapshot,
  parseServerActionRevalidationHeader,
  resolveServerActionRedirectLocation,
  shouldClearClientNavigationCachesForServerActionResult,
  shouldScheduleRefreshForDiscardedServerAction,
} from "../packages/vinext/src/server/app-browser-action-result.js";
import {
  RSC_FORM_STATE_GLOBAL,
  consumeInitialFormState,
  createVinextHydrateRootOptions,
  hydrateRootInTransition,
} from "../packages/vinext/src/server/app-browser-hydration.js";
import { createAppBrowserNavigationController } from "../packages/vinext/src/server/app-browser-navigation-controller.js";
import { createPopstateRestoreHandler } from "../packages/vinext/src/server/app-browser-popstate.js";
import {
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  resolveRscCompatibilityNavigationDecision,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  devOnCaughtError,
  devOnUncaughtError,
} from "../packages/vinext/src/server/dev-error-overlay.js";
import {
  AppElementsWire,
  APP_LAYOUT_FLAGS_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  UNMATCHED_SLOT,
  getMountedSlotIds,
  getMountedSlotIdsHeader,
  normalizeAppElements,
  type AppElements,
  type AppElementsInterception,
  type AppElementsSlotBinding,
} from "../packages/vinext/src/server/app-elements.js";
import { createClientNavigationRenderSnapshot } from "../packages/vinext/src/shims/navigation.js";
import * as navigationShim from "../packages/vinext/src/shims/navigation.js";
import {
  createHistoryStateWithNavigationMetadata,
  createHistoryStateWithPreviousNextUrl,
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
  createPendingNavigationCommit,
  isCacheRestorableAppPayloadMetadata,
  readHistoryStatePreviousNextUrl,
  readHistoryStateTraversalIndex,
  resolveInterceptionContextFromPreviousNextUrl,
  resolveHistoryTraversalIntent,
  resolveServerActionRequestState,
  resolvePendingNavigationCommitDispositionDecision,
  type AppRouterState,
  type OperationLane,
} from "../packages/vinext/src/server/app-browser-state.js";
import { resolveRscRedirectLifecycleHop } from "../packages/vinext/src/server/app-browser-rsc-redirect.js";
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
import {
  ACTION_REVALIDATED_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_PARAMS_HEADER,
} from "../packages/vinext/src/server/headers.js";
import type {
  GraphVersion,
  RootBoundaryId,
  RouteManifest,
  RouteManifestInterception,
  RouteManifestRootBoundary,
  RouteManifestRoute,
  RouteManifestSlotBinding,
  StaticSegmentGraph,
} from "../packages/vinext/src/routing/app-route-graph.js";

type TestRouteManifestRoute = {
  id?: string;
  interceptions?: readonly TestRouteManifestInterception[];
  layoutIds: readonly string[];
  pattern: string;
  rootBoundaryId: string | null;
  slotBindings?: readonly AppElementsSlotBinding[];
};

type TestRouteManifestInterception = {
  ownerLayoutId: string | null;
  slotId: string;
  sourcePattern: string;
  targetPattern: string;
};

function createResolvedElements(
  routeId: string,
  rootLayoutTreePath: string | null,
  interceptionContext: string | null = null,
  extraEntries: Record<string, unknown> = {},
  layoutIds: readonly string[] = rootLayoutTreePath === null
    ? []
    : [AppElementsWire.encodeLayoutId(rootLayoutTreePath)],
  slotBindings: readonly AppElementsSlotBinding[] = [],
  interception: AppElementsInterception | null = null,
) {
  return normalizeAppElements({
    ...AppElementsWire.createMetadataEntries({
      interception,
      interceptionContext,
      layoutIds,
      rootLayoutTreePath,
      routeId,
      slotBindings,
    }),
    ...extraEntries,
  });
}

function createState(overrides: Partial<AppRouterState> = {}): AppRouterState {
  return {
    elements: createResolvedElements("route:/initial", "/"),
    interception: null,
    layoutIds: [AppElementsWire.encodeLayoutId("/")],
    layoutFlags: {},
    navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
    renderId: 0,
    activeOperation: null,
    interceptionContext: null,
    previousNextUrl: null,
    rootLayoutTreePath: "/",
    routeId: "route:/initial",
    slotBindings: [],
    visibleCommitVersion: 0,
    ...overrides,
  };
}

function createInterceptionProof(
  sourceMatchedUrl: string,
  targetMatchedUrl: string,
  slotId: string = AppElementsWire.encodeSlotId("modal", sourceMatchedUrl),
): AppElementsInterception {
  return {
    sourceMatchedUrl,
    sourceRouteId: AppElementsWire.encodeRouteId(sourceMatchedUrl, null),
    slotId,
    targetMatchedUrl,
    targetRouteId: AppElementsWire.encodeRouteId(targetMatchedUrl, null),
  };
}

function createTestRouteManifest(routes: readonly TestRouteManifestRoute[]): RouteManifest {
  const manifestRoutes = new Map<string, RouteManifestRoute>();
  const slotBindings = new Map<string, RouteManifestSlotBinding>();
  const interceptions = new Map<string, RouteManifestInterception>();
  const interceptionsBySlotId = new Map<string, RouteManifestInterception[]>();
  const rootBoundaries = new Map<RootBoundaryId, RouteManifestRootBoundary>();
  const routeIdByPattern = new Map(
    routes.map((route) => [route.pattern, route.id ?? `route:${route.pattern}`]),
  );

  for (const route of routes) {
    const routeId = route.id ?? `route:${route.pattern}`;
    const rootBoundaryId =
      route.rootBoundaryId === null ? null : (route.rootBoundaryId as RootBoundaryId);
    const routeSlotBindings = route.slotBindings ?? [];
    const slotIds = routeSlotBindings.map((binding) => binding.slotId).sort();
    const patternParts = route.pattern.split("/").filter((segment) => segment.length > 0);
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

function rootBoundaryIdFromTreePath(rootLayoutTreePath: string | null): string | null {
  return rootLayoutTreePath === null ? null : `root-boundary:${rootLayoutTreePath}`;
}

function normalizeTestRoutePattern(pathname: string): string {
  try {
    return decodeURI(pathname);
  } catch {
    return pathname;
  }
}

function routeIdWithoutInterceptionContext(routeId: string): string {
  const parsed = AppElementsWire.parseElementKey(routeId);
  if (parsed?.kind !== "route") return routeId;
  return AppElementsWire.encodeRouteId(parsed.path, null);
}

function createRouteManifestForPendingCommit(
  currentState: AppRouterState,
  pending: Awaited<ReturnType<typeof createPendingNavigationCommit>>,
): RouteManifest {
  const currentPattern =
    currentState.interception?.sourceMatchedUrl ??
    normalizeTestRoutePattern(currentState.navigationSnapshot.pathname);
  const currentRouteId =
    currentState.interception?.sourceRouteId ??
    routeIdWithoutInterceptionContext(currentState.routeId);
  const currentRoute = {
    id: currentRouteId,
    layoutIds: currentState.layoutIds,
    pattern: currentPattern,
    rootBoundaryId: rootBoundaryIdFromTreePath(currentState.rootLayoutTreePath),
    slotBindings: currentState.slotBindings,
  };
  const pendingInterception = pending.action.interception;

  if (pendingInterception !== null) {
    const currentMatchesSource =
      currentRouteId === pendingInterception.sourceRouteId &&
      currentPattern === pendingInterception.sourceMatchedUrl;
    const sourceLayoutIds = currentMatchesSource
      ? currentState.layoutIds
      : pending.action.layoutIds;
    const sourceRootLayoutTreePath = currentMatchesSource
      ? currentState.rootLayoutTreePath
      : pending.rootLayoutTreePath;
    return createTestRouteManifest([
      currentRoute,
      {
        id: pendingInterception.sourceRouteId,
        interceptions: [
          {
            ownerLayoutId:
              pending.action.slotBindings.find(
                (binding) => binding.slotId === pendingInterception.slotId,
              )?.ownerLayoutId ?? null,
            slotId: pendingInterception.slotId,
            sourcePattern: pendingInterception.sourceMatchedUrl,
            targetPattern: pendingInterception.targetMatchedUrl,
          },
        ],
        layoutIds: sourceLayoutIds,
        pattern: pendingInterception.sourceMatchedUrl,
        rootBoundaryId: rootBoundaryIdFromTreePath(sourceRootLayoutTreePath),
        slotBindings: pending.action.slotBindings,
      },
      {
        id: pendingInterception.targetRouteId,
        layoutIds: pending.action.layoutIds,
        pattern: pendingInterception.targetMatchedUrl,
        rootBoundaryId: rootBoundaryIdFromTreePath(pending.rootLayoutTreePath),
      },
    ]);
  }

  return createTestRouteManifest([
    currentRoute,
    {
      id: routeIdWithoutInterceptionContext(pending.routeId),
      layoutIds: pending.action.layoutIds,
      pattern: normalizeTestRoutePattern(pending.action.navigationSnapshot.pathname),
      rootBoundaryId: rootBoundaryIdFromTreePath(pending.rootLayoutTreePath),
      slotBindings: pending.action.slotBindings,
    },
  ]);
}

function createRootChangeRouteManifest(
  options: {
    currentPattern?: string;
    currentRouteId?: string;
    targetPattern?: string;
    targetRouteId?: string;
  } = {},
): RouteManifest {
  return createTestRouteManifest([
    {
      id: options.currentRouteId ?? "route:/initial",
      layoutIds: [AppElementsWire.encodeLayoutId("/(marketing)")],
      pattern: options.currentPattern ?? "/initial",
      rootBoundaryId: "root-boundary:/(marketing)",
    },
    {
      id: options.targetRouteId ?? "route:/dashboard",
      layoutIds: [AppElementsWire.encodeLayoutId("/(dashboard)")],
      pattern: options.targetPattern ?? "/dashboard",
      rootBoundaryId: "root-boundary:/(dashboard)",
    },
  ]);
}

type TestPendingDispositionOptions = {
  activeNavigationId: number;
  currentRootLayoutTreePath: string | null;
  currentVisibleCommitVersion: number;
  nextRootLayoutTreePath: string | null;
  renderId?: number;
  startedNavigationId: number;
  startedVisibleCommitVersion: number;
};

async function resolveTestPendingNavigationCommitDispositionDecision(
  options: TestPendingDispositionOptions,
) {
  const startState = createState({
    rootLayoutTreePath: options.currentRootLayoutTreePath,
    visibleCommitVersion: options.startedVisibleCommitVersion,
  });
  const currentState = createState({
    rootLayoutTreePath: options.currentRootLayoutTreePath,
    visibleCommitVersion: options.currentVisibleCommitVersion,
  });
  const pending = await createPendingNavigationCommit({
    payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
    currentState: startState,
    nextElements: Promise.resolve(
      createResolvedElements("route:/dashboard", options.nextRootLayoutTreePath),
    ),
    navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/dashboard", {}),
    operationLane: "navigation",
    renderId: options.renderId ?? options.startedNavigationId,
    type: "navigate",
  });

  return resolvePendingNavigationCommitDispositionDecision({
    activeNavigationId: options.activeNavigationId,
    currentState,
    pending,
    routeManifest: createRouteManifestForPendingCommit(currentState, pending),
    startedNavigationId: options.startedNavigationId,
  });
}

function createControllerHarness(
  initialState: AppRouterState = createState(),
  deps?: Parameters<typeof createAppBrowserNavigationController>[0],
) {
  const controller = createAppBrowserNavigationController(deps);
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
  interception?: AppElementsInterception | null;
  interceptionContext?: string | null;
  layoutIds?: readonly string[];
  layoutFlags?: AppRouterState["layoutFlags"];
  navigationSnapshot?: AppRouterState["navigationSnapshot"];
  operationLane?: OperationLane;
  previousNextUrl?: string | null;
  renderId?: number;
  rootLayoutTreePath: string | null;
  routeId: string;
  slotBindings?: readonly AppElementsSlotBinding[];
  startedNavigationId?: number;
  targetHref?: string;
  type?: "navigate" | "replace" | "traverse";
};

async function applyApprovedTestCommit(
  state: AppRouterState,
  options: ApprovedTestCommitOptions,
): Promise<AppRouterState> {
  const pending = await createPendingNavigationCommit({
    payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
        options.layoutIds,
        options.slotBindings,
        options.interception ?? null,
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
    routeManifest: createRouteManifestForPendingCommit(state, pending),
    startedNavigationId: options.startedNavigationId ?? activeNavigationId,
    targetHref: options.targetHref ?? "https://example.com/initial",
  });

  if (approval.approvedCommit === null) {
    throw new Error("Expected approved visible commit");
  }

  return applyApprovedVisibleCommit(state, approval.approvedCommit);
}

function stubWindow(href: string) {
  const assign = vi.fn();
  const replace = vi.fn();
  const storage = new Map<string, string>();

  vi.stubGlobal("window", {
    history: { state: null },
    location: {
      assign,
      href,
      origin: new URL(href).origin,
      replace,
    },
    sessionStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      removeItem(key: string) {
        storage.delete(key);
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
    },
  });

  return { assign, replace, storage };
}

function createDeferred(): { resolve: () => void; promise: Promise<void> } {
  let resolve: () => void = () => {
    throw new Error("Promise was not initialized");
  };
  const promise = new Promise<void>((resolveInner) => {
    resolve = resolveInner;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("app browser entry navigation scheduling", () => {
  it("hard-navigates RSC responses when the response compatibility ID is missing or stale", () => {
    stubWindow("https://example.com/current");

    expect(
      resolveRscCompatibilityNavigationDecision({
        clientCompatibilityId: "compat-a",
        currentHref: "/target?tab=1#details",
        origin: "https://example.com",
        responseCompatibilityId: null,
        responseUrl: "https://example.com/target.rsc?tab=1&_rsc=stale",
      }),
    ).toEqual({
      hardNavigationTarget: "/target?tab=1#details",
      kind: "hard-navigate",
    });

    expect(
      resolveRscCompatibilityNavigationDecision({
        clientCompatibilityId: "compat-a",
        currentHref: "/target/",
        origin: "https://example.com",
        responseCompatibilityId: "compat-b",
        responseUrl: "https://example.com/target.rsc?_rsc=stale",
      }),
    ).toEqual({
      hardNavigationTarget: "/target/",
      kind: "hard-navigate",
    });
  });

  it("keeps RSC responses on the soft-navigation path when compatibility IDs match", () => {
    stubWindow("https://example.com/current");

    expect(
      resolveRscCompatibilityNavigationDecision({
        clientCompatibilityId: "compat-a",
        currentHref: "/target",
        origin: "https://example.com",
        responseCompatibilityId: "compat-a",
        responseUrl: "https://example.com/target.rsc?_rsc=fresh",
      }),
    ).toEqual({ kind: "compatible" });
  });

  it("creates replayable cached RSC snapshots with compatibility IDs", async () => {
    stubWindow("https://example.com/current");

    const responseUrl = "https://example.com/target.rsc?_rsc=fresh";
    const snapshot = navigationShim.createCachedRscResponseSnapshot(
      new Response("unused", {
        headers: {
          "content-type": "text/x-component",
          [VINEXT_MOUNTED_SLOTS_HEADER]: "children",
          [VINEXT_PARAMS_HEADER]: "%7B%22slug%22%3A%22target%22%7D",
          [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "compat-a",
        },
      }),
      await new Response("flight").arrayBuffer(),
      responseUrl,
    );

    expect(snapshot.compatibilityIdHeader).toBe("compat-a");
    expect(snapshot.url).toBe(responseUrl);
    expect(
      resolveRscCompatibilityNavigationDecision({
        clientCompatibilityId: "compat-a",
        currentHref: "/target",
        origin: "https://example.com",
        responseCompatibilityId: snapshot.compatibilityIdHeader,
        responseUrl: snapshot.url,
      }),
    ).toEqual({ kind: "compatible" });

    const replayed = navigationShim.restoreRscResponse(snapshot);
    expect(replayed.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-a");
    expect(replayed.headers.get(VINEXT_MOUNTED_SLOTS_HEADER)).toBe("children");
    expect(replayed.headers.get(VINEXT_PARAMS_HEADER)).toBe("%7B%22slug%22%3A%22target%22%7D");
    expect(await replayed.text()).toBe("flight");
  });

  it("parses action revalidation headers into explicit client effects", () => {
    expect(parseServerActionRevalidationHeader(new Headers())).toBe("none");
    expect(
      parseServerActionRevalidationHeader(new Headers({ [ACTION_REVALIDATED_HEADER]: "1" })),
    ).toBe("staticAndDynamic");
    expect(
      parseServerActionRevalidationHeader(new Headers({ [ACTION_REVALIDATED_HEADER]: "2" })),
    ).toBe("dynamicOnly");
    expect(
      parseServerActionRevalidationHeader(
        new Headers({ [ACTION_REVALIDATED_HEADER]: JSON.stringify("1") }),
      ),
    ).toBe("none");
    expect(
      parseServerActionRevalidationHeader(new Headers({ [ACTION_REVALIDATED_HEADER]: "not-json" })),
    ).toBe("none");
  });

  it("captures server action initiation URL state without a hash in the request path", () => {
    const routerState = createState({
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/a?tab=1", {
        slug: "a",
      }),
      routeId: "route:/a",
    });

    const snapshot = createServerActionInitiationSnapshot({
      href: "https://example.com/a?tab=1#section",
      navigationId: 42,
      routerState,
    });

    expect(snapshot.href).toBe("https://example.com/a?tab=1#section");
    expect(snapshot.navigationId).toBe(42);
    expect(snapshot.path).toBe("/a?tab=1");
    expect(snapshot.routerState).toBe(routerState);
  });

  it("resolves server action dot-relative redirects against the initiating route", () => {
    expect(
      resolveServerActionRedirectLocation({
        currentHref: "https://example.com/subdir?tab=1#section",
        location: "./subpage",
        origin: "https://example.com",
      }),
    ).toEqual({
      href: "https://example.com/subdir/subpage",
      internal: true,
    });

    expect(
      resolveServerActionRedirectLocation({
        currentHref: "https://example.com/subdir?tab=1#section",
        location: "../subpage",
        origin: "https://example.com",
      }),
    ).toEqual({
      href: "https://example.com/subpage",
      internal: true,
    });
  });

  it("classifies absolute server action redirects after URL resolution", () => {
    expect(
      resolveServerActionRedirectLocation({
        currentHref: "https://example.com/subdir",
        location: "/subpage",
        origin: "https://example.com",
      }),
    ).toEqual({
      href: "https://example.com/subpage",
      internal: true,
    });

    expect(
      resolveServerActionRedirectLocation({
        currentHref: "https://example.com/subdir",
        location: "https://other.example/subpage",
        origin: "https://example.com",
      }),
    ).toEqual({
      href: "https://other.example/subpage",
      internal: false,
    });

    expect(
      resolveServerActionRedirectLocation({
        currentHref: "https://preview.example/subdir",
        location: "/subpage",
        origin: "https://fallback.example",
      }),
    ).toEqual({
      href: "https://preview.example/subpage",
      internal: true,
    });
  });

  it("keeps client navigation caches for no-root server action results", () => {
    expect(
      shouldClearClientNavigationCachesForServerActionResult({
        returnValue: { ok: true, data: "action-result" },
      }),
    ).toBe(false);
    expect(
      shouldClearClientNavigationCachesForServerActionResult({
        root: createResolvedElements("route:/settings", "/"),
        returnValue: { ok: true, data: "action-result" },
      }),
    ).toBe(true);
    expect(
      shouldClearClientNavigationCachesForServerActionResult(
        createResolvedElements("route:/settings", "/"),
      ),
    ).toBe(true);
    expect(
      shouldClearClientNavigationCachesForServerActionResult(
        {
          returnValue: { ok: true, data: "action-result" },
        },
        "staticAndDynamic",
      ),
    ).toBe(true);
    expect(
      shouldClearClientNavigationCachesForServerActionResult(
        {
          returnValue: { ok: true, data: "action-result" },
        },
        "dynamicOnly",
      ),
    ).toBe(true);
  });

  it("schedules discarded action refreshes only for revalidated actions", () => {
    expect(shouldScheduleRefreshForDiscardedServerAction("none")).toBe(false);
    expect(shouldScheduleRefreshForDiscardedServerAction("dynamicOnly")).toBe(true);
    expect(shouldScheduleRefreshForDiscardedServerAction("staticAndDynamic")).toBe(true);
  });

  it("coalesces discarded action refreshes until active navigation settles", () => {
    const queued: Array<() => void> = [];
    const runRefresh = vi.fn();
    const scheduler = createDiscardedServerActionRefreshScheduler({
      queueTask(callback) {
        queued.push(callback);
      },
      runRefresh,
    });

    scheduler.markNavigationStart();
    scheduler.schedule();
    scheduler.schedule();
    expect(runRefresh).not.toHaveBeenCalled();

    queued.shift()?.();
    expect(runRefresh).not.toHaveBeenCalled();

    scheduler.markNavigationSettled();
    queued.shift()?.();
    expect(runRefresh).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    queued.shift()?.();
    expect(runRefresh).toHaveBeenCalledTimes(2);
  });

  it("does not expose a per-navigation transition override at the controller boundary", () => {
    type Controller = ReturnType<typeof createAppBrowserNavigationController>;
    function assertNoTransitionOverride(controller: Controller) {
      void controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
        nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
        operationLane: "navigation",
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId: 1,
        // @ts-expect-error ordinary navigations must not choose their own scheduling lane.
        useTransition: false,
      });
    }

    expect(assertNoTransitionOverride).toBeTypeOf("function");
  });
});

describe("app browser entry state helpers", () => {
  it("requires renderId when creating pending commits", () => {
    // @ts-expect-error renderId is required to avoid duplicate commit ids.
    void createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(state, pending),
      startedNavigationId: 1,
      targetHref: "https://example.com/next",
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState: createState(),
      nextElements: Promise.resolve(
        createResolvedElements(
          "route:/photos/42\0/feed",
          "/",
          "/feed",
          {
            "page:/photos/42": React.createElement("main", null, "photo"),
          },
          [AppElementsWire.encodeLayoutId("/")],
          [],
          createInterceptionProof("/feed", "/photos/42"),
        ),
      ),
      navigationSnapshot: createState().navigationSnapshot,
      operationLane: "navigation",
      previousNextUrl: "/feed",
      renderId: 1,
      type: "navigate",
    });

    expect(pending.routeId).toBe("route:/photos/42\0/feed");
    expect(pending.interception).toEqual(createInterceptionProof("/feed", "/photos/42"));
    expect(pending.interceptionContext).toBe("/feed");
    expect(pending.previousNextUrl).toBe("/feed");
    expect(pending.action.interception).toEqual(createInterceptionProof("/feed", "/photos/42"));
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/(dashboard)")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 1,
      type: "navigate",
    });

    expect(
      resolvePendingNavigationCommitDispositionDecision({
        activeNavigationId: 3,
        currentState,
        pending,
        routeManifest: createRouteManifestForPendingCommit(currentState, pending),
        startedNavigationId: 3,
      }).disposition,
    ).toBe("hard-navigate");
  });

  it("defers commit classification until the payload has resolved", async () => {
    let resolveElements: ((value: AppElements) => void) | undefined;
    const nextElements = new Promise<AppElements>((resolve) => {
      resolveElements = resolve;
    });
    let resolved = false;
    const pending = createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 1,
      targetHref: "https://example.com/dashboard",
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      navigationSnapshot: currentState.navigationSnapshot,
      operationLane: "navigation",
      renderId: 1,
      type: "navigate",
    });

    expect(
      resolvePendingNavigationCommitDispositionDecision({
        activeNavigationId: 5,
        currentState,
        pending,
        routeManifest: createRouteManifestForPendingCommit(currentState, pending),
        startedNavigationId: 4,
      }).disposition,
    ).toBe("skip");
  });

  it("skips a refresh commit when visible state changed after the refresh started", async () => {
    const refreshStartState = createState({ visibleCommitVersion: 4 });
    const latestState = createState({
      routeId: "route:/hmr",
      visibleCommitVersion: 5,
    });
    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(latestState, pending),
      startedNavigationId: 7,
      targetHref: "https://example.com/dashboard",
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
          targetHref: "https://example.com/dashboard",
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(latestState, pending),
      startedNavigationId: 8,
      targetHref: "https://example.com/previous",
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
          targetHref: "https://example.com/previous",
        },
      },
    ]);
    expect(approval.approvedCommit).toBeNull();
  });

  it("traces stale pending commits with compact reason codes and structured fields", async () => {
    const decision = await resolveTestPendingNavigationCommitDispositionDecision({
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

  it("treats a visible commit version mismatch as stale before root-boundary decisions", async () => {
    const decision = await resolveTestPendingNavigationCommitDispositionDecision({
      activeNavigationId: 2,
      currentVisibleCommitVersion: 1,
      currentRootLayoutTreePath: "/",
      nextRootLayoutTreePath: "/",
      startedNavigationId: 2,
      startedVisibleCommitVersion: 0,
    });

    expect(decision.disposition).toBe("skip");
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.staleOperation);
  });

  it("treats stale state as authoritative even when the root boundary changed", async () => {
    const decision = await resolveTestPendingNavigationCommitDispositionDecision({
      activeNavigationId: 2,
      currentVisibleCommitVersion: 1,
      currentRootLayoutTreePath: "/(marketing)",
      nextRootLayoutTreePath: "/(dashboard)",
      startedNavigationId: 2,
      startedVisibleCommitVersion: 0,
    });

    expect(decision).toEqual({
      disposition: "skip",
      preserveElementIds: [],
      trace: {
        schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
        entries: [
          {
            code: NavigationTraceReasonCodes.staleOperation,
            fields: {
              activeNavigationId: 2,
              currentRootLayoutTreePath: "/(marketing)",
              currentVisibleCommitVersion: 1,
              nextRootLayoutTreePath: "/(dashboard)",
              startedNavigationId: 2,
              startedVisibleCommitVersion: 0,
            },
          },
        ],
      },
    });
  });

  it("traces root-boundary hard navigation decisions", async () => {
    const decision = await resolveTestPendingNavigationCommitDispositionDecision({
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

  it("rejects cache-restored pending commits when cache-entry proof metadata is absent", async () => {
    const currentState = createState({
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/dashboard/profile",
        {},
      ),
      routeId: "route:/dashboard/profile",
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      nextElements: Promise.resolve(
        createResolvedElements(
          "route:/dashboard/settings",
          "/",
          null,
          {
            "page:/dashboard/settings": React.createElement("main", null, "settings"),
          },
          ["layout:/"],
        ),
      ),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/dashboard/settings",
        {},
      ),
      operationLane: "navigation",
      renderId: 2,
      payloadOrigin: VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
      type: "navigate",
    });

    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 2,
      currentState,
      pending,
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 2,
      targetHref: "https://example.com/dashboard/settings",
    });

    expect(decision.disposition).toBe("hard-navigate");
    expect(decision.trace.entries).toEqual([
      {
        code: NavigationTraceReasonCodes.cacheProofRejected,
        fields: {
          activeNavigationId: 2,
          cacheProofCode: "CP_CACHE_ENTRY_PROOF_MISSING",
          currentRootLayoutTreePath: "/",
          currentVisibleCommitVersion: 0,
          nextRootLayoutTreePath: "/",
          startedNavigationId: 2,
          startedVisibleCommitVersion: 0,
          targetHref: "https://example.com/dashboard/settings",
        },
      },
    ]);
  });

  it("does not classify unproofed payload metadata as cache-restorable", () => {
    const elements = createResolvedElements("route:/dashboard/settings", "/", null, {
      "page:/dashboard/settings": React.createElement("main", null, "settings"),
    });

    expect(isCacheRestorableAppPayloadMetadata(AppElementsWire.readMetadata(elements))).toBe(false);
  });

  it("traces unknown root-layout identity without preserving absent slots", async () => {
    const decision = await resolveTestPendingNavigationCommitDispositionDecision({
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

  it("traces matching root-layout dispatches as current commits", async () => {
    const decision = await resolveTestPendingNavigationCommitDispositionDecision({
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

  it("normalizes encoded route-state paths before validating interception proof", async () => {
    const slotId = AppElementsWire.encodeSlotId("modal", "/café");
    const currentState = createState({
      layoutIds: [AppElementsWire.encodeLayoutId("/"), AppElementsWire.encodeLayoutId("/café")],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/caf%C3%A9", {}),
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/café", null),
      slotBindings: [
        {
          ownerLayoutId: AppElementsWire.encodeLayoutId("/café"),
          slotId,
          state: "default",
        },
      ],
    });
    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(
        createResolvedElements(
          AppElementsWire.encodeRouteId("/photos/café", "/caf%C3%A9"),
          "/",
          "/caf%C3%A9",
          {
            "page:/photos/café": React.createElement("main", null, "photo"),
          },
          [AppElementsWire.encodeLayoutId("/"), AppElementsWire.encodeLayoutId("/café")],
          [
            {
              ownerLayoutId: AppElementsWire.encodeLayoutId("/café"),
              slotId,
              state: "active",
            },
          ],
          createInterceptionProof("/café", "/photos/café", slotId),
        ),
      ),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/photos/caf%C3%A9",
        {},
      ),
      operationLane: "navigation",
      previousNextUrl: "/caf%C3%A9",
      renderId: 1,
      type: "navigate",
    });

    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 1,
      currentState,
      pending,
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 1,
    });

    expect(decision.disposition).toBe("dispatch");
    if (decision.disposition !== "dispatch") {
      throw new Error("Expected dispatch decision");
    }
    expect(decision.preserveElementIds).toEqual([
      AppElementsWire.encodeLayoutId("/"),
      AppElementsWire.encodeLayoutId("/café"),
    ]);
    expect(decision.trace.entries[0]?.code).toBe(
      NavigationTraceReasonCodes.interceptedCommitCurrent,
    );
  });

  it("builds a merge commit for refresh and server-action payloads", async () => {
    const refreshCommit = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
    expect(refreshCommit.previousNextUrl).toBeNull();
  });

  it("commits non-intercepted context-only payloads without preserving stale interception state", async () => {
    const currentState = createState({
      interception: createInterceptionProof("/feed", "/photos/42"),
      interceptionContext: "/feed",
      layoutIds: [AppElementsWire.encodeLayoutId("/"), AppElementsWire.encodeLayoutId("/feed")],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/photos/42", {}),
      previousNextUrl: "/feed",
      rootLayoutTreePath: "/",
      routeId: AppElementsWire.encodeRouteId("/photos/42", "/feed"),
    });

    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(
        createResolvedElements(
          AppElementsWire.encodeRouteId("/feed", "/feed"),
          "/",
          "/feed",
          {
            [AppElementsWire.encodePageId("/feed", "/feed")]: React.createElement(
              "main",
              null,
              "feed",
            ),
          },
          [AppElementsWire.encodeLayoutId("/"), AppElementsWire.encodeLayoutId("/feed")],
        ),
      ),
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/feed", {}),
      operationLane: "refresh",
      previousNextUrl: "/feed",
      renderId: 1,
      type: "navigate",
    });

    const decision = resolvePendingNavigationCommitDispositionDecision({
      activeNavigationId: 1,
      currentState,
      pending,
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 1,
    });

    expect(pending.interception).toBeNull();
    expect(pending.interceptionContext).toBe("/feed");
    expect(pending.previousNextUrl).toBeNull();
    expect(decision.disposition).toBe("dispatch");
    expect(decision.trace.entries[0]?.code).toBe(NavigationTraceReasonCodes.commitCurrent);

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 1,
      currentState,
      pending,
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 1,
      targetHref: "https://example.com/feed",
    });
    if (approval.approvedCommit === null) {
      throw new Error("Expected context-only payload to commit");
    }
    const contextOnlyState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);
    expect(contextOnlyState.interception).toBeNull();
    expect(contextOnlyState.previousNextUrl).toBeNull();
    expect(contextOnlyState.routeId).toBe(AppElementsWire.encodeRouteId("/feed", "/feed"));

    const interceptedPending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState: contextOnlyState,
      nextElements: Promise.resolve(
        createResolvedElements(
          AppElementsWire.encodeRouteId("/photos/42", "/feed"),
          "/",
          "/feed",
          {
            [AppElementsWire.encodeRouteId("/photos/42", "/feed")]: React.createElement(
              "main",
              null,
              "photo",
            ),
            [AppElementsWire.encodeSlotId("modal", "/feed")]: React.createElement(
              "div",
              null,
              "modal",
            ),
          },
          [AppElementsWire.encodeLayoutId("/"), AppElementsWire.encodeLayoutId("/feed")],
          [
            {
              ownerLayoutId: AppElementsWire.encodeLayoutId("/feed"),
              slotId: AppElementsWire.encodeSlotId("modal", "/feed"),
              state: "active",
            },
          ],
          createInterceptionProof("/feed", "/photos/42"),
        ),
      ),
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/photos/42", {}),
      operationLane: "navigation",
      previousNextUrl: "/feed",
      renderId: 2,
      type: "navigate",
    });

    const interceptedApproval = approvePendingNavigationCommit({
      activeNavigationId: 2,
      currentState: contextOnlyState,
      pending: interceptedPending,
      routeManifest: createRouteManifestForPendingCommit(contextOnlyState, interceptedPending),
      startedNavigationId: 2,
      targetHref: "https://example.com/photos/42",
    });

    expect(interceptedApproval.decision.disposition).toBe("commit");
    expect(interceptedApproval.decision.trace.entries[1]?.code).toBe(
      NavigationTraceReasonCodes.interceptedCommitCurrent,
    );
  });

  it("creates an approved visible commit only after the current operation decision allows mutation", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 4,
      targetHref: "https://example.com/dashboard",
    });

    expect(approval.decision.disposition).toBe("commit");
    if (approval.decision.disposition !== "commit") {
      throw new Error("Expected visible commit approval");
    }
    expect(approval.decision.preserveAbsentSlots).toBe(false);
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
          targetHref: "https://example.com/dashboard",
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

  it("traces unknown root-layout approval as an unproven payload commit", async () => {
    const currentState = createState();
    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 6,
      targetHref: "https://example.com/legacy-payload",
    });

    expect(approval.decision.disposition).toBe("commit");
    if (approval.decision.disposition !== "commit") {
      throw new Error("Expected visible commit approval");
    }
    expect(approval.decision.preserveAbsentSlots).toBe(false);
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 4,
      targetHref: "https://example.com/next",
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 4,
      targetHref: "https://example.com/feed",
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 7,
      targetHref: "https://example.com/dashboard",
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
      routeManifest: createRouteManifestForPendingCommit(currentState, pending),
      startedNavigationId: 8,
      targetHref: "https://example.com/dashboard?from=planner",
    });
    expect(hardNavigateApproval.decision.disposition).toBe("hard-navigate");
    expect(hardNavigateApproval.decision.trace.entries[0]?.code).toBe(
      NavigationTraceTransactionCodes.hardNavigate,
    );
    expect(hardNavigateApproval.decision.trace.entries[1]?.code).toBe(
      NavigationTraceReasonCodes.rootBoundaryChanged,
    );
    expect(hardNavigateApproval.decision.trace.entries[1]?.fields.targetHref).toBe(
      "https://example.com/dashboard?from=planner",
    );
    expect(hardNavigateApproval.approvedCommit).toBeNull();
  });

  it("preserves layoutFlags only for approved same-layout ancestors", async () => {
    const state = createState({ layoutFlags: { "layout:/": "s", "layout:/old": "d" } });
    const nextState = await applyApprovedTestCommit(state, {
      layoutFlags: { "layout:/blog": "d" },
      layoutIds: ["layout:/", "layout:/blog"],
      rootLayoutTreePath: "/",
      routeId: "route:/next",
    });

    expect(nextState.layoutFlags).toEqual({
      "layout:/": "s",
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
    const state = createState({
      layoutIds: [AppElementsWire.encodeLayoutId("/"), AppElementsWire.encodeLayoutId("/feed")],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/feed", {}),
      routeId: "route:/feed",
      slotBindings: [
        {
          ownerLayoutId: AppElementsWire.encodeLayoutId("/feed"),
          slotId: AppElementsWire.encodeSlotId("modal", "/feed"),
          state: "default",
        },
      ],
    });
    const interception = createInterceptionProof("/feed", "/photos/42");
    const nextState = await applyApprovedTestCommit(state, {
      interception,
      interceptionContext: "/feed",
      layoutIds: [AppElementsWire.encodeLayoutId("/"), AppElementsWire.encodeLayoutId("/feed")],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/photos/42", {}),
      previousNextUrl: "/feed",
      rootLayoutTreePath: "/",
      routeId: "route:/photos/42\0/feed",
      slotBindings: [
        {
          ownerLayoutId: AppElementsWire.encodeLayoutId("/feed"),
          slotId: AppElementsWire.encodeSlotId("modal", "/feed"),
          state: "active",
        },
      ],
    });

    expect(nextState.interception).toEqual(interception);
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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

  it("reads RouteManifest lazily after generated browser globals are assigned", async () => {
    let routeManifest: RouteManifest | null = null;
    const performHardNavigation = vi.fn(() => true);
    const { controller, detach, stateRef } = createControllerHarness(
      createState({
        layoutIds: ["layout:/stale"],
        navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/app", {}),
        rootLayoutTreePath: "/",
        routeId: "route:/app",
      }),
      {
        getRouteManifest: () => routeManifest,
        performHardNavigation,
      },
    );

    try {
      const pendingRouterState = controller.beginPendingBrowserRouterState();
      const navId = controller.beginNavigation();
      let resolvePayload!: (elements: AppElements) => void;
      const nextElements = new Promise<AppElements>((resolve) => {
        resolvePayload = resolve;
      });

      const result = controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        actionType: "navigate",
        createNavigationCommitEffect: () => vi.fn(),
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot(
          "https://example.com/marketing",
          {},
        ),
        nextElements,
        operationLane: "navigation",
        params: {},
        pendingRouterState,
        previousNextUrl: null,
        targetHref: "https://example.com/marketing",
        navId,
      });

      routeManifest = createTestRouteManifest([
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
      resolvePayload(createResolvedElements("route:/marketing", "/", null, {}, ["layout:/stale"]));

      await expect(result).resolves.toBe("hard-navigate");
      await expect(pendingRouterState.promise).resolves.toBe(stateRef.current);
      expect(performHardNavigation).toHaveBeenCalledWith("https://example.com/marketing");
      expect(stateRef.current.routeId).toBe("route:/app");
    } finally {
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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

  it("hard-navigates cache-restored payloads missing cache-entry proof metadata", async () => {
    const performHardNavigation = vi.fn(() => true);
    const createNavigationCommitEffect = vi.fn(() => vi.fn());
    const currentState = createState({
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/dashboard/profile",
        {},
      ),
      routeId: "route:/dashboard/profile",
    });
    const routeManifest = createTestRouteManifest([
      {
        id: "route:/dashboard/profile",
        layoutIds: currentState.layoutIds,
        pattern: "/dashboard/profile",
        rootBoundaryId: "root-boundary:/",
      },
      {
        id: "route:/dashboard/settings",
        layoutIds: [AppElementsWire.encodeLayoutId("/")],
        pattern: "/dashboard/settings",
        rootBoundaryId: "root-boundary:/",
      },
    ]);
    const { controller, detach, stateRef } = createControllerHarness(currentState, {
      getRouteManifest: () => routeManifest,
      performHardNavigation,
    });

    try {
      const result = await controller.renderNavigationPayload({
        actionType: "navigate",
        createNavigationCommitEffect,
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot(
          "https://example.com/dashboard/settings",
          {},
        ),
        nextElements: Promise.resolve(
          createResolvedElements("route:/dashboard/settings", "/", null, {
            "page:/dashboard/settings": React.createElement("main", null, "settings"),
          }),
        ),
        operationLane: "navigation",
        payloadOrigin: VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard/settings",
        navId: controller.beginNavigation(),
      });

      expect(result).toBe("hard-navigate");
      expect(performHardNavigation).toHaveBeenCalledWith("https://example.com/dashboard/settings");
      expect(createNavigationCommitEffect).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/dashboard/profile");
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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

  it("syncs cleared previousNextUrl after same-URL server action commits", async () => {
    const interception = createInterceptionProof("/feed", "/photos/42");
    const initialState = createState({
      interception,
      interceptionContext: "/feed",
      previousNextUrl: "/feed",
      rootLayoutTreePath: "/",
      routeId: "route:/photos/42\0/feed",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/photos/42", {}),
    });
    const syncHistoryStatePreviousNextUrl = vi.fn();
    const { controller, detach, stateRef } = createControllerHarness(initialState, {
      syncHistoryStatePreviousNextUrl,
    });
    const { assign } = stubWindow("https://example.com/photos/42");
    const nextElements = Promise.resolve(
      createResolvedElements("route:/photos/42", "/", null, {
        "page:/photos/42": React.createElement("main", null, "photo page"),
      }),
    );

    try {
      await controller.commitSameUrlNavigatePayload(
        nextElements,
        stateRef.current.navigationSnapshot,
        undefined,
        stateRef.current,
        { targetHref: "https://example.com/photos/42" },
      );

      expect(assign).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/photos/42");
      expect(stateRef.current.previousNextUrl).toBeNull();
      expect(syncHistoryStatePreviousNextUrl).toHaveBeenCalledTimes(1);
      expect(syncHistoryStatePreviousNextUrl).toHaveBeenCalledWith(null);
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

  it("reports discarded revalidating server action payloads for current-state refresh", async () => {
    const initialState = createState({
      rootLayoutTreePath: "/",
      routeId: "route:/settings",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {
        tab: "profile",
      }),
    });
    const { controller, detach, stateRef } = createControllerHarness(initialState);
    const { assign } = stubWindow("https://example.com/settings");
    const onDiscardedRevalidation = vi.fn();
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
        undefined,
        {
          onDiscardedRevalidation,
          revalidation: "staticAndDynamic",
        },
      );

      await controller.commitSameUrlNavigatePayload(
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

      resolveOlderPayload(
        createResolvedElements("route:/settings/older", "/", null, {
          "page:/settings/older": React.createElement("main", null, "older"),
        }),
      );

      await expect(olderResult).resolves.toBe("older-action-result");
      expect(assign).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/settings/newer");
      expect(stateRef.current.visibleCommitVersion).toBe(1);
      expect(onDiscardedRevalidation).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
  });

  it("discards revalidating server actions that started before an in-flight navigation", async () => {
    const initialState = createState({
      rootLayoutTreePath: "/",
      routeId: "route:/settings",
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {
        tab: "profile",
      }),
    });
    const { controller, detach, stateRef } = createControllerHarness(initialState);
    const { assign } = stubWindow("https://example.com/settings");
    const onDiscardedRevalidation = vi.fn();
    const actionInitiationNavigationId = controller.getActiveNavigationId();
    const actionInitiationState = stateRef.current;
    let resolvePayload!: (elements: AppElements) => void;
    const payload = new Promise<AppElements>((resolve) => {
      resolvePayload = resolve;
    });

    try {
      const result = controller.commitSameUrlNavigatePayload(
        payload,
        actionInitiationState.navigationSnapshot,
        {
          data: "action-result",
          ok: true,
        },
        actionInitiationState,
        {
          onDiscardedRevalidation,
          revalidation: "dynamicOnly",
          startedNavigationId: actionInitiationNavigationId,
        },
      );

      controller.beginNavigation();
      resolvePayload(
        createResolvedElements("route:/settings/action", "/", null, {
          "page:/settings/action": React.createElement("main", null, "action"),
        }),
      );

      await expect(result).resolves.toBe("action-result");
      expect(assign).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/settings");
      expect(stateRef.current.visibleCommitVersion).toBe(0);
      expect(onDiscardedRevalidation).toHaveBeenCalledTimes(1);
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

  it("does not hard-navigate same-URL server action payloads from snapshot root topology alone", async () => {
    const actionTargetHref = "https://example.com/marketing?from=action";
    const initialState = createState({
      rootLayoutTreePath: "/(marketing)",
      routeId: "route:/marketing",
      navigationSnapshot: createClientNavigationRenderSnapshot(actionTargetHref, {}),
    });
    const { controller, detach, stateRef } = createControllerHarness(initialState);
    const { assign } = stubWindow("https://example.com/current");
    const nextElements = Promise.resolve(
      createResolvedElements("route:/dashboard", "/(dashboard)", null, {
        "page:/dashboard": React.createElement("main", null, "dashboard"),
      }),
    );

    try {
      const result = await controller.commitSameUrlNavigatePayload(
        nextElements,
        stateRef.current.navigationSnapshot,
        undefined,
        undefined,
        {
          targetHref: actionTargetHref,
        },
      );

      expect(result).toBeUndefined();
      expect(assign).not.toHaveBeenCalled();
      expect(stateRef.current.routeId).toBe("route:/dashboard");
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      });

      const navB = controller.beginNavigation();
      void controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      });

      const navC = controller.beginNavigation();
      void controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      });

      // Yield so C's async payload resolves and state is committed.
      // renderNavigationPayload returns a promise that settles only when
      // NavigationCommitSignal fires (a React component not mounted in
      // unit tests). The state mutation through dispatchApprovedVisibleCommit is
      // applied during React.startTransition's action, so we verify via stateRef.
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      });

      // Start new navigation B (same root). B advances activeNavigationId past A.
      const navB = controller.beginNavigation();
      void controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      activeNavigationId: 9,
      currentState: createState(),
      navigationSnapshot: createState().navigationSnapshot,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/")),
      operationLane: "navigation",
      renderId: 3,
      startedNavigationId: 5,
      targetHref: "https://example.com/dashboard",
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      activeNavigationId,
      currentState,
      getActiveNavigationId: () => activeNavigationId,
      navigationSnapshot: currentState.navigationSnapshot,
      nextElements: payload,
      operationLane: "server-action",
      renderId: 24,
      startedNavigationId: 5,
      targetHref: "https://example.com/dashboard",
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
          targetHref: "https://example.com/dashboard",
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
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      activeNavigationId: 8,
      currentState: startedState,
      getCurrentStateForApproval: () => approvalState,
      navigationSnapshot: startedState.navigationSnapshot,
      nextElements: payload,
      operationLane: "server-action",
      renderId: 25,
      startedNavigationId: 8,
      targetHref: "https://example.com/dashboard",
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
          targetHref: "https://example.com/dashboard",
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
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
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
      { getRouteManifest: () => createRootChangeRouteManifest() },
    );
    const { assign } = stubWindow("https://example.com/marketing");
    const createNavigationCommitEffect = vi.fn();

    try {
      const navId = controller.beginNavigation();
      const renderPromise = controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        actionType: "navigate",
        createNavigationCommitEffect,
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot(
          "https://example.com/dashboard",
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
      { getRouteManifest: () => createRootChangeRouteManifest() },
    );
    const { assign } = stubWindow("https://example.com/marketing");
    const pendingRouterState = controller.beginPendingBrowserRouterState();
    assign.mockImplementation(() => {
      expect(pendingRouterState.settled).toBe(true);
    });

    try {
      const navId = controller.beginNavigation();
      void controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot(
          "https://example.com/dashboard",
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

  it("blocks a repeated same-target root-boundary hard navigation to prevent reload loops", async () => {
    const { controller, detach } = createControllerHarness(
      createState({ rootLayoutTreePath: "/(marketing)" }),
      { getRouteManifest: () => createRootChangeRouteManifest() },
    );
    const { assign, storage } = stubWindow("https://example.com/marketing");

    try {
      const firstNavId = controller.beginNavigation();
      await expect(
        controller.renderNavigationPayload({
          payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
          actionType: "navigate",
          createNavigationCommitEffect: () => () => {},
          historyUpdateMode: "push",
          navigationSnapshot: createClientNavigationRenderSnapshot(
            "https://example.com/dashboard",
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
          navId: firstNavId,
        }),
      ).resolves.toBe("hard-navigate");
      expect(assign).toHaveBeenCalledTimes(1);
      expect(storage.size).toBe(1);

      assign.mockClear();
      window.location.href = "https://example.com/dashboard";
      const secondNavId = controller.beginNavigation();
      await expect(
        controller.renderNavigationPayload({
          payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
          actionType: "navigate",
          createNavigationCommitEffect: () => () => {},
          historyUpdateMode: "push",
          navigationSnapshot: createClientNavigationRenderSnapshot(
            "https://example.com/dashboard",
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
          navId: secondNavId,
        }),
      ).resolves.toBe("no-commit");
      expect(assign).not.toHaveBeenCalled();
      expect(storage.size).toBe(0);
    } finally {
      detach();
    }
  });

  it("blocks a repeated same-target hard-navigation fallback outside visible commits", () => {
    const controller = createAppBrowserNavigationController();
    const { assign } = stubWindow("https://example.com/dashboard");

    expect(controller.performHardNavigation("https://example.com/dashboard")).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);

    assign.mockClear();
    expect(controller.performHardNavigation("https://example.com/dashboard")).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("allows cross-page hard navigation when the stored guard target is not the current URL", async () => {
    const { controller, detach } = createControllerHarness(
      createState({ rootLayoutTreePath: "/(marketing)" }),
      { getRouteManifest: () => createRootChangeRouteManifest() },
    );
    const { assign } = stubWindow("https://example.com/marketing");

    try {
      const firstNavId = controller.beginNavigation();
      await expect(
        controller.renderNavigationPayload({
          payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
          actionType: "navigate",
          createNavigationCommitEffect: () => () => {},
          historyUpdateMode: "push",
          navigationSnapshot: createClientNavigationRenderSnapshot(
            "https://example.com/dashboard",
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
          navId: firstNavId,
        }),
      ).resolves.toBe("hard-navigate");
      expect(assign).toHaveBeenCalledTimes(1);

      assign.mockClear();
      window.location.href = "https://example.com/settings";
      const secondNavId = controller.beginNavigation();
      await expect(
        controller.renderNavigationPayload({
          payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
          actionType: "navigate",
          createNavigationCommitEffect: () => () => {},
          historyUpdateMode: "push",
          navigationSnapshot: createClientNavigationRenderSnapshot(
            "https://example.com/dashboard",
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
          navId: secondNavId,
        }),
      ).resolves.toBe("hard-navigate");
      expect(assign).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledWith("https://example.com/dashboard");
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

  it("stores traversal index alongside existing history state", () => {
    const state = createHistoryStateWithNavigationMetadata(
      {
        __vinext_scrollY: 120,
      },
      {
        previousNextUrl: "/feed?tab=latest",
        traversalIndex: 4,
      },
    );

    expect(state).toEqual({
      __vinext_historyIndex: 4,
      __vinext_previousNextUrl: "/feed?tab=latest",
      __vinext_scrollY: 120,
    });
    expect(readHistoryStateTraversalIndex(state)).toBe(4);
  });

  it("resolves back, forward, and unknown traversal intent from history state", () => {
    expect(
      resolveHistoryTraversalIntent({
        currentHistoryIndex: 5,
        historyState: { __vinext_historyIndex: 3 },
      }).direction,
    ).toBe("back");
    expect(
      resolveHistoryTraversalIntent({
        currentHistoryIndex: 5,
        historyState: { __vinext_historyIndex: 7 },
      }).direction,
    ).toBe("forward");
    expect(
      resolveHistoryTraversalIntent({
        currentHistoryIndex: 5,
        historyState: {},
      }),
    ).toEqual({
      direction: "unknown",
      historyState: {},
      targetHistoryIndex: null,
    });
    expect(
      resolveHistoryTraversalIntent({
        currentHistoryIndex: null,
        historyState: { __vinext_historyIndex: 7 },
      }),
    ).toEqual({
      direction: "unknown",
      historyState: { __vinext_historyIndex: 7 },
      targetHistoryIndex: 7,
    });
  });

  it("classifies same-url payloads without treating snapshot root topology as authority", async () => {
    const currentState = createState({
      rootLayoutTreePath: "/(marketing)",
    });

    const result = await resolveAndClassifyNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      activeNavigationId: 7,
      currentState,
      navigationSnapshot: currentState.navigationSnapshot,
      nextElements: Promise.resolve(createResolvedElements("route:/dashboard", "/(dashboard)")),
      operationLane: "server-action",
      renderId: 3,
      startedNavigationId: 7,
      targetHref: "https://example.com/dashboard?action=same-url",
      type: "navigate",
    });

    expect(result.decision.disposition).toBe("commit");
    expect(result.pending.routeId).toBe("route:/dashboard");
    expect(result.pending.action.renderId).toBe(3);
    expect(result.trace.entries[0]?.code).toBe(NavigationTraceTransactionCodes.visibleCommit);
    expect(result.trace.entries[1]?.code).toBe(NavigationTraceReasonCodes.rootBoundaryUnknown);
    expect(result.trace.entries[1]?.fields.targetHref).toBe(
      "https://example.com/dashboard?action=same-url",
    );
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

  it("preserves only planner-approved same-layout ancestors on navigate commits", async () => {
    const rootLayout = React.createElement("div", null, "root layout");
    const dashboardLayout = React.createElement("div", null, "dashboard layout");
    const staleLayout = React.createElement("div", null, "stale layout");
    const stalePage = React.createElement("main", null, "stale page");
    const state = createState({
      elements: createResolvedElements(
        "route:/dashboard",
        "/",
        null,
        {
          "layout:/": rootLayout,
          "layout:/dashboard": dashboardLayout,
          "layout:/stale": staleLayout,
          "page:/stale": stalePage,
        },
        ["layout:/", "layout:/dashboard"],
      ),
      layoutFlags: {
        "layout:/": "s",
        "layout:/dashboard": "s",
        "layout:/stale": "d",
      },
      layoutIds: ["layout:/", "layout:/dashboard"],
    });

    const nextState = await applyApprovedTestCommit(state, {
      extraEntries: {
        "page:/dashboard/settings": React.createElement("main", null, "settings"),
      },
      layoutIds: ["layout:/", "layout:/dashboard", "layout:/dashboard/settings"],
      layoutFlags: { "layout:/dashboard/settings": "d" },
      rootLayoutTreePath: "/",
      routeId: "route:/dashboard/settings",
    });

    expect(nextState.elements["layout:/"]).toBe(rootLayout);
    expect(nextState.elements["layout:/dashboard"]).toBe(dashboardLayout);
    expect(Object.hasOwn(nextState.elements, "layout:/stale")).toBe(false);
    expect(Object.hasOwn(nextState.elements, "page:/stale")).toBe(false);
    expect(nextState.layoutFlags).toEqual({
      "layout:/": "s",
      "layout:/dashboard": "s",
      "layout:/dashboard/settings": "d",
    });
    expect(nextState.layoutIds).toEqual([
      "layout:/",
      "layout:/dashboard",
      "layout:/dashboard/settings",
    ]);
  });

  it("does not preserve same-layout ancestors when root identity is unknown", async () => {
    const rootLayout = React.createElement("div", null, "root layout");
    const state = createState({
      elements: createResolvedElements("route:/dashboard", "/", null, { "layout:/": rootLayout }, [
        "layout:/",
      ]),
      layoutIds: ["layout:/"],
    });

    const nextState = await applyApprovedTestCommit(state, {
      extraEntries: {
        "page:/legacy": React.createElement("main", null, "legacy"),
      },
      layoutIds: [],
      rootLayoutTreePath: null,
      routeId: "route:/legacy",
    });

    expect(Object.hasOwn(nextState.elements, "layout:/")).toBe(false);
    expect(nextState.layoutIds).toEqual([]);
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

  it("does not approve mounted parallel slots on approved traverse commits", async () => {
    const feedLayout = React.createElement("div", null, "feed layout");
    const mountedSlot = React.createElement("div", null, "modal");
    const modalSlotBinding = {
      ownerLayoutId: "layout:/feed",
      slotId: "slot:modal:/feed",
      state: "active",
    } satisfies AppElementsSlotBinding;
    const state = createState({
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": feedLayout,
          "slot:modal:/feed": mountedSlot,
        },
        ["layout:/", "layout:/feed"],
        [modalSlotBinding],
      ),
      layoutIds: ["layout:/", "layout:/feed"],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/feed", {}),
      routeId: "route:/feed",
      slotBindings: [modalSlotBinding],
    });
    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState: state,
      nextElements: Promise.resolve(
        createResolvedElements(
          "route:/feed/comments",
          "/",
          null,
          {
            "page:/feed/comments": React.createElement("main", null, "comments"),
          },
          ["layout:/", "layout:/feed", "layout:/feed/comments"],
          [
            {
              ownerLayoutId: "layout:/feed",
              slotId: "slot:modal:/feed",
              state: "default",
            },
          ],
        ),
      ),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/feed/comments",
        {},
      ),
      operationLane: "traverse",
      previousNextUrl: null,
      renderId: 1,
      type: "traverse",
    });

    const approval = approvePendingNavigationCommit({
      activeNavigationId: 1,
      currentState: state,
      pending,
      routeManifest: createRouteManifestForPendingCommit(state, pending),
      startedNavigationId: 1,
      targetHref: "https://example.com/feed/comments",
    });

    expect(approval.decision.disposition).toBe("commit");
    if (approval.decision.disposition !== "commit") {
      throw new Error("Expected visible commit approval");
    }
    expect(approval.decision.preserveElementIds).toEqual(["layout:/", "layout:/feed"]);
    expect(approval.decision.preservePreviousSlotIds).toEqual([]);
    if (approval.approvedCommit === null) {
      throw new Error("Expected approved visible commit");
    }

    const nextState = applyApprovedVisibleCommit(state, approval.approvedCommit);
    expect(nextState.elements["layout:/feed"]).toBe(feedLayout);
    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(false);
  });

  it("preserves planner-approved default parallel slots on approved navigate commits", async () => {
    const mountedSlot = React.createElement("div", null, "modal");
    const modalSlotBinding = {
      ownerLayoutId: "layout:/feed",
      slotId: "slot:modal:/feed",
      state: "active",
    } satisfies AppElementsSlotBinding;
    const state = createState({
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": React.createElement("div", null, "feed layout"),
          "slot:modal:/feed": mountedSlot,
        },
        ["layout:/", "layout:/feed"],
        [modalSlotBinding],
      ),
      layoutIds: ["layout:/", "layout:/feed"],
      slotBindings: [modalSlotBinding],
    });

    const nextState = await applyApprovedTestCommit(state, {
      extraEntries: {
        "page:/feed/comments": React.createElement("main", null, "comments"),
      },
      layoutIds: ["layout:/", "layout:/feed", "layout:/feed/comments"],
      rootLayoutTreePath: "/",
      routeId: "route:/feed/comments",
      slotBindings: [
        {
          ownerLayoutId: "layout:/feed",
          slotId: "slot:modal:/feed",
          state: "default",
        },
      ],
    });

    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(true);
    expect(nextState.elements["slot:modal:/feed"]).toBe(mountedSlot);
    expect(nextState.slotBindings).toEqual([modalSlotBinding]);
  });

  it("keeps previous slot binding proof when the target marks a preserved slot unmatched", async () => {
    const mountedSlot = React.createElement("div", null, "modal");
    const modalSlotBinding = {
      ownerLayoutId: "layout:/feed",
      slotId: "slot:modal:/feed",
      state: "active",
    } satisfies AppElementsSlotBinding;
    const state = createState({
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": React.createElement("div", null, "feed layout"),
          "slot:modal:/feed": mountedSlot,
        },
        ["layout:/", "layout:/feed"],
        [modalSlotBinding],
      ),
      layoutIds: ["layout:/", "layout:/feed"],
      slotBindings: [modalSlotBinding],
    });

    const nextState = await applyApprovedTestCommit(state, {
      extraEntries: {
        "page:/feed/comments": React.createElement("main", null, "comments"),
      },
      layoutIds: ["layout:/", "layout:/feed", "layout:/feed/comments"],
      rootLayoutTreePath: "/",
      routeId: "route:/feed/comments",
      slotBindings: [
        {
          ownerLayoutId: "layout:/feed",
          slotId: "slot:modal:/feed",
          state: "unmatched",
        },
      ],
    });

    expect(nextState.elements["slot:modal:/feed"]).toBe(mountedSlot);
    expect(nextState.slotBindings).toEqual([modalSlotBinding]);
  });

  it("does not infer default slot preservation from previous wire entries", async () => {
    const state = createState({
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": React.createElement("div", null, "feed layout"),
          "slot:modal:/feed": React.createElement("div", null, "modal"),
        },
        ["layout:/", "layout:/feed"],
      ),
      layoutIds: ["layout:/", "layout:/feed"],
    });

    const nextState = await applyApprovedTestCommit(state, {
      extraEntries: {
        "page:/feed/comments": React.createElement("main", null, "comments"),
      },
      layoutIds: ["layout:/", "layout:/feed", "layout:/feed/comments"],
      rootLayoutTreePath: "/",
      routeId: "route:/feed/comments",
      slotBindings: [
        {
          ownerLayoutId: "layout:/feed",
          slotId: "slot:modal:/feed",
          state: "default",
        },
      ],
    });

    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(false);
  });

  it("does not preserve absent parallel slots when their owner layout is not approved", async () => {
    const state = createState({
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": React.createElement("div", null, "feed layout"),
          "slot:modal:/feed": React.createElement("div", null, "modal"),
        },
        ["layout:/", "layout:/feed"],
      ),
      layoutIds: ["layout:/", "layout:/feed"],
    });

    const nextState = await applyApprovedTestCommit(state, {
      extraEntries: {
        "page:/settings": React.createElement("main", null, "settings"),
      },
      layoutIds: ["layout:/", "layout:/settings"],
      rootLayoutTreePath: "/",
      routeId: "route:/settings",
    });

    expect(Object.hasOwn(nextState.elements, "slot:modal:/feed")).toBe(false);
  });
});

describe("createPopstateRestoreHandler", () => {
  it("restores scroll only after the latest popstate navigation commits", async () => {
    const restoreCalls: unknown[] = [];
    const firstNavigation = createDeferred();
    const secondNavigation = createDeferred();
    let popstateCalls = 0;
    const popstate = vi.fn(() => {
      popstateCalls += 1;
      if (popstateCalls === 1) {
        return firstNavigation.promise;
      }
      return secondNavigation.promise;
    });
    let activeNavigationId = 0;

    stubWindow("https://example.com/feed");
    window.__VINEXT_RSC_PENDING__ = null;

    const handler = createPopstateRestoreHandler({
      getActiveNavigationId: () => activeNavigationId,
      getNavigate: () => {
        activeNavigationId += 1;
        return () => popstate();
      },
      getPendingNavigation: () => window.__VINEXT_RSC_PENDING__,
      isCurrentNavigation: (navId) => navId === activeNavigationId,
      notifyAppRouterTransitionStart: () => {},
      restorePopstateScrollPosition: (scrollState) => {
        restoreCalls.push(scrollState);
      },
      setPendingNavigation: (pendingNavigation) => {
        window.__VINEXT_RSC_PENDING__ = pendingNavigation;
      },
    });

    handler({ state: { __vinext_scrollY: 10 } } as PopStateEvent);
    handler({ state: { __vinext_scrollY: 20 } } as PopStateEvent);

    expect(window.__VINEXT_RSC_PENDING__).toBe(secondNavigation.promise);

    secondNavigation.resolve();
    await secondNavigation.promise;
    await Promise.resolve();

    expect(restoreCalls).toEqual([{ __vinext_scrollY: 20 }]);
    expect(window.__VINEXT_RSC_PENDING__).toBeNull();

    firstNavigation.resolve();
    await firstNavigation.promise;
    await Promise.resolve();

    expect(restoreCalls).toEqual([{ __vinext_scrollY: 20 }]);
    expect(window.__VINEXT_RSC_PENDING__).toBeNull();
  });

  it("clears __VINEXT_RSC_PENDING__ when a stale popstate navigation settles", async () => {
    const restoreCalls: unknown[] = [];
    const navigation = createDeferred();
    let activeNavigationId = 1;

    stubWindow("https://example.com/feed");
    window.__VINEXT_RSC_PENDING__ = null;

    const handler = createPopstateRestoreHandler({
      getActiveNavigationId: () => activeNavigationId,
      getNavigate: () => {
        activeNavigationId = 1;
        return () => navigation.promise;
      },
      getPendingNavigation: () => window.__VINEXT_RSC_PENDING__,
      isCurrentNavigation: (navId) => navId === activeNavigationId,
      notifyAppRouterTransitionStart: () => {},
      restorePopstateScrollPosition: (scrollState) => {
        restoreCalls.push(scrollState);
      },
      setPendingNavigation: (pendingNavigation) => {
        window.__VINEXT_RSC_PENDING__ = pendingNavigation;
      },
    });

    handler({ state: { __vinext_scrollY: 10 } } as PopStateEvent);
    expect(window.__VINEXT_RSC_PENDING__).toBe(navigation.promise);

    activeNavigationId = 2;
    navigation.resolve();
    await navigation.promise;
    await Promise.resolve();

    expect(restoreCalls).toEqual([]);
    expect(window.__VINEXT_RSC_PENDING__).toBeNull();
  });
});

describe("app browser RSC redirect lifecycle", () => {
  it("keeps RSC redirect hops in the initiating lifecycle and preserves push history intent", () => {
    const decision = resolveRscRedirectLifecycleHop({
      currentHref: "https://example.com/start",
      historyUpdateMode: "push",
      origin: "https://example.com",
      redirectDepth: 0,
      requestPreviousNextUrl: "/feed",
      responseUrl: "https://example.com/target.rsc?tab=1&_rsc=abc",
    });

    expect(decision).toEqual({
      href: "/target?tab=1",
      historyUpdateMode: "push",
      kind: "follow",
      previousNextUrl: "/feed",
      redirectDepth: 1,
    });
  });

  it("treats same-path search changes as RSC redirects", () => {
    const decision = resolveRscRedirectLifecycleHop({
      currentHref: "https://example.com/items?sort=old",
      historyUpdateMode: "replace",
      origin: "https://example.com",
      redirectDepth: 2,
      requestPreviousNextUrl: null,
      responseUrl: "https://example.com/items.rsc?sort=new&_rsc=abc",
    });

    expect(decision).toMatchObject({
      href: "/items?sort=new",
      historyUpdateMode: "replace",
      kind: "follow",
      redirectDepth: 3,
    });
  });

  it("allows callers to model terminal traverse/refresh redirects as replace commits", () => {
    const decision = resolveRscRedirectLifecycleHop({
      currentHref: "https://example.com/old",
      historyUpdateMode: "replace",
      origin: "https://example.com",
      redirectDepth: 0,
      requestPreviousNextUrl: null,
      responseUrl: "https://example.com/new.rsc?_rsc=abc",
    });

    expect(decision).toMatchObject({
      href: "/new",
      historyUpdateMode: "replace",
      kind: "follow",
    });
  });

  it("turns external RSC redirects into terminal hard navigations", () => {
    const decision = resolveRscRedirectLifecycleHop({
      currentHref: "https://example.com/account",
      historyUpdateMode: "push",
      origin: "https://example.com",
      redirectDepth: 0,
      requestPreviousNextUrl: null,
      responseUrl: "https://idp.example/login",
    });

    expect(decision).toEqual({
      href: "https://idp.example/login",
      kind: "terminal-hard-navigation",
      reason: "externalRedirect",
      redirectDepth: 0,
    });
  });

  it("turns an over-budget redirect chain into a terminal hard navigation", () => {
    const decision = resolveRscRedirectLifecycleHop({
      currentHref: "https://example.com/a",
      historyUpdateMode: "push",
      maxRedirectDepth: 2,
      origin: "https://example.com",
      redirectDepth: 2,
      requestPreviousNextUrl: null,
      responseUrl: "https://example.com/b.rsc?_rsc=abc",
    });

    expect(decision).toEqual({
      href: "/b",
      kind: "terminal-hard-navigation",
      reason: "maxRedirectsExceeded",
      redirectDepth: 2,
    });
  });
});

describe("devOnCaughtError (hydrateRoot dev handler)", () => {
  it("ignores redirect sentinels handled by RedirectBoundary", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      devOnCaughtError(
        Object.assign(new Error("NEXT_REDIRECT:/?auth=required"), {
          digest: "NEXT_REDIRECT;;%2F%3Fauth%3Drequired",
        }),
        { componentStack: "\n    at ProtectedPage" },
      );
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

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

describe("devOnUncaughtError (hydrateRoot dev handler)", () => {
  it("ignores redirect sentinels handled by global redirect recovery", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      devOnUncaughtError(
        Object.assign(new Error("NEXT_REDIRECT:/?auth=required"), {
          digest: "NEXT_REDIRECT;;%2F%3Fauth%3Drequired",
        }),
        { componentStack: "\n    at ProtectedPage" },
      );
      expect(consoleSpy).not.toHaveBeenCalled();
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

describe("app browser form-state hydration", () => {
  it("schedules App Router hydrateRoot inside a transition", () => {
    const container = { nodeType: 1 } as Element;
    const root = { render: vi.fn(), unmount: vi.fn() };
    const callOrder: string[] = [];
    const hydrateRoot = vi.fn(() => {
      callOrder.push("hydrateRoot");
      return root;
    });
    const startTransition = vi.fn((action: () => void) => {
      callOrder.push("transition:start");
      action();
      callOrder.push("transition:end");
    });

    const result = hydrateRootInTransition({
      children: "root",
      container,
      hydrateRoot,
      options: {},
      startTransition,
    });

    expect(result).toBe(root);
    expect(startTransition).toHaveBeenCalledTimes(1);
    expect(hydrateRoot).toHaveBeenCalledWith(container, "root", {});
    expect(callOrder).toEqual(["transition:start", "hydrateRoot", "transition:end"]);
  });

  it("passes the one-shot form-state bootstrap payload to hydrateRoot options", () => {
    const formState = ["action-result", "key-path", "reference-id", 1] as never;
    const global = { [RSC_FORM_STATE_GLOBAL]: formState };
    const onCaughtError = vi.fn();
    const onUncaughtError = vi.fn();
    const hydrateRoot = vi.fn();

    const consumedFormState = consumeInitialFormState(global);
    const hydrateOptions = createVinextHydrateRootOptions({
      formState: consumedFormState,
      onCaughtError,
      onUncaughtError,
    });
    hydrateRoot("document", "root", hydrateOptions);

    expect(global).not.toHaveProperty(RSC_FORM_STATE_GLOBAL);
    expect(hydrateRoot).toHaveBeenCalledWith(
      "document",
      "root",
      expect.objectContaining({ formState }),
    );
    expect(hydrateOptions).toEqual({
      formState,
      onCaughtError,
      onUncaughtError,
    });
  });

  it("preserves null form state as an explicit hydrateRoot option", () => {
    const onUncaughtError = vi.fn();

    expect(
      createVinextHydrateRootOptions({
        formState: consumeInitialFormState({}),
        onUncaughtError,
      }),
    ).toEqual({
      formState: null,
      onUncaughtError,
    });
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
