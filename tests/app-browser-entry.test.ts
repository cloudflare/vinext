import React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createDevOnCaughtError,
  createOnUncaughtError,
  createProdOnCaughtError,
  prodOnCaughtError,
  prodOnRecoverableError,
} from "../packages/vinext/src/server/app-browser-error.js";
import {
  clearAppNavigationFailureTarget,
  handleAppNavigationFailure,
  stageAppNavigationFailureTarget,
} from "../packages/vinext/src/client/app-nav-failure-handler.js";
import { applyServerActionResultDecision } from "../packages/vinext/src/server/app-browser-server-action-navigation.js";
import {
  createDiscardedServerActionRefreshScheduler,
  createServerActionInitiationSnapshot,
  createServerActionResultFacts,
  normalizeServerActionThrownValue,
  parseServerActionRevalidationHeader,
  readInvalidServerActionResponseError,
  shouldClearClientNavigationCachesForServerActionResult,
  shouldSyncServerActionHttpFallbackHead,
  shouldScheduleRefreshForDiscardedServerAction,
} from "../packages/vinext/src/server/app-browser-action-result.js";
import {
  RSC_FORM_STATE_GLOBAL,
  consumeInitialFormState,
  createVinextHydrateRootOptions,
  hydrateRootInTransition,
} from "../packages/vinext/src/server/app-browser-hydration.js";
import { createAppBrowserNavigationController } from "../packages/vinext/src/server/app-browser-navigation-controller.js";
import {
  createPopstateRestoreHandler,
  restoreSynchronousPopstateScrollPosition,
} from "../packages/vinext/src/server/app-browser-popstate.js";
import {
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  resolveRscCompatibilityNavigationDecision,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  isInlineCssStylesheetLinkElement,
  removeStylesheetLinksCoveredByInlineCss,
} from "../packages/vinext/src/server/app-inline-css-client.js";
import {
  DEV_ERROR_OVERLAY_HOST_ID,
  DEV_ERROR_OVERLAY_MOUNT_ID,
  createDevErrorOverlayMountNode,
  createViteOpenInEditorUrl,
  devOnCaughtError,
  devOnUncaughtError,
  formatErrorInfoForClipboard,
  formatOverlayDisplayFile,
  formatViteOpenInEditorFile,
  installReactRefreshErrorRecovery,
  normalizeViteHmrError,
} from "../packages/vinext/src/client/dev-error-overlay.js";
import {
  dismissOverlay,
  reportToOverlay,
  subscribeOverlay,
} from "../packages/vinext/src/client/dev-error-overlay-store.js";
import { VINEXT_DEV_ERROR_RECOVERY_EVENT } from "../packages/vinext/src/utils/dev-error-recovery-event.js";
import {
  APP_CACHE_ENTRY_REUSE_PROOF_KEY,
  AppElementsWire,
  APP_LAYOUT_FLAGS_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  APP_SKIPPED_LAYOUT_IDS_KEY,
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
  createBfcacheSegmentStateKeyMap,
  createInitialBfcacheIdMap,
  createNextBfcacheIdMap,
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  VISITED_CACHE_APP_NAVIGATION_PAYLOAD_ORIGIN,
  createPendingNavigationCommit,
  isCacheRestorableAppPayloadMetadata,
  isHistoryStateBfcacheVersionCurrent,
  readHistoryStateBfcacheIds,
  readHistoryStateBfcacheVersion,
  readHistoryStatePreviousNextUrl,
  readHistoryStateTraversalIndex,
  resolveInterceptionContextFromPreviousNextUrl,
  resolveHistoryTraversalIntent,
  resolveServerActionRequestState,
  resolvePendingNavigationCommitDispositionDecision,
  type AppRouterState,
  type OperationLane,
} from "../packages/vinext/src/server/app-browser-state.js";
import { createInitialBfcacheMaps } from "../packages/vinext/src/server/app-bfcache-identity.js";
import {
  HistoryStateSnapshotCache,
  RestorableClientStateController,
} from "../packages/vinext/src/server/app-history-state.js";
import {
  blockDangerousStreamedRscRedirect,
  resolveRscRedirectLifecycleHop,
  resolveStreamedRscRedirectLifecycleHop,
} from "../packages/vinext/src/server/app-browser-rsc-redirect.js";
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
import { navigationPlanner } from "../packages/vinext/src/server/navigation-planner.js";
import { createCacheEntryReuseProof } from "../packages/vinext/src/server/cache-proof.js";
import {
  ACTION_REVALIDATED_HEADER,
  ACTION_REDIRECT_HEADER,
  ACTION_REDIRECT_TYPE_HEADER,
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
    bfcacheIds: {},
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

type TestDomElement = {
  attributes: Record<string, string>;
  removed: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  remove(): void;
};

function createTestDomElement(attributes: Record<string, string>): TestDomElement {
  return {
    attributes,
    removed: false,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? (this.attributes[name] ?? "")
        : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    remove() {
      this.removed = true;
    },
  };
}

function installInlineCssCleanupDocument(options: {
  links: TestDomElement[];
  styles: TestDomElement[];
}): void {
  const { links, styles } = options;
  const head = {
    querySelectorAll<T extends Element>(selector: string): T[] {
      if (selector === "style[data-vinext-inline-css][data-href]") {
        const matchingStyles = styles.filter(
          (style) =>
            style.hasAttribute("data-vinext-inline-css") && style.hasAttribute("data-href"),
        );
        return matchingStyles as unknown as T[];
      }

      if (selector === 'link[rel="stylesheet"][href][data-precedence]') {
        const matchingLinks = links.filter(
          (link) =>
            link.getAttribute("rel") === "stylesheet" &&
            link.hasAttribute("href") &&
            link.hasAttribute("data-precedence"),
        );
        return matchingLinks as unknown as T[];
      }

      if (selector === "link[rel][href]") {
        const matchingLinks = links.filter(
          (link) => link.hasAttribute("rel") && link.hasAttribute("href"),
        );
        return matchingLinks as unknown as T[];
      }

      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  vi.stubGlobal("document", { head });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("app browser entry inline CSS cleanup", () => {
  it("classifies stylesheet links with tokenized rel values and legacy precedence", () => {
    expect(
      isInlineCssStylesheetLinkElement(
        createTestDomElement({
          "data-precedence": "next",
          href: "/_next/static/app.css",
          rel: "preload stylesheet",
        }),
      ),
    ).toBe(true);
    expect(
      isInlineCssStylesheetLinkElement(
        createTestDomElement({
          href: "/_next/static/legacy.css",
          precedence: "next",
          rel: "stylesheet",
        }),
      ),
    ).toBe(true);
    expect(
      isInlineCssStylesheetLinkElement(
        createTestDomElement({
          href: "/_next/static/preload.css",
          rel: "preload",
        }),
      ),
    ).toBe(false);
  });

  it("prunes navigated stylesheet links covered by inline CSS", () => {
    const tokenizedRelLink = createTestDomElement({
      "data-precedence": "next",
      href: "/_next/static/app.css",
      rel: "preload stylesheet",
    });
    const legacyPrecedenceLink = createTestDomElement({
      href: "/_next/static/legacy.css",
      precedence: "next",
      rel: "stylesheet",
    });
    const uncoveredLink = createTestDomElement({
      "data-precedence": "next",
      href: "/_next/static/uncovered.css",
      rel: "stylesheet",
    });
    installInlineCssCleanupDocument({
      links: [tokenizedRelLink, legacyPrecedenceLink, uncoveredLink],
      styles: [
        createTestDomElement({
          "data-href": "/_next/static/app.css /_next/static/legacy.css",
          "data-vinext-inline-css": "",
        }),
      ],
    });

    removeStylesheetLinksCoveredByInlineCss();

    expect(tokenizedRelLink.removed).toBe(true);
    expect(legacyPrecedenceLink.removed).toBe(true);
    expect(uncoveredLink.removed).toBe(false);
  });
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

  it("createServerActionResultFacts normalises raw response data into planner facts", () => {
    const currentHref = "https://example.com/current";

    // RSC redirect with push type
    const pushFacts = createServerActionResultFacts({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "push",
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: "server-build",
      contentTypeHeader: "text/x-component",
      currentHref,
      origin: "https://example.com",
      responseUrl: currentHref,
    });
    expect(pushFacts.actionRedirectHref).toBe("https://example.com/target");
    expect(pushFacts.actionRedirectType).toBe("push");
    expect(pushFacts.isRscContentType).toBe(true);

    // RSC redirect with unknown type normalises to replace
    const replaceFacts = createServerActionResultFacts({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "unknown",
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: "server-build",
      contentTypeHeader: "text/x-component",
      currentHref,
      origin: "https://example.com",
      responseUrl: currentHref,
    });
    expect(replaceFacts.actionRedirectType).toBe("replace");

    // No redirect — the raw type is still normalized for the planner contract
    const noRedirectFacts = createServerActionResultFacts({
      actionRedirectHref: null,
      actionRedirectType: null,
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: "server-build",
      contentTypeHeader: "text/x-component",
      currentHref,
      origin: "https://example.com",
      responseUrl: currentHref,
    });
    expect(noRedirectFacts.actionRedirectHref).toBeNull();
    expect(noRedirectFacts.actionRedirectType).toBe("replace");

    // Non-RSC response — isRscContentType should be false
    const nonRscFacts = createServerActionResultFacts({
      actionRedirectHref: null,
      actionRedirectType: null,
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: "server-build",
      contentTypeHeader: "text/plain",
      currentHref,
      origin: "https://example.com",
      responseUrl: currentHref,
    });
    expect(nonRscFacts.isRscContentType).toBe(false);
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

  it("restores action HTTP fallback errors from response status", () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    const fallback = normalizeServerActionThrownValue(new Error("sanitized"), 404);

    expect(fallback).toBeInstanceOf(Error);
    if (fallback instanceof Error && "digest" in fallback) {
      expect(fallback.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    } else {
      throw new Error("Expected fallback to have a digest property");
    }
  });

  it("lets thrown action HTTP fallbacks own their boundary robots metadata", () => {
    expect(
      shouldSyncServerActionHttpFallbackHead({
        returnValue: { ok: false, data: new Error("sanitized") },
      }),
    ).toBe(false);
    expect(shouldSyncServerActionHttpFallbackHead({ returnValue: { ok: true, data: null } })).toBe(
      true,
    );
    expect(
      shouldSyncServerActionHttpFallbackHead({
        root: { __route: "/current" },
        returnValue: { ok: false, data: new Error("sanitized") },
      }),
    ).toBe(false);
  });

  it("preserves ordinary server action errors for 500 responses", () => {
    const error = new Error("sanitized action failure");

    expect(normalizeServerActionThrownValue(error, 500)).toBe(error);
  });

  it("uses text/plain action response bodies as boundary errors", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    const error = await readInvalidServerActionResponseError(
      new Response("Custom error!", {
        status: 500,
        headers: { "content-type": "text/plain;charset=utf-8" },
      }),
      false,
    );

    expect(error?.message).toBe("Custom error!");
  });

  it("applyServerActionResultDecision clears caches and hard-navigates for a redirect mismatch", () => {
    // Executor regression: verifies the wiring between classifyServerActionResult output and
    // the executor's performHardNavigation + clearClientNavigationCaches dispatch.
    const clearCaches = vi.fn();
    const performHardNavigation = vi.fn();

    // push redirect with an incompatible build — executor should hard-navigate and clear caches
    const pushDecision = navigationPlanner.classifyServerActionResult({
      actionRedirectHref: "https://example.com/target?tab=1",
      actionRedirectType: "push",
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: "server-build",
      currentHref: "https://example.com/current",
      isRscContentType: true,
      origin: "https://example.com",
      responseUrl: "https://example.com/current",
    });
    expect(applyServerActionResultDecision(pushDecision, clearCaches, performHardNavigation)).toBe(
      true,
    );
    expect(clearCaches).toHaveBeenCalledOnce();
    expect(performHardNavigation).toHaveBeenCalledWith(
      "https://example.com/target?tab=1",
      "assign",
    );

    clearCaches.mockClear();
    performHardNavigation.mockClear();

    // replace redirect with an incompatible build — executor should use replace history mode
    const replaceDecision = navigationPlanner.classifyServerActionResult({
      actionRedirectHref: "https://example.com/replaced",
      actionRedirectType: "replace",
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: "server-build",
      currentHref: "https://example.com/current",
      isRscContentType: true,
      origin: "https://example.com",
      responseUrl: "https://example.com/current",
    });
    expect(
      applyServerActionResultDecision(replaceDecision, clearCaches, performHardNavigation),
    ).toBe(true);
    expect(performHardNavigation).toHaveBeenCalledWith("https://example.com/replaced", "replace");

    clearCaches.mockClear();
    performHardNavigation.mockClear();

    // no-redirect RSC mismatch — executor reloads current href, does NOT clear caches
    const noRedirectDecision = navigationPlanner.classifyServerActionResult({
      actionRedirectHref: null,
      actionRedirectType: "replace",
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: "server-build",
      currentHref: "https://example.com/dashboard?view=grid",
      isRscContentType: true,
      origin: "https://example.com",
      responseUrl: "https://example.com/dashboard?view=grid",
    });
    expect(
      applyServerActionResultDecision(noRedirectDecision, clearCaches, performHardNavigation),
    ).toBe(true);
    expect(clearCaches).not.toHaveBeenCalled();
    expect(performHardNavigation).toHaveBeenCalledWith(
      "https://example.com/dashboard?view=grid",
      undefined,
    );

    clearCaches.mockClear();
    performHardNavigation.mockClear();

    // compatible build — executor should proceed, not hard-navigate
    const proceedDecision = navigationPlanner.classifyServerActionResult({
      actionRedirectHref: "https://example.com/target",
      actionRedirectType: "push",
      clientCompatibilityId: "same-build",
      compatibilityIdHeader: "same-build",
      currentHref: "https://example.com/current",
      isRscContentType: true,
      origin: "https://example.com",
      responseUrl: "https://example.com/current",
    });
    expect(
      applyServerActionResultDecision(proceedDecision, clearCaches, performHardNavigation),
    ).toBe(false);
    expect(clearCaches).not.toHaveBeenCalled();
    expect(performHardNavigation).not.toHaveBeenCalled();
  });

  it("wiring: createServerActionResultFacts + classifyServerActionResult end-to-end", () => {
    // Regression for the browser-entry seam: production derives facts via
    // createServerActionResultFacts and passes them to the planner. This test
    // exercises the real helper against synthetic responses so the seam cannot
    // drift out of sync.
    const currentHref = "https://example.com/current";
    const origin = "https://example.com";

    // Incompatible RSC action redirect — mimics the headers a real server would return.
    const redirectResponse = new Response("flight", {
      headers: {
        "content-type": "text/x-component",
        [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "server-build",
        [ACTION_REDIRECT_HEADER]: "https://example.com/target",
        [ACTION_REDIRECT_TYPE_HEADER]: "push",
      },
    });
    const pushFacts = createServerActionResultFacts({
      actionRedirectHref: redirectResponse.headers.get(ACTION_REDIRECT_HEADER),
      actionRedirectType: redirectResponse.headers.get(ACTION_REDIRECT_TYPE_HEADER),
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: redirectResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
      contentTypeHeader: redirectResponse.headers.get("content-type"),
      currentHref,
      origin,
      responseUrl: currentHref,
    });
    const pushDecision = navigationPlanner.classifyServerActionResult(pushFacts);
    expect(pushDecision.kind).toBe("hardNavigate");
    if (pushDecision.kind === "hardNavigate") {
      expect(pushDecision.url).toBe("https://example.com/target");
      expect(pushDecision.historyMode).toBe("assign");
      expect(pushDecision.clearClientNavigationCaches).toBe(true);
      expect(pushDecision.reason).toBe("serverActionRedirectCompatibilityMismatch");
    }

    // Non-standard redirect type (e.g. misspelled header) should normalise to "replace".
    const weirdRedirectResponse = new Response("flight", {
      headers: {
        "content-type": "text/x-component",
        [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "server-build",
        [ACTION_REDIRECT_HEADER]: "https://example.com/target",
        [ACTION_REDIRECT_TYPE_HEADER]: "unknown",
      },
    });
    const weirdFacts = createServerActionResultFacts({
      actionRedirectHref: weirdRedirectResponse.headers.get(ACTION_REDIRECT_HEADER),
      actionRedirectType: weirdRedirectResponse.headers.get(ACTION_REDIRECT_TYPE_HEADER),
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: weirdRedirectResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
      contentTypeHeader: weirdRedirectResponse.headers.get("content-type"),
      currentHref,
      origin,
      responseUrl: currentHref,
    });
    const weirdDecision = navigationPlanner.classifyServerActionResult(weirdFacts);
    expect(weirdDecision.kind).toBe("hardNavigate");
    if (weirdDecision.kind === "hardNavigate") {
      expect(weirdDecision.url).toBe("https://example.com/target");
      expect(weirdDecision.historyMode).toBe("replace");
      expect(weirdDecision.clearClientNavigationCaches).toBe(true);
      expect(weirdDecision.reason).toBe("serverActionRedirectCompatibilityMismatch");
    }

    // No-redirect incompatible RSC response — should reload current href without clearing caches.
    const noRedirectResponse = new Response("flight", {
      headers: {
        "content-type": "text/x-component",
        [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "server-build",
      },
    });
    const noRedirectFacts = createServerActionResultFacts({
      actionRedirectHref: null,
      actionRedirectType: null,
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: noRedirectResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
      contentTypeHeader: noRedirectResponse.headers.get("content-type"),
      currentHref,
      origin,
      responseUrl: currentHref,
    });
    const noRedirectDecision = navigationPlanner.classifyServerActionResult(noRedirectFacts);
    expect(noRedirectDecision.kind).toBe("hardNavigate");
    if (noRedirectDecision.kind === "hardNavigate") {
      expect(noRedirectDecision.url).toBe(currentHref);
      expect(noRedirectDecision.clearClientNavigationCaches).toBe(false);
      expect(noRedirectDecision.reason).toBe("serverActionRscCompatibilityMismatch");
    }

    // Non-RSC response should always proceed regardless of compatibility header.
    const nonRscResponse = new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "server-build",
      },
    });
    const nonRscFacts = createServerActionResultFacts({
      actionRedirectHref: null,
      actionRedirectType: null,
      clientCompatibilityId: "client-build",
      compatibilityIdHeader: nonRscResponse.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER),
      contentTypeHeader: nonRscResponse.headers.get("content-type"),
      currentHref,
      origin,
      responseUrl: currentHref,
    });
    expect(navigationPlanner.classifyServerActionResult(nonRscFacts).kind).toBe("proceed");
  });

  it("uses a stable generic error for non-RSC action responses", async () => {
    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    const error = await readInvalidServerActionResponseError(
      new Response(JSON.stringify({ error: "Custom error!" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      false,
    );

    expect(error?.message).toBe("An unexpected response was received from the server.");
  });

  it("allows non-RSC server action redirect responses", async () => {
    const error = await readInvalidServerActionResponseError(
      new Response("", {
        status: 303,
        headers: { "content-type": "text/plain" },
      }),
      true,
    );

    expect(error).toBeNull();
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

  it("restores visible history snapshots through an approved traversal commit", () => {
    const currentState = createState({
      elements: createResolvedElements("route:/scroll-restoration/other", "/"),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/scroll-restoration/other",
        {},
      ),
      routeId: "route:/scroll-restoration/other",
      visibleCommitVersion: 7,
    });
    const snapshotState = createState({
      elements: createResolvedElements("route:/scroll-restoration", "/"),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/scroll-restoration",
        {},
      ),
      routeId: "route:/scroll-restoration",
      visibleCommitVersion: 2,
    });
    const { controller, stateRef } = createControllerHarness(currentState);
    const navId = controller.beginNavigation();

    const restored = controller.restoreHistorySnapshotVisibleState({
      navId,
      state: snapshotState,
      targetHref: "https://example.com/scroll-restoration",
    });

    expect(restored).toBe(true);
    expect(stateRef.current.routeId).toBe("route:/scroll-restoration");
    expect(stateRef.current.visibleCommitVersion).toBe(8);
    expect(stateRef.current.activeOperation).toMatchObject({
      lane: "traverse",
      startedVisibleCommitVersion: 7,
      state: "committed",
      visibleCommitVersion: 8,
    });
  });

  it("matches visible history snapshot targets after stripping basePath and canonicalizing search", () => {
    const currentState = createState({
      elements: createResolvedElements("route:/scroll-restoration/other", "/"),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/scroll-restoration/other",
        {},
      ),
      routeId: "route:/scroll-restoration/other",
      visibleCommitVersion: 7,
    });
    const snapshotState = createState({
      elements: createResolvedElements("route:/scroll-restoration", "/"),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/scroll-restoration?q=a+b",
        {},
      ),
      routeId: "route:/scroll-restoration",
      visibleCommitVersion: 2,
    });
    const { controller, stateRef } = createControllerHarness(currentState, {
      basePath: "/docs",
    });
    const navId = controller.beginNavigation();

    const restored = controller.restoreHistorySnapshotVisibleState({
      navId,
      state: snapshotState,
      targetHref: "https://example.com/docs/scroll-restoration?q=a%20b",
    });

    expect(restored).toBe(true);
    expect(stateRef.current.routeId).toBe("route:/scroll-restoration");
    expect(stateRef.current.visibleCommitVersion).toBe(8);
  });

  it("rejects visible history snapshots for stale navigation lifecycles", () => {
    const currentState = createState({ visibleCommitVersion: 7 });
    const snapshotState = createState({
      elements: createResolvedElements("route:/scroll-restoration", "/"),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/scroll-restoration",
        {},
      ),
      routeId: "route:/scroll-restoration",
    });
    const { controller, stateRef } = createControllerHarness(currentState);
    const staleNavId = controller.beginNavigation();
    controller.beginNavigation();

    const restored = controller.restoreHistorySnapshotVisibleState({
      navId: staleNavId,
      state: snapshotState,
      targetHref: "https://example.com/scroll-restoration",
    });

    expect(restored).toBe(false);
    expect(stateRef.current).toBe(currentState);
  });

  it("rejects visible history snapshots when the active target does not match", () => {
    const currentState = createState({ visibleCommitVersion: 7 });
    const snapshotState = createState({
      elements: createResolvedElements("route:/scroll-restoration", "/"),
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/scroll-restoration",
        {},
      ),
      routeId: "route:/scroll-restoration",
    });
    const { controller, stateRef } = createControllerHarness(currentState);
    const navId = controller.beginNavigation();

    const restored = controller.restoreHistorySnapshotVisibleState({
      navId,
      state: snapshotState,
      targetHref: "https://example.com/scroll-restoration/other",
    });

    expect(restored).toBe(false);
    expect(stateRef.current).toBe(currentState);
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
          "route:/feed",
          "/",
          "/feed",
          {
            "page:/feed": React.createElement("main", null, "feed"),
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

    expect(pending.routeId).toBe("route:/feed");
    expect(pending.interception).toEqual(createInterceptionProof("/feed", "/photos/42"));
    expect(pending.interceptionContext).toBe("/feed");
    expect(pending.previousNextUrl).toBe("/feed");
    expect(pending.action.interception).toEqual(createInterceptionProof("/feed", "/photos/42"));
    expect(pending.action.interceptionContext).toBe("/feed");
    expect(pending.action.previousNextUrl).toBe("/feed");
  });

  it("mints fresh bfcache ids instead of reusing current ids when requested", async () => {
    const currentRootLayout = React.createElement("div", null, "current root");
    const nextRootLayout = React.createElement("div", null, "next root");
    const currentState = createState({
      bfcacheIds: {
        "layout:/": "_b_4_",
      },
      elements: createResolvedElements("route:/dashboard", "/", null, {
        "layout:/": currentRootLayout,
      }),
    });

    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(
        createResolvedElements("route:/settings", "/", null, {
          "layout:/": nextRootLayout,
        }),
      ),
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {}),
      operationLane: "traverse",
      renderId: 1,
      reuseCurrentBfcacheIds: false,
      type: "traverse",
    });

    expect(pending.action.reuseCurrentBfcacheIds).toBe(false);
    expect(pending.action.bfcacheIds["layout:/"]).toMatch(/^_b_\d+_$/);
    expect(pending.action.bfcacheIds["layout:/"]).not.toBe("_b_4_");
  });

  it("clears previousNextUrl when traversing to a non-intercepted entry", async () => {
    // Traversing back from an intercepted modal (/photos/42 from /feed) to
    // /feed itself. The traverse branch reads null from /feed's history state
    // and passes previousNextUrl: null explicitly — meaning "not intercepted".
    // This must not inherit the current state's stale "/feed" value.
    const interceptedState = createState({
      interceptionContext: "/feed",
      previousNextUrl: "/feed",
      routeId: "route:/feed",
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

  it("does not classify skip-pruned payload metadata as cache-restorable", () => {
    const layoutId = AppElementsWire.encodeLayoutId("/");
    const elements = createResolvedElements(
      "route:/dashboard/settings",
      "/",
      null,
      {
        [APP_CACHE_ENTRY_REUSE_PROOF_KEY]: createCacheEntryReuseProof(null),
        [APP_SKIPPED_LAYOUT_IDS_KEY]: [layoutId],
        "page:/dashboard/settings": React.createElement("main", null, "settings"),
      },
      [layoutId],
    );

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
          AppElementsWire.encodeRouteId("/café", null),
          "/",
          "/caf%C3%A9",
          {
            "page:/café": React.createElement("main", null, "source"),
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
      routeId: AppElementsWire.encodeRouteId("/feed", null),
    });

    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(
        createResolvedElements(
          AppElementsWire.encodeRouteId("/feed", null),
          "/",
          "/feed",
          {
            [AppElementsWire.encodePageId("/feed", null)]: React.createElement(
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
    expect(contextOnlyState.routeId).toBe(AppElementsWire.encodeRouteId("/feed", null));

    const interceptedPending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState: contextOnlyState,
      nextElements: Promise.resolve(
        createResolvedElements(
          AppElementsWire.encodeRouteId("/feed", null),
          "/",
          "/feed",
          {
            [AppElementsWire.encodePageId("/feed", null)]: React.createElement(
              "main",
              null,
              "feed",
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
      routeId: "route:/feed",
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
        createNavigationCommitEffect: () => () => {},
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
        createNavigationCommitEffect: () => () => {},
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
    vi.stubEnv("__NEXT_APP_NAV_FAIL_HANDLING", "true");
    const createNavigationCommitEffect = vi.fn(() => vi.fn());
    let resolveNextElements: ((value: AppElements) => void) | undefined;
    const nextElements = new Promise<AppElements>((resolve) => {
      resolveNextElements = resolve;
    });

    try {
      const navId = controller.beginNavigation();
      stageAppNavigationFailureTarget("/dashboard");
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
      expect(window.next?.__pendingUrl).toBeUndefined();
    } finally {
      detach();
      vi.unstubAllEnvs();
    }
  });

  it("preserves a newer same-URL failure target when an older navigation is discarded", async () => {
    const { controller, detach } = createControllerHarness();
    stubWindow("https://example.com/initial");
    vi.stubEnv("__NEXT_APP_NAV_FAIL_HANDLING", "true");
    let resolveNextElements!: (value: AppElements) => void;

    try {
      stageAppNavigationFailureTarget("/dashboard");
      const olderTarget = window.next?.__pendingUrl;
      const olderNavId = controller.beginNavigation();
      const renderPromise = controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
        nextElements: new Promise<AppElements>((resolve) => {
          resolveNextElements = resolve;
        }),
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/dashboard",
        navId: olderNavId,
      });

      controller.beginNavigation();
      stageAppNavigationFailureTarget("/dashboard");
      const newerTarget = window.next?.__pendingUrl;
      expect(newerTarget).not.toBe(olderTarget);

      resolveNextElements(
        createResolvedElements("route:/dashboard", "/", null, {
          "page:/dashboard": React.createElement("main", null, "dashboard"),
        }),
      );

      await expect(renderPromise).resolves.toBe("no-commit");
      expect(window.next?.__pendingUrl).toBe(newerTarget);
    } finally {
      detach();
      vi.unstubAllEnvs();
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

  it("does not clear a newer navigation failure target when an older render commits", async () => {
    const { controller, detach, stateRef } = createControllerHarness();
    vi.stubEnv("__NEXT_APP_NAV_FAIL_HANDLING", "true");
    vi.stubGlobal("window", {
      location: {
        href: "https://example.com/initial",
        origin: "https://example.com",
      },
      next: {},
    });

    try {
      stageAppNavigationFailureTarget("/older");
      const olderNavId = controller.beginNavigation();
      void controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: Promise.resolve(
          createResolvedElements("route:/older", "/", null, {
            "page:/older": React.createElement("main", null, "older"),
          }),
        ),
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/older",
        navId: olderNavId,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      let resolveNewer!: (elements: AppElements) => void;
      stageAppNavigationFailureTarget("/newer");
      const newerNavId = controller.beginNavigation();
      void controller.renderNavigationPayload({
        payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
        actionType: "navigate",
        createNavigationCommitEffect: () => () => {},
        historyUpdateMode: "push",
        navigationSnapshot: stateRef.current.navigationSnapshot,
        nextElements: new Promise<AppElements>((resolve) => {
          resolveNewer = resolve;
        }),
        operationLane: "navigation",
        params: {},
        pendingRouterState: null,
        previousNextUrl: null,
        targetHref: "https://example.com/newer",
        navId: newerNavId,
      });

      controller.clearCommittedNavigationFailureTargets(1);
      expect(window.next?.__pendingUrl?.pathname).toBe("/newer");

      resolveNewer(
        createResolvedElements("route:/newer", "/", null, {
          "page:/newer": React.createElement("main", null, "newer"),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      controller.clearCommittedNavigationFailureTargets(2);
      expect(window.next?.__pendingUrl).toBeUndefined();
    } finally {
      detach();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
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
      routeId: "route:/feed",
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
      expect(syncHistoryStatePreviousNextUrl).toHaveBeenCalledWith(
        null,
        stateRef.current.bfcacheIds,
      );
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

  it("preserves explicitly skipped retained layouts on approved navigate commits", async () => {
    const rootLayout = React.createElement("div", null, "root layout");
    const staleLayout = React.createElement("div", null, "stale layout");
    const currentState = createState({
      elements: createResolvedElements(
        "route:/dashboard",
        "/",
        null,
        {
          "layout:/": rootLayout,
          "layout:/stale": staleLayout,
        },
        ["layout:/"],
      ),
      layoutFlags: {
        "layout:/": "s",
        "layout:/stale": "s",
      },
      layoutIds: ["layout:/"],
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {}),
      nextElements: Promise.resolve(
        createResolvedElements(
          "route:/settings",
          "/",
          null,
          {
            [APP_LAYOUT_FLAGS_KEY]: {},
            [APP_SKIPPED_LAYOUT_IDS_KEY]: ["layout:/", "layout:/stale"],
            "page:/settings": React.createElement("main", null, "settings"),
          },
          ["layout:/"],
        ),
      ),
      operationLane: "navigation",
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      renderId: 1,
      type: "navigate",
    });
    const approval = approvePendingNavigationCommit({
      activeNavigationId: 1,
      currentState,
      pending,
      routeManifest: null,
      startedNavigationId: 1,
      targetHref: "https://example.com/settings",
    });

    expect(approval.approvedCommit).not.toBeNull();
    if (approval.approvedCommit === null) return;

    expect(approval.decision.preserveElementIds).toEqual(["layout:/"]);

    const nextState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);

    expect(nextState.elements["layout:/"]).toBe(rootLayout);
    expect(Object.hasOwn(nextState.elements, "layout:/stale")).toBe(false);
    expect(nextState.layoutFlags).toEqual({
      "layout:/": "s",
    });
  });

  it("does not preserve skipped layouts when current bfcache ids are stale", async () => {
    const rootLayout = React.createElement("div", null, "root layout");
    const currentState = createState({
      bfcacheIds: {
        "layout:/": "_b_4_",
      },
      elements: createResolvedElements(
        "route:/dashboard",
        "/",
        null,
        {
          "layout:/": rootLayout,
        },
        ["layout:/"],
      ),
      layoutFlags: {
        "layout:/": "s",
      },
      layoutIds: ["layout:/"],
    });
    const pending = await createPendingNavigationCommit({
      currentState,
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/settings", {}),
      nextElements: Promise.resolve(
        createResolvedElements(
          "route:/settings",
          "/",
          null,
          {
            [APP_LAYOUT_FLAGS_KEY]: {},
            [APP_SKIPPED_LAYOUT_IDS_KEY]: ["layout:/"],
            "page:/settings": React.createElement("main", null, "settings"),
          },
          ["layout:/"],
        ),
      ),
      operationLane: "traverse",
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      renderId: 1,
      reuseCurrentBfcacheIds: false,
      type: "traverse",
    });
    const approval = approvePendingNavigationCommit({
      activeNavigationId: 1,
      currentState,
      pending,
      routeManifest: null,
      startedNavigationId: 1,
      targetHref: "https://example.com/settings",
    });

    expect(approval.approvedCommit).not.toBeNull();
    if (approval.approvedCommit === null) return;
    expect(approval.decision.preserveElementIds).toEqual(["layout:/"]);

    const nextState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);

    expect(Object.hasOwn(nextState.elements, "layout:/")).toBe(false);
    expect(nextState.elements["page:/settings"]).toBeDefined();
    expect(nextState.layoutFlags).toEqual({});
    expect(nextState.bfcacheIds["layout:/"]).toMatch(/^_b_\d+_$/);
    expect(nextState.bfcacheIds["layout:/"]).not.toBe("_b_4_");
  });

  it("preserves the default parallel slot owned by a skipped slot-owning layout", async () => {
    const rootLayout = React.createElement("div", null, "root layout");
    const dashboardLayout = React.createElement("div", null, "dashboard layout");
    const modalSlot = React.createElement("div", null, "modal");
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/dashboard");
    const currentModalBinding = {
      ownerLayoutId: "layout:/dashboard",
      slotId: modalSlotId,
      state: "active",
    } satisfies AppElementsSlotBinding;
    const currentState = createState({
      elements: createResolvedElements(
        "route:/dashboard",
        "/",
        null,
        {
          "layout:/": rootLayout,
          "layout:/dashboard": dashboardLayout,
          [modalSlotId]: modalSlot,
        },
        ["layout:/", "layout:/dashboard"],
        [currentModalBinding],
      ),
      layoutFlags: {
        "layout:/": "s",
        "layout:/dashboard": "s",
      },
      layoutIds: ["layout:/", "layout:/dashboard"],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/dashboard", {}),
      routeId: "route:/dashboard",
      slotBindings: [currentModalBinding],
    });
    // Sibling navigation: the server proves layout:/dashboard reusable and omits
    // it from the payload, and the modal slot resolves to its default (no active
    // content) for the target route. In the topology-unknown path the planner
    // preserves neither the layout nor its slot, so the skip merge must restore
    // both — otherwise the retained layout commits with a missing slot.
    const pending = await createPendingNavigationCommit({
      currentState,
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/dashboard/settings",
        {},
      ),
      nextElements: Promise.resolve(
        createResolvedElements(
          "route:/dashboard/settings",
          "/",
          null,
          {
            [APP_LAYOUT_FLAGS_KEY]: {},
            [APP_SKIPPED_LAYOUT_IDS_KEY]: ["layout:/dashboard"],
            "page:/dashboard/settings": React.createElement("main", null, "settings"),
          },
          ["layout:/", "layout:/dashboard"],
          [
            {
              ownerLayoutId: "layout:/dashboard",
              slotId: modalSlotId,
              state: "default",
            },
          ],
        ),
      ),
      operationLane: "navigation",
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      renderId: 1,
      type: "navigate",
    });
    const approval = approvePendingNavigationCommit({
      activeNavigationId: 1,
      currentState,
      pending,
      routeManifest: null,
      startedNavigationId: 1,
      targetHref: "https://example.com/dashboard/settings",
    });

    expect(approval.approvedCommit).not.toBeNull();
    if (approval.approvedCommit === null) return;
    expect(approval.decision.disposition).toBe("commit");
    if (approval.decision.disposition !== "commit") return;

    expect(approval.decision.preserveElementIds).toContain("layout:/dashboard");
    expect(approval.decision.preservePreviousSlotIds).toContain(modalSlotId);

    const nextState = applyApprovedVisibleCommit(currentState, approval.approvedCommit);
    expect(nextState.elements["layout:/dashboard"]).toBe(dashboardLayout);
    expect(nextState.elements[modalSlotId]).toBe(modalSlot);
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

  it("traverse: preserves bfcacheIds for planner-approved layout elements", async () => {
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/feed");
    const feedLayout = React.createElement("div", null, "feed layout");
    const modalSlotBinding = {
      ownerLayoutId: "layout:/feed",
      slotId: modalSlotId,
      state: "active",
    } satisfies AppElementsSlotBinding;
    const state = createState({
      bfcacheIds: {
        "layout:/": "0",
        "layout:/feed": "_b_4_",
        [modalSlotId]: "_b_5_",
      },
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": feedLayout,
          [modalSlotId]: React.createElement("div", null, "modal"),
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
              slotId: modalSlotId,
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
    expect(approval.approvedCommit.action.bfcacheIds["layout:/feed"]).toBe("_b_4_");

    // createPendingNavigationCommit pre-populates common layout ids today.
    // Remove one to exercise reducer-level preservation for merged elements,
    // and add a stale slot id to verify the merged element set bounds the map.
    const reducerBfcacheIdProbe = {
      ...approval.approvedCommit.action.bfcacheIds,
      [modalSlotId]: "_b_5_",
    };
    delete reducerBfcacheIdProbe["layout:/feed"];
    const commitWithoutPreservedLayoutBfcacheId = {
      ...approval.approvedCommit,
      action: {
        ...approval.approvedCommit.action,
        bfcacheIds: reducerBfcacheIdProbe,
      },
    };
    expect(
      Object.hasOwn(commitWithoutPreservedLayoutBfcacheId.action.bfcacheIds, "layout:/feed"),
    ).toBe(false);
    expect(commitWithoutPreservedLayoutBfcacheId.action.bfcacheIds[modalSlotId]).toBe("_b_5_");

    const nextState = applyApprovedVisibleCommit(state, commitWithoutPreservedLayoutBfcacheId);
    expect(nextState.elements["layout:/feed"]).toBe(feedLayout);
    expect(nextState.bfcacheIds["layout:/"]).toBe("0");
    expect(nextState.bfcacheIds["layout:/feed"]).toBe("_b_4_");
    expect(Object.hasOwn(nextState.elements, modalSlotId)).toBe(false);
    expect(Object.hasOwn(nextState.bfcacheIds, modalSlotId)).toBe(false);
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

  it("preserves bfcache ids for planner-approved default parallel slots", async () => {
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/feed");
    const mountedSlot = React.createElement("div", null, "modal");
    const modalSlotBinding = {
      ownerLayoutId: "layout:/feed",
      slotId: modalSlotId,
      state: "active",
    } satisfies AppElementsSlotBinding;
    const state = createState({
      bfcacheIds: {
        "layout:/": "0",
        "layout:/feed": "_b_4_",
        [modalSlotId]: "_b_5_",
      },
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": React.createElement("div", null, "feed layout"),
          [modalSlotId]: mountedSlot,
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
          slotId: modalSlotId,
          state: "default",
        },
      ],
    });

    expect(nextState.elements[modalSlotId]).toBe(mountedSlot);
    expect(nextState.bfcacheIds[modalSlotId]).toBe("_b_5_");
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
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/feed");
    const state = createState({
      bfcacheIds: {
        "layout:/": "0",
        "layout:/feed": "_b_4_",
        [modalSlotId]: "_b_5_",
      },
      elements: createResolvedElements(
        "route:/feed",
        "/",
        null,
        {
          "layout:/": React.createElement("div", null, "root layout"),
          "layout:/feed": React.createElement("div", null, "feed layout"),
          [modalSlotId]: React.createElement("div", null, "modal"),
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
    expect(Object.hasOwn(nextState.bfcacheIds, modalSlotId)).toBe(false);
  });
});

describe("app browser entry bfcacheId helpers", () => {
  const rootLayoutId = AppElementsWire.encodeLayoutId("/");
  const groupLayoutId = AppElementsWire.encodeLayoutId("/[group]");
  const nestedGroupLayoutId = AppElementsWire.encodeLayoutId(
    "/nextjs-compat/use-router-bfcache-id/[group]",
  );
  const catchAllLayoutId = AppElementsWire.encodeLayoutId("/docs/[...slug]");
  const optionalCatchAllTemplateId = AppElementsWire.encodeTemplateId("/docs/[[...slug]]");
  const pageX1Id = AppElementsWire.encodePageId("/x/1", null);
  const pageX2Id = AppElementsWire.encodePageId("/x/2", null);
  const pageY1Id = AppElementsWire.encodePageId("/y/1", null);
  const docsCatchAllPageId = AppElementsWire.encodePageId("/docs/[...slug]", null);
  const docsOptionalCatchAllPageId = AppElementsWire.encodePageId("/docs/[[...slug]]", null);

  function createBfcacheElements(pageId: string): AppElements {
    return createResolvedElements(
      `route:${pageId.slice("page:".length)}`,
      "/",
      null,
      {
        [rootLayoutId]: React.createElement("div", null),
        [groupLayoutId]: React.createElement("div", null),
        [pageId]: React.createElement("main", null),
      },
      [rootLayoutId, groupLayoutId],
    );
  }

  it("initializes every visible segment with the hydration placeholder", () => {
    expect(createInitialBfcacheIdMap(createBfcacheElements(pageX1Id))).toEqual({
      [rootLayoutId]: "0",
      [groupLayoutId]: "0",
      [pageX1Id]: "0",
    });
  });

  it("builds initial bfcache maps from shared App Elements metadata", () => {
    const elements = createBfcacheElements(pageX1Id);
    const metadata = AppElementsWire.readMetadata(elements);
    const maps = createInitialBfcacheMaps({
      elements,
      metadata,
      pathname: "/x/1",
    });

    expect(maps.bfcacheIds).toEqual(createInitialBfcacheIdMap(elements));
    expect(maps.stateKeys).toEqual(
      createBfcacheSegmentStateKeyMap({
        elements,
        pathname: "/x/1",
      }),
    );
  });

  it("writes only history-readable bfcache segment ids", () => {
    const routeId = AppElementsWire.encodeRouteId("/x/1", null);
    const elements = createResolvedElements(routeId, "/", null, {
      [routeId]: React.createElement("main", null),
      [rootLayoutId]: React.createElement("div", null),
      [pageX1Id]: React.createElement("main", null),
    });
    const metadata = AppElementsWire.readMetadata(elements);
    const maps = createInitialBfcacheMaps({
      elements,
      metadata,
      pathname: "/x/1",
    });
    const state = createHistoryStateWithNavigationMetadata(null, {
      bfcacheIds: maps.bfcacheIds,
      bfcacheVersion: 1,
      previousNextUrl: null,
    });

    expect(maps.bfcacheIds).toEqual({
      [rootLayoutId]: "0",
      [pageX1Id]: "0",
    });
    expect(readHistoryStateBfcacheIds(state)).toEqual(maps.bfcacheIds);
  });

  it("derives page segment state keys from pathname, not history bfcache ids", () => {
    const dynamicPageId = AppElementsWire.encodePageId("/page/[n]", null);
    const pageOneKeys = createBfcacheSegmentStateKeyMap({
      elements: createBfcacheElements(dynamicPageId),
      pathname: "/page/1",
    });
    const pageTwoKeys = createBfcacheSegmentStateKeyMap({
      elements: createBfcacheElements(dynamicPageId),
      pathname: "/page/2",
    });

    expect(pageOneKeys[dynamicPageId]).toBe(`${dynamicPageId}@/page/1`);
    expect(pageTwoKeys[dynamicPageId]).toBe(`${dynamicPageId}@/page/2`);
    expect(pageOneKeys[dynamicPageId]).not.toBe(pageTwoKeys[dynamicPageId]);
  });

  it("preserves encoded path delimiters when deriving segment state keys", () => {
    const pageId = AppElementsWire.encodePageId("/files/[...slug]", null);
    const encodedKeys = createBfcacheSegmentStateKeyMap({
      elements: createBfcacheElements(pageId),
      pathname: "/files/a%2Fb",
    });
    const nestedKeys = createBfcacheSegmentStateKeyMap({
      elements: createBfcacheElements(pageId),
      pathname: "/files/a/b",
    });

    expect(encodedKeys[pageId]).toBe(`${pageId}@/files/a%2Fb`);
    expect(nestedKeys[pageId]).toBe(`${pageId}@/files/a/b`);
    expect(encodedKeys[pageId]).not.toBe(nestedKeys[pageId]);
  });

  it("uses route-safe pathname normalization when preserving bfcache ids", () => {
    const pageId = AppElementsWire.encodePageId("/files/[...slug]", null);
    const current = {
      [rootLayoutId]: "0",
      [groupLayoutId]: "_b_4_",
      [pageId]: "_b_5_",
    };

    const equivalentEncoding = createNextBfcacheIdMap({
      current,
      currentElements: createBfcacheElements(pageId),
      currentPathname: "/files/%61",
      elements: createBfcacheElements(pageId),
      nextPathname: "/files/a",
    });
    const encodedDelimiter = createNextBfcacheIdMap({
      current,
      currentElements: createBfcacheElements(pageId),
      currentPathname: "/files/a%2Fb",
      elements: createBfcacheElements(pageId),
      nextPathname: "/files/a/b",
    });

    expect(equivalentEncoding[pageId]).toBe("_b_5_");
    expect(encodedDelimiter[pageId]).not.toBe("_b_5_");
  });

  it("falls back to raw pathname for malformed encoded state-key paths", () => {
    const dynamicPageId = AppElementsWire.encodePageId("/page/[n]", null);
    const keys = createBfcacheSegmentStateKeyMap({
      elements: createBfcacheElements(dynamicPageId),
      pathname: "/page/%",
    });

    expect(keys[dynamicPageId]).toBe(`${dynamicPageId}@/page/%`);
  });

  it("does not seed hydration bfcache ids from previously minted ids", () => {
    // Next generates the public "_b_0_" hydration sentinel from an internal
    // zero cache node on both SSR and initial client hydration. Minted ids
    // (and persisted history maps) are restored only for explicit back/forward
    // traversals, never folded into the initial map.
    //
    // Mint real "_b_N_" ids for these segments first, then prove that building
    // the initial map for the same elements ignores them and resets every
    // segment to the raw "0" hydration sentinel. This would fail if
    // createInitialBfcacheIdMap ever started seeding from prior/minted state.
    const minted = createNextBfcacheIdMap({
      current: {
        [rootLayoutId]: "0",
        [groupLayoutId]: "_b_4_",
        [pageX2Id]: "_b_5_",
      },
      currentElements: createBfcacheElements(pageX2Id),
      currentPathname: "/x/2",
      elements: createBfcacheElements(pageX1Id),
      nextPathname: "/x/1",
    });
    expect(minted[pageX1Id]).toMatch(/^_b_\d+_$/);

    const initial = createInitialBfcacheIdMap(createBfcacheElements(pageX1Id));
    expect(initial).toEqual({
      [rootLayoutId]: "0",
      [groupLayoutId]: "0",
      [pageX1Id]: "0",
    });
    // No segment carries a minted "_b_N_" id into the initial map.
    expect(Object.values(initial).every((value) => value === "0")).toBe(true);
  });

  it("preserves shared segment ids and mints ids for fresh segments", () => {
    const current = {
      [rootLayoutId]: "0",
      [groupLayoutId]: "_b_4_",
      [pageX1Id]: "_b_5_",
    };

    const next = createNextBfcacheIdMap({
      current,
      currentElements: createBfcacheElements(pageX1Id),
      currentPathname: "/x/1",
      elements: createBfcacheElements(pageX2Id),
      nextPathname: "/x/2",
    });

    expect(next[rootLayoutId]).toBe("0");
    expect(next[groupLayoutId]).toBe("_b_4_");
    expect(next[pageX1Id]).toBeUndefined();
    expect(next[pageX2Id]).toMatch(/^_b_\d+_$/);
    expect(next[pageX2Id]).not.toBe("_b_5_");
  });

  it("mints a fresh layout id when a dynamic layout segment changes", () => {
    const current = {
      [rootLayoutId]: "0",
      [groupLayoutId]: "_b_4_",
      [pageX1Id]: "_b_5_",
    };

    const next = createNextBfcacheIdMap({
      current,
      currentElements: createBfcacheElements(pageX1Id),
      currentPathname: "/x/1",
      elements: createBfcacheElements(pageY1Id),
      nextPathname: "/y/1",
    });

    expect(next[rootLayoutId]).toBe("0");
    expect(next[groupLayoutId]).toMatch(/^_b_\d+_$/);
    expect(next[groupLayoutId]).not.toBe("_b_4_");
  });

  it("mints a fresh nested layout id when a dynamic layout segment changes", () => {
    const current = {
      [rootLayoutId]: "0",
      [nestedGroupLayoutId]: "0",
      [pageX1Id]: "0",
    };

    const next = createNextBfcacheIdMap({
      current,
      currentElements: createResolvedElements(
        "route:/nextjs-compat/use-router-bfcache-id/x/1",
        "/",
        null,
        {
          [pageX1Id]: React.createElement("main", null),
        },
        [rootLayoutId, nestedGroupLayoutId],
      ),
      currentPathname: "/nextjs-compat/use-router-bfcache-id/x/1",
      elements: createResolvedElements(
        "route:/nextjs-compat/use-router-bfcache-id/y/1",
        "/",
        null,
        {
          [pageY1Id]: React.createElement("main", null),
        },
        [rootLayoutId, nestedGroupLayoutId],
      ),
      nextPathname: "/nextjs-compat/use-router-bfcache-id/y/1",
    });

    expect(next[nestedGroupLayoutId]).toMatch(/^_b_\d+_$/);
    expect(next[nestedGroupLayoutId]).not.toBe("0");
  });

  it("preserves a parallel-slot layout id when its visible URL prefix is unchanged", () => {
    // Regression: a layout nested under a parallel slot has a tree path that
    // contains an invisible "@slot" segment before its visible URL segments
    // (e.g. app/feed/@modal/photos/layout.tsx -> "/feed/@modal/photos", which
    // maps to the URL prefix "/feed/photos"). Deriving the identity prefix must
    // skip the "@modal" segment; otherwise it over-counts consumed pathname
    // segments and re-mints the layout id on every navigation that keeps the
    // layout mounted (a divergence from Next.js bfcacheId semantics).
    const modalPhotosLayoutId = AppElementsWire.encodeLayoutId("/feed/@modal/photos");
    const photo1Id = AppElementsWire.encodePageId("/feed/photos/1", null);
    const photo2Id = AppElementsWire.encodePageId("/feed/photos/2", null);

    const next = createNextBfcacheIdMap({
      current: {
        [rootLayoutId]: "0",
        [modalPhotosLayoutId]: "_b_4_",
        [photo1Id]: "_b_5_",
      },
      currentElements: createResolvedElements(
        "route:/feed/@modal/photos/[id]",
        "/",
        null,
        {
          [modalPhotosLayoutId]: React.createElement("div", null),
          [photo1Id]: React.createElement("main", null),
        },
        [rootLayoutId, modalPhotosLayoutId],
      ),
      currentPathname: "/feed/photos/1",
      elements: createResolvedElements(
        "route:/feed/@modal/photos/[id]",
        "/",
        null,
        {
          [modalPhotosLayoutId]: React.createElement("div", null),
          [photo2Id]: React.createElement("main", null),
        },
        [rootLayoutId, modalPhotosLayoutId],
      ),
      nextPathname: "/feed/photos/2",
    });

    // The layout persists across the navigation, so its id must be preserved.
    expect(next[modalPhotosLayoutId]).toBe("_b_4_");
    // The leaf page changes, so it mints a fresh id (sanity check).
    expect(next[photo2Id]).toMatch(/^_b_\d+_$/);
    expect(next[photo2Id]).not.toBe("_b_5_");
  });

  it("mints a fresh layout id when a catch-all segment value changes", () => {
    const current = {
      [rootLayoutId]: "0",
      [catchAllLayoutId]: "_b_4_",
      [docsCatchAllPageId]: "_b_5_",
    };

    const next = createNextBfcacheIdMap({
      current,
      currentElements: createResolvedElements(
        "route:/docs/[...slug]",
        "/",
        null,
        {
          [catchAllLayoutId]: React.createElement("div", null),
          [docsCatchAllPageId]: React.createElement("main", null),
        },
        [rootLayoutId, catchAllLayoutId],
      ),
      currentPathname: "/docs/a/b",
      elements: createResolvedElements(
        "route:/docs/[...slug]",
        "/",
        null,
        {
          [catchAllLayoutId]: React.createElement("div", null),
          [docsCatchAllPageId]: React.createElement("main", null),
        },
        [rootLayoutId, catchAllLayoutId],
      ),
      nextPathname: "/docs/a/c",
    });

    expect(next[rootLayoutId]).toBe("0");
    expect(next[catchAllLayoutId]).toMatch(/^_b_\d+_$/);
    expect(next[catchAllLayoutId]).not.toBe("_b_4_");
  });

  it("mints a fresh template id when an optional catch-all segment value changes", () => {
    const current = {
      [rootLayoutId]: "0",
      [optionalCatchAllTemplateId]: "_b_8_",
      [docsOptionalCatchAllPageId]: "_b_9_",
    };

    const next = createNextBfcacheIdMap({
      current,
      currentElements: createResolvedElements(
        "route:/docs/[[...slug]]",
        "/",
        null,
        {
          [optionalCatchAllTemplateId]: React.createElement("div", null),
          [docsOptionalCatchAllPageId]: React.createElement("main", null),
        },
        [rootLayoutId],
      ),
      currentPathname: "/docs/a/b",
      elements: createResolvedElements(
        "route:/docs/[[...slug]]",
        "/",
        null,
        {
          [optionalCatchAllTemplateId]: React.createElement("div", null),
          [docsOptionalCatchAllPageId]: React.createElement("main", null),
        },
        [rootLayoutId],
      ),
      nextPathname: "/docs/a/c",
    });

    expect(next[rootLayoutId]).toBe("0");
    expect(next[optionalCatchAllTemplateId]).toMatch(/^_b_\d+_$/);
    expect(next[optionalCatchAllTemplateId]).not.toBe("_b_8_");
  });

  it("mints a fresh intercepted slot id when the active slot target changes", () => {
    const feedLayoutId = AppElementsWire.encodeLayoutId("/feed");
    const modalSlotId = AppElementsWire.encodeSlotId("modal", "/feed");
    const modalSlotBinding = {
      ownerLayoutId: feedLayoutId,
      slotId: modalSlotId,
      state: "active",
    } satisfies AppElementsSlotBinding;
    const currentElements = createResolvedElements(
      "route:/photos/42",
      "/",
      "/feed",
      {
        [rootLayoutId]: React.createElement("div", null),
        [feedLayoutId]: React.createElement("div", null),
        [modalSlotId]: React.createElement("aside", null),
      },
      [rootLayoutId, feedLayoutId],
      [modalSlotBinding],
      createInterceptionProof("/feed", "/photos/42", modalSlotId),
    );
    const nextElements = createResolvedElements(
      "route:/photos/43",
      "/",
      "/feed",
      {
        [rootLayoutId]: React.createElement("div", null),
        [feedLayoutId]: React.createElement("div", null),
        [modalSlotId]: React.createElement("aside", null),
      },
      [rootLayoutId, feedLayoutId],
      [modalSlotBinding],
      createInterceptionProof("/feed", "/photos/43", modalSlotId),
    );

    const next = createNextBfcacheIdMap({
      current: {
        [rootLayoutId]: "0",
        [feedLayoutId]: "_b_4_",
        [modalSlotId]: "_b_5_",
      },
      currentElements,
      currentPathname: "/photos/42",
      elements: nextElements,
      nextPathname: "/photos/43",
    });

    expect(next[rootLayoutId]).toBe("0");
    expect(next[feedLayoutId]).toBe("_b_4_");
    expect(next[modalSlotId]).toMatch(/^_b_\d+_$/);
    expect(next[modalSlotId]).not.toBe("_b_5_");
  });

  it("serializes and restores bfcache ids through history state", () => {
    const state = createHistoryStateWithNavigationMetadata(
      { __vinext_scrollY: 120 },
      {
        bfcacheIds: { [pageX1Id]: "_b_9_" },
        bfcacheVersion: 3,
        previousNextUrl: "/feed",
      },
    );

    expect(state).toEqual({
      __vinext_bfcacheIds: { [pageX1Id]: "_b_9_" },
      __vinext_bfcacheVersion: 3,
      __vinext_previousNextUrl: "/feed",
      __vinext_scrollY: 120,
    });
    expect(readHistoryStateBfcacheIds(state)).toEqual({ [pageX1Id]: "_b_9_" });
    expect(readHistoryStateBfcacheVersion(state)).toBe(3);
  });

  it("drops bfcache version metadata when bfcache ids are cleared", () => {
    const state = createHistoryStateWithNavigationMetadata(
      {
        __vinext_bfcacheIds: { [pageX1Id]: "_b_9_" },
        __vinext_bfcacheVersion: 3,
        custom: "preserve",
      },
      {
        bfcacheIds: {},
        bfcacheVersion: 4,
        previousNextUrl: "/feed",
      },
    );

    expect(state).toEqual({
      __vinext_previousNextUrl: "/feed",
      custom: "preserve",
    });
    expect(readHistoryStateBfcacheIds(state)).toBeNull();
    expect(readHistoryStateBfcacheVersion(state)).toBeNull();
  });

  it("treats a matching stored bfcache version as current", () => {
    const state = createHistoryStateWithNavigationMetadata(null, {
      bfcacheIds: { [pageX1Id]: "_b_9_" },
      bfcacheVersion: 3,
      previousNextUrl: null,
    });

    expect(isHistoryStateBfcacheVersionCurrent(state, 3)).toBe(true);
    expect(isHistoryStateBfcacheVersionCurrent(state, 4)).toBe(false);
  });

  it("rejects a missing bfcache version even when the current version is 0", () => {
    // Regression guard: a history entry carrying bfcache ids but no version key
    // (older build / external pushState) must NOT pass the document-scoped gate
    // on a fresh document whose current version is 0. Coercing the missing
    // version to 0 would let stale ids be restored across documents.
    const unversioned = { __vinext_bfcacheIds: { [pageX1Id]: "_b_9_" } };

    expect(readHistoryStateBfcacheVersion(unversioned)).toBeNull();
    expect(isHistoryStateBfcacheVersionCurrent(unversioned, 0)).toBe(false);
    expect(isHistoryStateBfcacheVersionCurrent(null, 0)).toBe(false);
  });

  it("restores matching history snapshots and evicts the oldest entry", () => {
    const cache = new HistoryStateSnapshotCache<string>({ maxEntries: 2 });
    const entry1 = createHistoryStateWithNavigationMetadata(null, {
      previousNextUrl: null,
      traversalIndex: 1,
    });
    const entry2 = createHistoryStateWithNavigationMetadata(null, {
      previousNextUrl: null,
      traversalIndex: 2,
    });
    const entry3 = createHistoryStateWithNavigationMetadata(null, {
      previousNextUrl: null,
      traversalIndex: 3,
    });

    cache.remember({ bfcacheVersion: 7, historyIndex: 1, state: "one" });
    cache.remember({ bfcacheVersion: 7, historyIndex: 2, state: "two" });
    cache.remember({ bfcacheVersion: 7, historyIndex: 3, state: "three" });

    expect(
      cache.resolveRestore({
        currentBfcacheVersion: 7,
        guarded: false,
        historyState: entry1,
      }),
    ).toEqual({
      kind: "skip",
      reason: "missing-snapshot",
      targetHistoryIndex: 1,
    });
    expect(
      cache.resolveRestore({
        currentBfcacheVersion: 7,
        guarded: false,
        historyState: entry2,
      }),
    ).toEqual({
      kind: "restore",
      state: "two",
      targetHistoryIndex: 2,
    });
    expect(
      cache.resolveRestore({
        currentBfcacheVersion: 7,
        guarded: false,
        historyState: entry3,
      }),
    ).toEqual({
      kind: "restore",
      state: "three",
      targetHistoryIndex: 3,
    });
  });

  it("suppresses history snapshot restore while cache invalidation is guarded", () => {
    const cache = new HistoryStateSnapshotCache<string>({ maxEntries: 2 });
    const entry = createHistoryStateWithNavigationMetadata(null, {
      previousNextUrl: null,
      traversalIndex: 2,
    });

    cache.remember({ bfcacheVersion: 7, historyIndex: 2, state: "two" });

    expect(
      cache.resolveRestore({
        currentBfcacheVersion: 7,
        guarded: true,
        historyState: entry,
      }),
    ).toEqual({
      kind: "skip",
      reason: "guarded",
      targetHistoryIndex: 2,
    });
    expect(
      cache.resolveRestore({
        currentBfcacheVersion: 7,
        guarded: false,
        historyState: entry,
      }),
    ).toEqual({
      kind: "restore",
      state: "two",
      targetHistoryIndex: 2,
    });
  });

  it("deletes stale history snapshots when the bfcache epoch changes", () => {
    const cache = new HistoryStateSnapshotCache<string>({ maxEntries: 2 });
    const entry = createHistoryStateWithNavigationMetadata(null, {
      previousNextUrl: null,
      traversalIndex: 2,
    });

    cache.remember({ bfcacheVersion: 7, historyIndex: 2, state: "two" });

    expect(
      cache.resolveRestore({
        currentBfcacheVersion: 8,
        guarded: false,
        historyState: entry,
      }),
    ).toEqual({
      kind: "skip",
      reason: "stale-bfcache-version",
      targetHistoryIndex: 2,
    });
    expect(
      cache.resolveRestore({
        currentBfcacheVersion: 7,
        guarded: false,
        historyState: entry,
      }),
    ).toEqual({
      kind: "skip",
      reason: "missing-snapshot",
      targetHistoryIndex: 2,
    });
  });

  it("initializes restorable client state with a fresh document bfcache epoch", () => {
    const initialState = createHistoryStateWithNavigationMetadata(null, {
      bfcacheIds: { [pageX1Id]: "_b_9_" },
      bfcacheVersion: 3,
      previousNextUrl: null,
    });
    const controller = new RestorableClientStateController<string>({
      initialHistoryState: initialState,
      maxHistoryStateSnapshots: 2,
    });

    expect(controller.currentBfcacheVersion).toBe(4);
    expect(controller.readCurrentBfcacheVersionHistoryIds(initialState)).toBeNull();

    const currentState = createHistoryStateWithNavigationMetadata(null, {
      bfcacheIds: { [pageX1Id]: "_b_10_" },
      bfcacheVersion: controller.currentBfcacheVersion,
      previousNextUrl: null,
    });
    expect(controller.readCurrentBfcacheVersionHistoryIds(currentState)).toEqual({
      [pageX1Id]: "_b_10_",
    });
  });

  it("keeps bfcache ids and history snapshots behind the same restorable client state guard", () => {
    const controller = new RestorableClientStateController<string>({
      initialHistoryState: null,
      maxHistoryStateSnapshots: 2,
    });
    const entry = createHistoryStateWithNavigationMetadata(null, {
      bfcacheIds: { [pageX1Id]: "_b_9_" },
      bfcacheVersion: controller.currentBfcacheVersion,
      previousNextUrl: null,
      traversalIndex: 2,
    });

    controller.rememberHistoryStateSnapshot({ historyIndex: 2, state: "two" });
    const release = controller.beginCacheInvalidationGuard();

    expect(controller.readCurrentBfcacheVersionHistoryIds(entry)).toBeNull();
    expect(controller.resolveHistoryStateSnapshotRestore(entry)).toEqual({
      kind: "skip",
      reason: "guarded",
      targetHistoryIndex: 2,
    });

    release();

    expect(controller.readCurrentBfcacheVersionHistoryIds(entry)).toEqual({
      [pageX1Id]: "_b_9_",
    });
    expect(controller.resolveHistoryStateSnapshotRestore(entry)).toEqual({
      kind: "restore",
      state: "two",
      targetHistoryIndex: 2,
    });
  });

  it("keeps restorable client state guarded until nested guards are released", () => {
    const controller = new RestorableClientStateController<string>({
      initialHistoryState: null,
      maxHistoryStateSnapshots: 2,
    });
    const entry = createHistoryStateWithNavigationMetadata(null, {
      bfcacheIds: { [pageX1Id]: "_b_9_" },
      bfcacheVersion: controller.currentBfcacheVersion,
      previousNextUrl: null,
      traversalIndex: 2,
    });

    controller.rememberHistoryStateSnapshot({ historyIndex: 2, state: "two" });
    const releaseOuter = controller.beginCacheInvalidationGuard();
    const releaseInner = controller.beginCacheInvalidationGuard();

    releaseOuter();
    releaseOuter();

    expect(controller.readCurrentBfcacheVersionHistoryIds(entry)).toBeNull();
    expect(controller.resolveHistoryStateSnapshotRestore(entry)).toEqual({
      kind: "skip",
      reason: "guarded",
      targetHistoryIndex: 2,
    });

    releaseInner();
    releaseInner();

    expect(controller.readCurrentBfcacheVersionHistoryIds(entry)).toEqual({
      [pageX1Id]: "_b_9_",
    });
    expect(controller.resolveHistoryStateSnapshotRestore(entry)).toEqual({
      kind: "restore",
      state: "two",
      targetHistoryIndex: 2,
    });
  });

  it("invalidates bfcache ids and history snapshots through one restorable client state epoch", () => {
    const controller = new RestorableClientStateController<string>({
      initialHistoryState: null,
      maxHistoryStateSnapshots: 2,
    });
    const entry = createHistoryStateWithNavigationMetadata(null, {
      bfcacheIds: { [pageX1Id]: "_b_9_" },
      bfcacheVersion: controller.currentBfcacheVersion,
      previousNextUrl: null,
      traversalIndex: 2,
    });

    controller.rememberHistoryStateSnapshot({ historyIndex: 2, state: "two" });
    controller.invalidateClientState();

    expect(controller.readCurrentBfcacheVersionHistoryIds(entry)).toBeNull();
    expect(controller.resolveHistoryStateSnapshotRestore(entry)).toEqual({
      kind: "skip",
      reason: "missing-snapshot",
      targetHistoryIndex: 2,
    });
  });

  it("uses restored history bfcache ids for traversal commits", async () => {
    const currentState = createState({
      bfcacheIds: {
        [rootLayoutId]: "0",
        [groupLayoutId]: "_b_4_",
        [pageX2Id]: "_b_8_",
      },
      elements: createBfcacheElements(pageX2Id),
      layoutIds: [rootLayoutId, groupLayoutId],
      routeId: "route:/x/2",
    });

    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(createBfcacheElements(pageX1Id)),
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/x/1", {}),
      operationLane: "traverse",
      renderId: 1,
      restoredBfcacheIds: {
        [rootLayoutId]: "0",
        [groupLayoutId]: "_b_4_",
        [pageX1Id]: "_b_5_",
      },
      type: "traverse",
    });

    expect(pending.action.bfcacheIds[pageX1Id]).toBe("_b_5_");
  });

  it("mints redirected traverse target ids after restored ids are cleared", async () => {
    const currentState = createState({
      bfcacheIds: {
        [rootLayoutId]: "0",
        [groupLayoutId]: "0",
        [pageX1Id]: "_b_4_",
      },
      elements: createBfcacheElements(pageX1Id),
      layoutIds: [rootLayoutId, groupLayoutId],
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/x/1", {}),
      routeId: "route:/x/1",
    });

    const pending = await createPendingNavigationCommit({
      payloadOrigin: FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
      currentState,
      nextElements: Promise.resolve(createBfcacheElements(pageY1Id)),
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/y/1", {}),
      operationLane: "navigation",
      renderId: 1,
      // navigateRsc clears the source entry's restored ids before committing a
      // redirected traverse target, otherwise restored ids would win over fresh
      // ids for changed dynamic segments.
      restoredBfcacheIds: null,
      type: "traverse",
    });

    expect(pending.action.bfcacheIds[rootLayoutId]).toBe("0");
    expect(pending.action.bfcacheIds[groupLayoutId]).toMatch(/^_b_\d+_$/);
    expect(pending.action.bfcacheIds[groupLayoutId]).not.toBe("0");
  });

  it("keeps future minted bfcache ids ahead of restored history state ids", () => {
    const next = createNextBfcacheIdMap({
      current: createInitialBfcacheIdMap(createBfcacheElements(pageX1Id)),
      currentElements: createBfcacheElements(pageX1Id),
      currentPathname: "/x/1",
      elements: createBfcacheElements(pageX2Id),
      nextPathname: "/x/2",
      restored: {
        [pageX1Id]: "_b_900000_",
      },
    });

    const freshIdNumber = Number(/^_b_(\d+)_$/.exec(next[pageX2Id] ?? "")?.[1]);
    expect(freshIdNumber).toBeGreaterThan(900000);
  });
});

describe("createPopstateRestoreHandler", () => {
  it("guards synchronous popstate scroll retry to the active navigation", () => {
    const scrollState = { __vinext_scrollY: 10 };
    let activeNavigationId = 3;
    let consumedNavigationId: number | null = null;
    let shouldContinue: (() => boolean) | undefined;

    restoreSynchronousPopstateScrollPosition(
      {
        getActiveNavigationId: () => activeNavigationId,
        isCurrentNavigation: (navId) => navId === activeNavigationId,
        markScrollRestoreConsumed: (navId) => {
          consumedNavigationId = navId;
        },
        restorePopstateScrollPosition: (state, options) => {
          expect(state).toBe(scrollState);
          shouldContinue = options?.shouldContinue;
        },
      },
      scrollState,
    );

    expect(consumedNavigationId).toBe(3);
    expect(shouldContinue?.()).toBe(true);

    activeNavigationId = 4;
    expect(shouldContinue?.()).toBe(false);
  });

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
      shouldSkipScrollRestore: () => false,
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
      shouldSkipScrollRestore: () => false,
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

  it("does not reapply delayed scroll after synchronous popstate restore consumed it", async () => {
    const restoreCalls: unknown[] = [];
    const navigation = createDeferred();
    let activeNavigationId = 0;
    let synchronouslyRestoredNavigationId: number | null = null;

    stubWindow("https://example.com/feed");
    window.__VINEXT_RSC_PENDING__ = null;

    const handler = createPopstateRestoreHandler({
      getActiveNavigationId: () => activeNavigationId,
      getNavigate: () => {
        activeNavigationId += 1;
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
      shouldSkipScrollRestore: (navId) => synchronouslyRestoredNavigationId === navId,
    });

    handler({ state: { __vinext_scrollY: 10 } } as PopStateEvent);
    synchronouslyRestoredNavigationId = activeNavigationId;
    restoreCalls.push({ __vinext_scrollY: 10, source: "sync" });

    await Promise.resolve();
    navigation.resolve();
    await navigation.promise;
    await Promise.resolve();

    expect(restoreCalls).toEqual([{ __vinext_scrollY: 10, source: "sync" }]);
    expect(window.__VINEXT_RSC_PENDING__).toBeNull();
  });
});

describe("app browser RSC redirect lifecycle", () => {
  it("blocks dangerous streamed redirects before browser navigation", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      blockDangerousStreamedRscRedirect(
        response,
        "javascript:window.location.assign('/nextjs-compat/javascript-urls/boom')",
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(consoleError).toHaveBeenCalledWith(
      "Next.js has blocked a javascript: URL as a security precaution.",
    );
  });

  it("allows safe streamed redirects to reach the navigation planner", () => {
    const response = new Response("rsc payload");

    expect(blockDangerousStreamedRscRedirect(response, "/dashboard")).toBe(false);
    expect(response.bodyUsed).toBe(false);
  });

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

  it("preserves streamed redirect target hashes", () => {
    const decision = resolveStreamedRscRedirectLifecycleHop({
      currentHref: "/old#old",
      historyUpdateMode: "replace",
      origin: "https://example.com",
      redirectDepth: 0,
      requestPreviousNextUrl: null,
      streamedRedirectTarget: "/new#new",
    });

    expect(decision).toEqual({
      href: "/new#new",
      historyUpdateMode: "replace",
      kind: "follow",
      previousNextUrl: null,
      redirectDepth: 1,
    });
  });

  it("treats streamed hash-only same-path changes as redirects", () => {
    const decision = resolveStreamedRscRedirectLifecycleHop({
      currentHref: "/same#old",
      historyUpdateMode: "push",
      origin: "https://example.com",
      redirectDepth: 0,
      requestPreviousNextUrl: "/feed",
      streamedRedirectTarget: "/same#new",
    });

    expect(decision).toEqual({
      href: "/same#new",
      historyUpdateMode: "push",
      kind: "follow",
      previousNextUrl: "/feed",
      redirectDepth: 1,
    });
  });

  it("preserves streamed redirect visible query params and hash", () => {
    const decision = resolveStreamedRscRedirectLifecycleHop({
      currentHref: "/source",
      historyUpdateMode: "replace",
      origin: "https://example.com",
      redirectDepth: 1,
      requestPreviousNextUrl: null,
      streamedRedirectTarget: "/target.rsc?visible=1&_rsc=abc#details",
    });

    expect(decision).toEqual({
      href: "/target.rsc?visible=1&_rsc=abc#details",
      historyUpdateMode: "replace",
      kind: "follow",
      previousNextUrl: null,
      redirectDepth: 2,
    });
  });

  it("turns same-target streamed redirects into no-redirect decisions", () => {
    const decision = resolveStreamedRscRedirectLifecycleHop({
      currentHref: "/same?tab=1#section",
      historyUpdateMode: "replace",
      origin: "https://example.com",
      redirectDepth: 0,
      requestPreviousNextUrl: null,
      streamedRedirectTarget: "/same?tab=1#section",
    });

    expect(decision).toEqual({ href: "/same?tab=1#section", kind: "no-redirect" });
  });

  it("turns external streamed redirects into terminal hard navigations", () => {
    const decision = resolveStreamedRscRedirectLifecycleHop({
      currentHref: "/account",
      historyUpdateMode: "replace",
      origin: "https://example.com",
      redirectDepth: 0,
      requestPreviousNextUrl: null,
      streamedRedirectTarget: "https://idp.example/login#step",
    });

    expect(decision).toEqual({
      href: "https://idp.example/login#step",
      kind: "terminal-hard-navigation",
      reason: "externalRedirect",
      redirectDepth: 0,
    });
  });

  it("turns over-budget streamed redirects into terminal hard navigations", () => {
    const decision = resolveStreamedRscRedirectLifecycleHop({
      currentHref: "/a",
      historyUpdateMode: "replace",
      maxRedirectDepth: 2,
      origin: "https://example.com",
      redirectDepth: 2,
      requestPreviousNextUrl: null,
      streamedRedirectTarget: "/b#target",
    });

    expect(decision).toEqual({
      href: "/b#target",
      kind: "terminal-hard-navigation",
      reason: "maxRedirectsExceeded",
      redirectDepth: 2,
    });
  });
});

describe("devOnCaughtError (hydrateRoot dev handler)", () => {
  it("routes the framework dev recovery boundary through the uncaught handler", () => {
    const onCaughtError = vi.fn();
    const onImplicitRootError = vi.fn();
    const handler = createDevOnCaughtError(onCaughtError, onImplicitRootError);
    const error = new Error("navigation render failed");
    const errorInfo = {
      componentStack: "\n    at Lazy",
      errorBoundary: { props: { isImplicitRootErrorBoundary: true } },
    };

    handler(error, errorInfo);

    expect(onImplicitRootError).toHaveBeenCalledWith(error, errorInfo);
    expect(onCaughtError).not.toHaveBeenCalled();
  });

  it("keeps explicit dev error boundaries on the caught-error path", () => {
    const onCaughtError = vi.fn();
    const onImplicitRootError = vi.fn();
    const handler = createDevOnCaughtError(onCaughtError, onImplicitRootError);
    const error = new Error("route error");
    const errorInfo = {
      componentStack: "\n    at Page",
      errorBoundary: { props: { isImplicitRootErrorBoundary: false } },
    };

    handler(error, errorInfo);

    expect(onCaughtError).toHaveBeenCalledWith(error, errorInfo);
    expect(onImplicitRootError).not.toHaveBeenCalled();
  });

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

describe("dev overlay Shadow DOM mount", () => {
  class FakeShadowRoot {
    children: FakeElement[] = [];

    appendChild<T extends FakeElement>(node: T): T {
      this.children.push(node);
      return node;
    }

    getElementById(id: string): FakeElement | null {
      return this.children.find((child) => child.id === id) ?? null;
    }
  }

  class FakeElement {
    children: FakeElement[] = [];
    id = "";
    shadowRoot: FakeShadowRoot | null = null;
    style: Record<string, string> = {};
    attributes = new Map<string, string>();

    constructor(
      private readonly owner: FakeDocument | null,
      readonly tagName: string,
    ) {}

    appendChild<T extends FakeElement>(node: T): T {
      this.children.push(node);
      this.owner?.registerTree(node);
      return node;
    }

    attachShadow(init: { mode: "open" | "closed" }): FakeShadowRoot {
      expect(init.mode).toBe("open");
      this.shadowRoot = new FakeShadowRoot();
      return this.shadowRoot;
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
  }

  class FakeDocument {
    private readonly elementsById = new Map<string, FakeElement>();
    readonly body = new FakeElement(this, "body");
    readonly documentElement = new FakeElement(this, "html");

    createElement(tagName: string): FakeElement {
      return new FakeElement(this, tagName);
    }

    getElementById(id: string): FakeElement | null {
      return this.elementsById.get(id) ?? null;
    }

    registerTree(node: FakeElement): void {
      if (node.id) this.elementsById.set(node.id, node);
      for (const child of node.children) this.registerTree(child);
    }
  }

  it("mounts the React root inside an open shadow root", () => {
    const fakeDocument = new FakeDocument();

    const mount = createDevErrorOverlayMountNode(fakeDocument as unknown as Document);
    const host = fakeDocument.getElementById(DEV_ERROR_OVERLAY_HOST_ID);

    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();
    expect(mount.id).toBe(DEV_ERROR_OVERLAY_MOUNT_ID);
    expect(host?.shadowRoot?.getElementById(DEV_ERROR_OVERLAY_MOUNT_ID)).toBe(mount);
    expect(host?.children).toHaveLength(0);
  });

  it("keeps the shadow host out of normal page layout", () => {
    const fakeDocument = new FakeDocument();

    createDevErrorOverlayMountNode(fakeDocument as unknown as Document);
    const host = fakeDocument.getElementById(DEV_ERROR_OVERLAY_HOST_ID);

    expect(host?.style.position).toBe("absolute");
    expect(host?.style.width).toBe("0");
    expect(host?.style.height).toBe("0");
    expect(host?.style.overflow).toBe("visible");
    expect(host?.attributes.get("data-vinext-dev-error-overlay")).toBe("");
  });

  it("reuses the existing host and shadow mount across installs", () => {
    const fakeDocument = new FakeDocument();
    const firstMount = createDevErrorOverlayMountNode(fakeDocument as unknown as Document);
    const secondMount = createDevErrorOverlayMountNode(fakeDocument as unknown as Document);

    expect(secondMount).toBe(firstMount);
    expect(fakeDocument.body.children).toHaveLength(1);
    expect(fakeDocument.body.children[0]?.shadowRoot?.children).toHaveLength(1);
  });
});

describe("dev overlay open-in-editor helpers", () => {
  it("formats overlay display files relative to the project root", () => {
    expect(
      formatOverlayDisplayFile(
        "file:///Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx",
        "/Users/hyoban/f/vinext/apps/web",
      ),
    ).toBe("app/_components/site-footer.tsx");

    expect(
      formatOverlayDisplayFile(
        "/Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx",
        "/Users/hyoban/f/vinext/apps/web",
      ),
    ).toBe("app/_components/site-footer.tsx");

    expect(
      formatOverlayDisplayFile(
        "/Users/hyoban/f/vinext/packages/vinext/src/server/dev-error-overlay.tsx",
        "/Users/hyoban/f/vinext/apps/web",
      ),
    ).toBe("/Users/hyoban/f/vinext/packages/vinext/src/server/dev-error-overlay.tsx");

    expect(
      formatOverlayDisplayFile(
        "about://React/Server/file:///Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx?9",
        "/Users/hyoban/f/vinext/apps/web/",
      ),
    ).toBe("app/_components/site-footer.tsx");
  });

  it("formats stack frames as Vite open-in-editor file payloads", () => {
    expect(
      formatViteOpenInEditorFile({
        file: "/Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx",
        line: "9",
        col: "8",
      }),
    ).toBe("/Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx:9:8");

    expect(
      formatViteOpenInEditorFile({
        file: "/Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx",
        line: "9",
      }),
    ).toBe("/Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx:9");

    expect(formatViteOpenInEditorFile({ file: "virtual:vinext-app-browser-entry" })).toBe(
      "virtual:vinext-app-browser-entry",
    );
    expect(
      formatViteOpenInEditorFile({
        file: "about://React/Server/file:///Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx?9",
        line: "9",
        col: "8",
      }),
    ).toBe("/Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx:9:8");
    expect(formatViteOpenInEditorFile({})).toBeNull();
  });

  it("builds the Vite dev server open-in-editor URL", () => {
    expect(
      createViteOpenInEditorUrl(
        "/Users/hyoban/f/vinext/apps/web/app/_components/site footer.tsx:9:8",
        "http://localhost:3001/@id/__x00__virtual:vinext-app-browser-entry",
      ),
    ).toBe(
      "http://localhost:3001/__open-in-editor?file=%2FUsers%2Fhyoban%2Ff%2Fvinext%2Fapps%2Fweb%2Fapp%2F_components%2Fsite%20footer.tsx%3A9%3A8",
    );
  });

  it("formats copied error info with visible stack frames and code frames", () => {
    expect(
      formatErrorInfoForClipboard(
        {
          source: "server",
          message: "vinext is not ready yet. Stay tuned!",
          projectRoot: "/Users/hyoban/f/vinext/apps/web",
          codeFrame: {
            file: "file:///Users/hyoban/f/vinext/apps/web/app/_components/site-footer.tsx",
            line: 6,
            column: 9,
            methodName: "SiteFooter",
            lines: [
              { line: 4, text: "const unused = 1;", isErrorLine: false },
              { line: 5, text: "export function SiteFooter() {", isErrorLine: false },
              {
                line: 6,
                text: '  throw new Error("vinext is not ready yet. Stay tuned!");',
                isErrorLine: true,
              },
              { line: 7, text: "  return (", isErrorLine: false },
            ],
          },
        },
        [
          {
            fn: "SiteFooter",
            displayFile: "app/_components/site-footer.tsx",
            line: "6",
            col: "9",
            ignored: false,
          },
          {
            fn: "renderFunctionComponent",
            displayFile: "node_modules/.vite/deps_rsc/react-server-dom-webpack_server__edge.js",
            line: "956",
            col: "71",
            ignored: true,
          },
        ],
      ),
    ).toBe(
      [
        "## Error Type",
        "",
        "Server Error",
        "",
        "## Error Message",
        "",
        "vinext is not ready yet. Stay tuned!",
        "",
        "## Stack",
        "",
        "    at SiteFooter (app/_components/site-footer.tsx:6:9)",
        "",
        "## Code Frame",
        "",
        "app/_components/site-footer.tsx:6:9 @ SiteFooter",
        "    4 | const unused = 1;",
        "    5 | export function SiteFooter() {",
        '>   6 |   throw new Error("vinext is not ready yet. Stay tuned!");',
        "      |         ^",
        "    7 |   return (",
      ].join("\n"),
    );
  });

  it("formats copied build errors without Vite internal stack frames", () => {
    expect(
      formatErrorInfoForClipboard(
        {
          source: "vite",
          message:
            "[plugin:vite:oxc] Transform failed with 1 error:\n\n[PARSE_ERROR] Error: Unterminated string",
          codeFrame: {
            file: "app/_components/site-footer.tsx",
            line: 7,
            column: 90,
            lines: [
              {
                line: 7,
                text: '<div className="broken>',
                isErrorLine: true,
              },
            ],
          },
        },
        [
          {
            fn: "transformWithOxc",
            displayFile: "node_modules/@voidzero-dev/vite-plus-core/dist/vite/node.js",
            line: "5987",
            col: "19",
            ignored: false,
          },
        ],
      ),
    ).toBe(
      [
        "## Error Type",
        "",
        "Build Error",
        "",
        "## Error Message",
        "",
        "[plugin:vite:oxc] Transform failed with 1 error:",
        "",
        "[PARSE_ERROR] Error: Unterminated string",
      ].join("\n"),
    );
  });
});

describe("dev overlay Vite HMR errors", () => {
  it("normalizes Vite transform errors into build-error overlay data", () => {
    const normalized = normalizeViteHmrError({
      err: {
        message:
          "Transform failed with 1 error:\napp/_components/site-footer.tsx:7:90: ERROR: Unterminated string",
        plugin: "vite:esbuild",
        frame: [
          "  5 |    return (",
          '  6 |      <footer className="mt-auto border-t">',
          '> 7 |        <div className="mx-auto flex w-full max-w-6xl items-center justify-center px-6 py-6">',
          "    |                                                                                          ^",
          "  8 |          <Text>vinext</Text>",
        ].join("\n"),
      },
    });

    expect(normalized.message).toContain("[plugin:vite:esbuild] Transform failed with 1 error");
    expect(normalized.message).toContain(
      '> 7 |        <div className="mx-auto flex w-full max-w-6xl items-center justify-center px-6 py-6">',
    );
  });

  it("normalizes OXC build error frames from Vite+", () => {
    const message = [
      "Transform failed with 1 error:",
      "",
      "[PARSE_ERROR] Error: Unterminated string",
      "   ╭─[ app/dev-overlay-hmr-toggle/server-hmr-toggle.tsx:2:55 ]",
      "   │",
      ' 2 │ ╭─▶   return <p data-testid="server-hmr-toggle" className="broken>server hmr clean</p>;',
      " 3 │ ├─▶ }",
      "   │ │       ",
      "   │ ╰─────── ",
      "───╯",
    ].join("\n");

    const normalized = normalizeViteHmrError({
      err: {
        message,
      },
    });

    expect(normalized.message).toBe(message);
  });
});

describe("dev overlay React Refresh recovery", () => {
  it("dispatches recovery before React Refresh retries failed roots", async () => {
    const callbacks: Array<() => void | Promise<void>> = [];
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      __registerBeforePerformReactRefresh(cb: () => void | Promise<void>) {
        callbacks.push(cb);
      },
      dispatchEvent,
      setTimeout: vi.fn(),
    });

    installReactRefreshErrorRecovery();

    expect(callbacks).toHaveLength(1);
    await callbacks[0]?.();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(Event);
    expect((event as Event).type).toBe(VINEXT_DEV_ERROR_RECOVERY_EVENT);
  });

  it("does not register duplicate React Refresh recovery callbacks", () => {
    const callbacks: Array<() => void | Promise<void>> = [];
    vi.stubGlobal("window", {
      __registerBeforePerformReactRefresh(cb: () => void | Promise<void>) {
        callbacks.push(cb);
      },
      dispatchEvent: vi.fn(),
      setTimeout: vi.fn(),
    });

    installReactRefreshErrorRecovery();
    installReactRefreshErrorRecovery();

    expect(callbacks).toHaveLength(1);
  });

  it("retries until the React Refresh runtime hook is available", async () => {
    const callbacks: Array<() => void | Promise<void>> = [];
    const timeoutCallbacks: Array<() => void> = [];
    const dispatchEvent = vi.fn();
    const setTimeout = vi.fn((cb: () => void, _delay?: number) => {
      timeoutCallbacks.push(cb);
      return timeoutCallbacks.length;
    });
    const refreshWindow: {
      __registerBeforePerformReactRefresh?: (cb: () => void | Promise<void>) => void;
      dispatchEvent: typeof dispatchEvent;
      setTimeout: typeof setTimeout;
    } = {
      dispatchEvent,
      setTimeout,
    };
    vi.stubGlobal("window", refreshWindow);

    installReactRefreshErrorRecovery();
    expect(setTimeout).toHaveBeenCalledTimes(1);
    expect(setTimeout.mock.calls[0]?.[1]).toBe(0);

    await Promise.resolve();
    expect(setTimeout).toHaveBeenCalledTimes(1);

    timeoutCallbacks.shift()?.();
    expect(setTimeout).toHaveBeenCalledTimes(2);
    expect(setTimeout.mock.calls[1]?.[1]).toBe(16);

    refreshWindow.__registerBeforePerformReactRefresh = (cb) => {
      callbacks.push(cb);
    };
    timeoutCallbacks.shift()?.();

    expect(callbacks).toHaveLength(1);
    await callbacks[0]?.();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});

describe("dev overlay store", () => {
  it("does not notify subscribers when an empty overlay is dismissed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOverlay(listener);

    try {
      dismissOverlay();
      expect(listener).not.toHaveBeenCalled();

      reportToOverlay({
        source: "caught",
        message: "boom",
        stack: undefined,
        ignoredStackFrames: undefined,
        projectRoot: undefined,
        codeFrame: undefined,
        componentStack: undefined,
      });
      expect(listener).toHaveBeenCalledTimes(1);

      dismissOverlay();
      expect(listener).toHaveBeenCalledTimes(2);

      dismissOverlay();
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      dismissOverlay();
    }
  });
});

describe("createOnUncaughtError (hydrateRoot uncaught handler)", () => {
  function withFakeWindow<T>(
    fn: (spies: {
      assignSpy: ReturnType<typeof vi.fn>;
      reportErrorSpy: ReturnType<typeof vi.fn>;
    }) => T,
  ): T {
    const assignSpy = vi.fn();
    const reportErrorSpy = vi.fn();
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalReportError = Object.getOwnPropertyDescriptor(globalThis, "reportError");
    (globalThis as { window?: unknown }).window = {
      location: { assign: assignSpy },
    };
    Object.defineProperty(globalThis, "reportError", {
      configurable: true,
      value: reportErrorSpy,
      writable: true,
    });
    try {
      return fn({ assignSpy, reportErrorSpy });
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      if (originalReportError) {
        Object.defineProperty(globalThis, "reportError", originalReportError);
      } else {
        delete (globalThis as { reportError?: unknown }).reportError;
      }
    }
  }

  it("reports the error globally without writing to console.error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withFakeWindow(({ reportErrorSpy }) => {
        const handler = createOnUncaughtError();
        const err = new Error("boom");
        handler(err, { componentStack: "\n    at Page (page.tsx:10)" });
        expect(reportErrorSpy).toHaveBeenCalledWith(err);
        expect(consoleSpy).not.toHaveBeenCalled();
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("leaves navigation failure dispatch to the global error listener", () => {
    withFakeWindow(({ assignSpy, reportErrorSpy }) => {
      const handler = createOnUncaughtError();
      const error = new Error("late error");
      handler(error, {});
      expect(reportErrorSpy).toHaveBeenCalledWith(error);
      expect(assignSpy).not.toHaveBeenCalled();
    });
  });
});

describe("app navigation failure handling", () => {
  it("hard-navigates to the latest pending URL when enabled", () => {
    vi.stubEnv("__NEXT_APP_NAV_FAIL_HANDLING", "true");
    const originalWindow = globalThis.window;
    const assign = vi.fn();
    globalThis.window = {
      location: { assign, href: "https://example.com/current" },
      next: { version: "vinext" },
    } as unknown as Window & typeof globalThis;

    try {
      stageAppNavigationFailureTarget("/first");
      stageAppNavigationFailureTarget("/latest");
      expect(handleAppNavigationFailure(new Error("boom"))).toBe(true);
      expect(assign).toHaveBeenCalledWith("https://example.com/latest");
    } finally {
      globalThis.window = originalWindow;
      vi.unstubAllEnvs();
    }
  });

  it("clears only the matching committed URL", () => {
    vi.stubEnv("__NEXT_APP_NAV_FAIL_HANDLING", "true");
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: { href: "https://example.com/current" },
      next: { version: "vinext" },
    } as unknown as Window & typeof globalThis;

    try {
      stageAppNavigationFailureTarget("/latest");
      clearAppNavigationFailureTarget("/older");
      expect(window.next?.__pendingUrl?.pathname).toBe("/latest");
      clearAppNavigationFailureTarget("/latest");
      expect(window.next?.__pendingUrl).toBeUndefined();
    } finally {
      globalThis.window = originalWindow;
      vi.unstubAllEnvs();
    }
  });
});

describe("prodOnCaughtError (hydrateRoot prod handler)", () => {
  it("ignores redirect sentinels handled by RedirectBoundary", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      prodOnCaughtError(
        Object.assign(new Error("NEXT_REDIRECT:/result"), {
          digest: "NEXT_REDIRECT;;%2Fresult",
        }),
        { componentStack: "\n    at Root" },
      );
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("ignores notFound and HTTP fallback sentinels (notFound/forbidden/unauthorized)", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      prodOnCaughtError(Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }), {
        componentStack: "\n    at Page",
      });
      prodOnCaughtError(
        Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;403"), {
          digest: "NEXT_HTTP_ERROR_FALLBACK;403",
        }),
        { componentStack: "\n    at Page" },
      );
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("forwards real caught errors to console.error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = new Error("Maximum update depth exceeded");
      prodOnCaughtError(err, { componentStack: "\n    at List\n    at Apps" });
      const loggedErrors = consoleSpy.mock.calls.map((args) => args[0]);
      expect(loggedErrors).toContain(err);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("routes implicit root-boundary errors through the uncaught handler", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onImplicitRootError = vi.fn();
      const handler = createProdOnCaughtError(onImplicitRootError);
      const err = new Error("hydration mismatch");

      handler(err, {
        componentStack: "\n    at Lazy",
        errorBoundary: {
          props: { isImplicitRootErrorBoundary: true },
        },
      });

      expect(onImplicitRootError).toHaveBeenCalledWith(
        err,
        expect.objectContaining({ componentStack: "\n    at Lazy" }),
      );
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not treat explicit segment boundaries as implicit", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onImplicitRootError = vi.fn();
      const handler = createProdOnCaughtError(onImplicitRootError);
      const err = new Error("segment error");

      handler(err, {
        componentStack: "\n    at Page",
        errorBoundary: {
          props: { isImplicitRootErrorBoundary: false },
        },
      });

      expect(onImplicitRootError).not.toHaveBeenCalled();
      expect(consoleSpy.mock.calls.map((args) => args[0])).toContain(err);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("includes the React component stack in the log when provided", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      prodOnCaughtError(new Error("boom"), {
        componentStack: "\n    at List (apps/list.tsx:202)",
      });
      expect(consoleSpy).toHaveBeenCalledTimes(2);
      expect(String(consoleSpy.mock.calls[1][0])).toContain("apps/list.tsx:202");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("logs only the error when no component stack is provided", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = new Error("no stack");
      prodOnCaughtError(err, {});
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0][0]).toBe(err);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not swallow a plain error that merely mentions NEXT_REDIRECT (no digest)", () => {
    // Classification is digest-based; an error whose *message* contains the
    // sentinel text but has no framework digest must still be logged.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = new Error("user code threw: NEXT_REDIRECT");
      prodOnCaughtError(err, {});
      expect(consoleSpy.mock.calls.map((args) => args[0])).toContain(err);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("prodOnRecoverableError (hydrateRoot prod handler)", () => {
  function withFakeReportError<T>(fn: (reportErrorSpy: ReturnType<typeof vi.fn>) => T): T {
    const reportErrorSpy = vi.fn();
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "reportError");
    Object.defineProperty(globalThis, "reportError", {
      configurable: true,
      value: reportErrorSpy,
      writable: true,
    });
    try {
      return fn(reportErrorSpy);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "reportError", originalDescriptor);
      } else {
        delete (globalThis as { reportError?: unknown }).reportError;
      }
    }
  }

  it("reports recoverable hydration errors through reportError", () => {
    withFakeReportError((reportErrorSpy) => {
      const err = new Error("Minified React error #418");
      prodOnRecoverableError(err);
      expect(reportErrorSpy).toHaveBeenCalledWith(err);
    });
  });

  it("reports the underlying cause when React provides one", () => {
    withFakeReportError((reportErrorSpy) => {
      const cause = new Error("server/client text mismatch");
      const err = new Error("recoverable", { cause });
      prodOnRecoverableError(err);
      expect(reportErrorSpy).toHaveBeenCalledWith(cause);
    });
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
    const onRecoverableError = vi.fn();
    const onUncaughtError = vi.fn();
    const hydrateRoot = vi.fn();

    const consumedFormState = consumeInitialFormState(global);
    const hydrateOptions = createVinextHydrateRootOptions({
      formState: consumedFormState,
      onCaughtError,
      onRecoverableError,
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
      onRecoverableError,
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
  it("includes the public Next.js action header when previousNextUrl is null and no slots are mounted", () => {
    const elements = createResolvedElements("route:/settings", "/");

    const { headers } = resolveServerActionRequestState({
      actionId: "action-abc",
      basePath: "",
      elements,
      previousNextUrl: null,
    });

    // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions/app-action.test.ts
    expect(Array.from(headers.keys()).sort()).toEqual([
      "accept",
      "next-action",
      "rsc",
      "x-rsc-action",
    ]);
    expect(headers.get("accept")).toBe("text/x-component");
    expect(headers.get("next-action")).toBe("action-abc");
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
