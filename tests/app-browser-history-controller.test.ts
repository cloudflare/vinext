import { describe, expect, it, vi } from "vite-plus/test";
import {
  AppBrowserHistoryController,
  createCanonicalBrowserHistoryHref,
  type RestorableSnapshotCandidate,
} from "../packages/vinext/src/server/app-browser-history-controller.js";
import {
  createBasePathStrippedPathAndSearch,
  createSnapshotPathAndSearch,
} from "../packages/vinext/src/server/app-browser-navigation-controller.js";
import {
  createHistoryStateWithNavigationMetadata,
  createHistoryStateWithTreeSnapshotId,
  isExternalHistoryState,
  readHistoryStateActiveRoutePaths,
  readHistoryStateTraversalIndex,
  readHistoryStateTreeSnapshotId,
} from "../packages/vinext/src/server/app-history-state.js";
import {
  AppElementsWire,
  normalizeAppElements,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import { createClientNavigationRenderSnapshot } from "../packages/vinext/src/shims/navigation.js";
import type { AppRouterState } from "../packages/vinext/src/server/app-browser-state.js";

type HistoryWrite = { state: unknown; href?: string };

function readWrittenState(write: HistoryWrite | undefined): Record<string, unknown> {
  const state = write?.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("expected an object history state");
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    record[key] = value;
  }
  return record;
}

type VisibleNavigationMetadata = {
  activeRoutePaths: readonly string[] | null;
  bfcacheIds: Readonly<Record<string, string>> | null;
  previousNextUrl: string | null;
};

function createHistoryStore(initialState: unknown = null, initialHref = "https://example.com/") {
  let state = initialState;
  let href = initialHref;
  const pushed: HistoryWrite[] = [];
  const replaced: HistoryWrite[] = [];

  return {
    get state() {
      return state;
    },
    get href() {
      return href;
    },
    get pushed() {
      return pushed;
    },
    get replaced() {
      return replaced;
    },
    readHistoryState: () => state,
    readCurrentHref: () => href,
    // Seeds the live history entry for setup without recording a write.
    setState: (next: unknown) => {
      state = next;
    },
    pushHistoryState: (next: unknown, nextHref: string) => {
      pushed.push({ state: next, href: nextHref });
      state = next;
      href = new URL(nextHref, href).href;
    },
    replaceHistoryState: (next: unknown, nextHref?: string) => {
      replaced.push({ state: next, href: nextHref });
      state = next;
      if (nextHref !== undefined) {
        href = new URL(nextHref, href).href;
      }
    },
  };
}

function createController(options?: {
  initialState?: unknown;
  initialHref?: string;
  maxHistoryStateSnapshots?: number;
  visibleMetadata?: VisibleNavigationMetadata | null;
}) {
  const store = createHistoryStore(options?.initialState ?? null, options?.initialHref);
  let visibleMetadata = options?.visibleMetadata ?? null;
  const controller = new AppBrowserHistoryController({
    initialHistoryState: store.state,
    maxHistoryStateSnapshots: options?.maxHistoryStateSnapshots ?? 50,
    readHistoryState: store.readHistoryState,
    readCurrentHref: store.readCurrentHref,
    pushHistoryState: store.pushHistoryState,
    replaceHistoryState: store.replaceHistoryState,
    readVisibleNavigationMetadata: () => visibleMetadata,
  });
  return {
    controller,
    store,
    setVisibleMetadata: (next: VisibleNavigationMetadata | null) => {
      visibleMetadata = next;
    },
  };
}

function createResolvedElements(routeId: string, rootLayoutTreePath: string | null): AppElements {
  return normalizeAppElements({
    ...AppElementsWire.createMetadataEntries({
      interception: null,
      interceptionContext: null,
      layoutIds:
        rootLayoutTreePath === null ? [] : [AppElementsWire.encodeLayoutId(rootLayoutTreePath)],
      rootLayoutTreePath,
      routeId,
      slotBindings: [],
    }),
  });
}

function createRouterState(overrides: Partial<AppRouterState> = {}): AppRouterState {
  return {
    activeOperation: null,
    bfcacheIds: {},
    elements: createResolvedElements("route:/initial", "/"),
    interception: null,
    interceptionContext: null,
    layoutIds: [AppElementsWire.encodeLayoutId("/")],
    layoutFlags: {},
    navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/initial", {}),
    previousNextUrl: null,
    renderId: 0,
    rootLayoutTreePath: "/",
    routeId: "route:/initial",
    slotBindings: [],
    visibleCommitVersion: 0,
    ...overrides,
  };
}

describe("AppBrowserHistoryController traversal index allocation", () => {
  it("allocates per history update mode and anchors to the highest committed index", () => {
    const initialState = createHistoryStateWithNavigationMetadata(null, {
      previousNextUrl: null,
      traversalIndex: 3,
    });
    const { controller } = createController({ initialState });

    expect(controller.currentHistoryTraversalIndex).toBe(3);
    // push continues from the highest known app entry; replace stays put; a
    // metadata-less navigation (undefined mode) allocates no index.
    expect(controller.allocateNavigationHistoryTraversalIndex("push")).toBe(4);
    expect(controller.allocateNavigationHistoryTraversalIndex("replace")).toBe(3);
    expect(controller.allocateNavigationHistoryTraversalIndex(undefined)).toBeNull();

    controller.commitHistoryTraversalIndex(4);
    expect(controller.currentHistoryTraversalIndex).toBe(4);
    expect(controller.allocateNavigationHistoryTraversalIndex("push")).toBe(5);

    // Traversing back to a lower index keeps the next-push anchor at the highest
    // app-owned entry (4), not the index we just traversed to.
    controller.commitTraversalIndexFromHistoryState(
      createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 2,
      }),
    );
    expect(controller.currentHistoryTraversalIndex).toBe(2);
    expect(controller.allocateNavigationHistoryTraversalIndex("push")).toBe(5);
    expect(controller.allocateNavigationHistoryTraversalIndex("replace")).toBe(2);
  });

  it("treats a traversal to a metadata-less entry as an unknown current index", () => {
    const { controller } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 4,
      }),
    });

    controller.commitTraversalIndexFromHistoryState(null);

    expect(controller.currentHistoryTraversalIndex).toBeNull();
    // current is unknown, so replace cannot allocate; push still continues from
    // the highest known app entry (4).
    expect(controller.allocateNavigationHistoryTraversalIndex("replace")).toBeNull();
    expect(controller.allocateNavigationHistoryTraversalIndex("push")).toBe(5);
  });
});

describe("AppBrowserHistoryController hash-only navigation", () => {
  it("strips vinext scroll metadata on a scroll-enabled hash-only replace", () => {
    const { controller, store } = createController({
      initialState: { __vinext_scrollX: 5, __vinext_scrollY: 10, __vinext_historyIndex: 0 },
    });

    controller.commitHashOnlyNavigation("/page#section", "replace", true);

    expect(store.replaced).toHaveLength(1);
    const writtenState = readWrittenState(store.replaced[0]);
    expect("__vinext_scrollY" in writtenState).toBe(false);
    expect("__vinext_scrollX" in writtenState).toBe(false);
    expect(readHistoryStateTraversalIndex(writtenState)).toBe(0);
  });

  it("preserves vinext scroll metadata on a scroll-disabled hash-only replace", () => {
    const { controller, store } = createController({
      initialState: { __vinext_scrollX: 5, __vinext_scrollY: 10, __vinext_historyIndex: 0 },
    });

    controller.commitHashOnlyNavigation("/page#section", "replace", false);

    expect(store.replaced).toHaveLength(1);
    const writtenState = readWrittenState(store.replaced[0]);
    expect(writtenState.__vinext_scrollY).toBe(10);
    expect(writtenState.__vinext_scrollX).toBe(5);
  });

  it("pushes a fresh history entry and advances the traversal index on a hash-only push", () => {
    const { controller, store } = createController({
      initialState: {
        __vinext_activeRoutePaths: ["/detail-page"],
        __vinext_scrollY: 10,
        __vinext_historyIndex: 0,
      },
    });

    controller.commitHashOnlyNavigation("/page#section", "push", false);

    expect(store.pushed).toHaveLength(1);
    const writtenState = readWrittenState(store.pushed[0]);
    // A push starts from a null base, so prior scroll metadata never carries.
    expect("__vinext_scrollY" in writtenState).toBe(false);
    expect(readHistoryStateActiveRoutePaths(writtenState)).toEqual(["/detail-page"]);
    expect(readHistoryStateTraversalIndex(writtenState)).toBe(1);
    expect(controller.currentHistoryTraversalIndex).toBe(1);
  });

  it("retains copied tree identity when pushing a hash from an external entry", () => {
    const bfcacheIds = { "page:/shallow-test": "shallow-page" };
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(
        { __vinext_externalHistoryState: true, __vinext_treeSnapshotId: 7 },
        {
          bfcacheIds,
          bfcacheVersion: 0,
          previousNextUrl: null,
          traversalIndex: 0,
        },
      ),
      visibleMetadata: { activeRoutePaths: ["/shallow-test"], bfcacheIds, previousNextUrl: null },
    });

    controller.commitHashOnlyNavigation("/shallow-test/sub#content", "push", true);

    const writtenState = readWrittenState(store.pushed[0]);
    expect(writtenState.__vinext_externalHistoryState).toBe(true);
    expect(readHistoryStateTreeSnapshotId(writtenState)).toBe(7);
    expect(writtenState.__vinext_bfcacheIds).toEqual(bfcacheIds);
    expect(readHistoryStateTraversalIndex(writtenState)).toBe(1);
  });
});

describe("AppBrowserHistoryController history metadata sync", () => {
  it("canonicalizes a bare trailing query marker during bootstrap", () => {
    const { controller, store } = createController({
      initialHref: "https://example.com/reload-error?#section",
    });

    controller.writeBootstrapHistoryMetadata();

    expect(store.replaced).toHaveLength(1);
    expect(store.replaced[0]?.href).toBe("/reload-error#section");
  });

  it("preserves non-empty query strings when canonicalizing history hrefs", () => {
    expect(createCanonicalBrowserHistoryHref("https://example.com/page?value=1#section")).toBe(
      "/page?value=1#section",
    );
  });

  it("omits the URL from hydrated metadata writes", () => {
    const { controller, store } = createController();

    controller.writeHydratedHistoryMetadata({
      activeRoutePaths: ["/detail-page"],
      bfcacheIds: {},
      previousNextUrl: null,
    });

    expect(store.replaced).toHaveLength(1);
    expect(store.replaced[0]?.href).toBeUndefined();
    expect(readHistoryStateActiveRoutePaths(store.replaced[0]?.state)).toEqual(["/detail-page"]);
  });

  it("stores target active routes on pushed navigation entries", () => {
    const { controller, store } = createController({
      initialHref: "https://example.com/refreshing/login",
    });

    controller.commitNavigationHistory({
      activeRoutePaths: ["/detail-page"],
      bfcacheIds: {},
      href: "https://example.com/detail-page",
      historyUpdateMode: "push",
      previousNextUrl: null,
      stageClientParams: vi.fn(),
    });

    expect(store.pushed).toHaveLength(1);
    expect(readHistoryStateActiveRoutePaths(store.pushed[0]?.state)).toEqual(["/detail-page"]);
  });

  it("omits the URL from current-entry metadata synchronization", () => {
    const { controller, store } = createController();

    controller.syncCurrentHistoryStatePreviousNextUrl("/previous");

    expect(store.replaced).toHaveLength(1);
    expect(store.replaced[0]?.href).toBeUndefined();
  });

  it("preserves the BFCache epoch check when deciding whether to re-sync", () => {
    // A fresh document with no stored epoch starts at document epoch 0.
    const { controller, store } = createController();
    const bfcacheIds = { [AppElementsWire.encodeLayoutId("/")]: "segment-v1" };
    // Seed the live entry so previousNextUrl, ids, and the stored epoch (0) all
    // match the current document epoch (0); nothing should be rewritten.
    store.setState(
      createHistoryStateWithNavigationMetadata(null, {
        bfcacheIds,
        bfcacheVersion: 0,
        previousNextUrl: "/from",
      }),
    );

    controller.syncCurrentHistoryStatePreviousNextUrl("/from", bfcacheIds);
    expect(store.replaced).toHaveLength(0);

    // Invalidating the client state bumps the document BFCache epoch. The stored
    // entry's epoch is now stale even though previousNextUrl and ids still match,
    // so the controller must rewrite the entry.
    controller.invalidateRestorableClientState();
    controller.syncCurrentHistoryStatePreviousNextUrl("/from", bfcacheIds);
    expect(store.replaced).toHaveLength(1);
  });

  it("skips the rewrite when previousNextUrl already matches and bfcache ids are not supplied", () => {
    const syncedState = createHistoryStateWithNavigationMetadata(null, {
      previousNextUrl: "/from",
    });
    const { controller, store } = createController({ initialState: syncedState });

    controller.syncCurrentHistoryStatePreviousNextUrl("/from");

    expect(store.replaced).toHaveLength(0);
  });

  it("rewrites the current entry when its active route evidence is stale", () => {
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        activeRoutePaths: ["/refreshing"],
        previousNextUrl: null,
      }),
    });

    controller.syncCurrentHistoryStatePreviousNextUrl(null, undefined, ["/detail-page"]);

    expect(store.replaced).toHaveLength(1);
    expect(readHistoryStateActiveRoutePaths(store.replaced[0]?.state)).toEqual(["/detail-page"]);
  });
});

describe("AppBrowserHistoryController snapshot restore", () => {
  function seedSnapshotAtIndex(
    controller: AppBrowserHistoryController,
    historyIndex: number,
    snapshotState: AppRouterState,
  ): void {
    controller.commitHistoryTraversalIndex(historyIndex);
    controller.rememberHistoryStateSnapshot(snapshotState);
  }

  it("resolves the restorable candidate and delegates visible restoration to the injected callback", () => {
    const { controller } = createController();
    const snapshotState = createRouterState({
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/details", {
        id: "abc",
      }),
      routeId: "route:/details",
    });
    seedSnapshotAtIndex(controller, 1, snapshotState);
    // Move the committed index away from the snapshot's index so we can observe
    // the restore re-committing it to 1.
    controller.commitHistoryTraversalIndex(2);

    const stageClientParams = vi.fn();
    const approveVisibleRestore = vi.fn((candidate: RestorableSnapshotCandidate) => {
      candidate.beforeCommit();
      return true;
    });

    const restored = controller.restoreHistorySnapshot({
      historyState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 1,
      }),
      stageClientParams,
      approveVisibleRestore,
    });

    expect(restored).toBe(true);
    expect(approveVisibleRestore).toHaveBeenCalledTimes(1);
    expect(approveVisibleRestore.mock.calls[0]?.[0].state).toBe(snapshotState);
    expect(stageClientParams).toHaveBeenCalledWith({ id: "abc" });
    expect(controller.currentHistoryTraversalIndex).toBe(1);
  });

  it("does not commit the traversal index when the approved-restore callback declines", () => {
    const { controller } = createController();
    const snapshotState = createRouterState({ routeId: "route:/details" });
    seedSnapshotAtIndex(controller, 1, snapshotState);
    controller.commitHistoryTraversalIndex(2);

    const stageClientParams = vi.fn();
    // Mirror the real navigation controller: when the ApprovedVisibleCommit is
    // not approved, beforeCommit never runs and the call returns false.
    const approveVisibleRestore = vi.fn(() => false);

    const restored = controller.restoreHistorySnapshot({
      historyState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 1,
      }),
      stageClientParams,
      approveVisibleRestore,
    });

    expect(restored).toBe(false);
    expect(stageClientParams).not.toHaveBeenCalled();
    expect(controller.currentHistoryTraversalIndex).toBe(2);
  });

  it("commits the traversal index only after the approved-restore callback succeeds", () => {
    const { controller } = createController();
    const snapshotState = createRouterState({ routeId: "route:/details" });
    seedSnapshotAtIndex(controller, 1, snapshotState);
    controller.commitHistoryTraversalIndex(2);

    let indexAtBeforeCommit: number | null = null;
    const approveVisibleRestore = (candidate: RestorableSnapshotCandidate) => {
      // The traversal index is still the pre-restore value until beforeCommit
      // runs inside the approved commit.
      indexAtBeforeCommit = controller.currentHistoryTraversalIndex;
      candidate.beforeCommit();
      return true;
    };

    controller.restoreHistorySnapshot({
      historyState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 1,
      }),
      stageClientParams: vi.fn(),
      approveVisibleRestore,
    });

    expect(indexAtBeforeCommit).toBe(2);
    expect(controller.currentHistoryTraversalIndex).toBe(1);
  });

  it("returns false without invoking the approved-restore callback when no snapshot is restorable", () => {
    const { controller } = createController();
    const approveVisibleRestore = vi.fn(() => true);

    const restored = controller.restoreHistorySnapshot({
      historyState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 9,
      }),
      stageClientParams: vi.fn(),
      approveVisibleRestore,
    });

    expect(restored).toBe(false);
    expect(approveVisibleRestore).not.toHaveBeenCalled();
  });

  it("restores an external entry by copied tree identity after its traversal index is replaced", () => {
    const { controller, setVisibleMetadata, store } = createController();
    const shallowState = createRouterState({
      bfcacheIds: { "page:/shallow-test": "shallow-page" },
      navigationSnapshot: createClientNavigationRenderSnapshot(
        "https://example.com/shallow-test",
        {},
      ),
      routeId: "route:/shallow-test",
    });
    seedSnapshotAtIndex(controller, 0, shallowState);
    const shallowTreeSnapshotId = readHistoryStateTreeSnapshotId(store.state);
    expect(shallowTreeSnapshotId).not.toBeNull();
    controller.claimCurrentHistoryTreeSnapshot("push", store.state);
    store.setState(createHistoryStateWithTreeSnapshotId(store.state, null));

    const replacementState = createRouterState({
      bfcacheIds: { "page:/about": "about-page" },
      navigationSnapshot: createClientNavigationRenderSnapshot("https://example.com/about", {}),
      routeId: "route:/about",
    });
    seedSnapshotAtIndex(controller, 0, replacementState);
    setVisibleMetadata({
      activeRoutePaths: [],
      bfcacheIds: replacementState.bfcacheIds,
      previousNextUrl: null,
    });

    const externalHistoryState = createHistoryStateWithTreeSnapshotId(
      createHistoryStateWithNavigationMetadata(
        { __vinext_externalHistoryState: true },
        {
          bfcacheIds: shallowState.bfcacheIds,
          bfcacheVersion: 0,
          previousNextUrl: null,
          traversalIndex: 0,
        },
      ),
      shallowTreeSnapshotId,
    );
    expect(controller.isCurrentExternalHistoryTree(externalHistoryState)).toBe(false);

    const approveVisibleRestore = vi.fn((candidate: RestorableSnapshotCandidate) => {
      candidate.beforeCommit();
      return true;
    });
    expect(
      controller.restoreHistorySnapshot({
        historyState: externalHistoryState,
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore,
      }),
    ).toBe(true);
    expect(approveVisibleRestore.mock.calls[0]?.[0].state).toBe(shallowState);
  });

  it("retains reachable external tree snapshots across traversal-cache eviction", () => {
    const { controller, store } = createController();
    const externalState = createRouterState({ routeId: "route:/external" });
    seedSnapshotAtIndex(controller, 0, externalState);
    const externalTreeSnapshotId = readHistoryStateTreeSnapshotId(store.state);
    expect(externalTreeSnapshotId).not.toBeNull();
    controller.claimCurrentHistoryTreeSnapshot("push", store.state);
    controller.rememberHistoryStateSnapshot(externalState);
    expect(readHistoryStateTreeSnapshotId(store.state)).toBe(externalTreeSnapshotId);
    store.setState(createHistoryStateWithTreeSnapshotId(store.state, null));

    // More than the 50-entry traversal-cache limit worth of same-entry replace
    // renders must not evict a raw pushState entry's exact tree identity. The
    // browser gives us no way to prove that external entry unreachable.
    for (let render = 1; render <= 52; render += 1) {
      seedSnapshotAtIndex(
        controller,
        0,
        createRouterState({ routeId: `route:/replacement-${render}` }),
      );
    }

    const approveVisibleRestore = vi.fn((candidate: RestorableSnapshotCandidate) => {
      candidate.beforeCommit();
      return true;
    });
    expect(
      controller.restoreHistorySnapshot({
        historyState: createHistoryStateWithTreeSnapshotId(
          { __vinext_externalHistoryState: true },
          externalTreeSnapshotId,
        ),
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore,
      }),
    ).toBe(true);
    expect(approveVisibleRestore.mock.calls[0]?.[0].state).toBe(externalState);
  });

  it("releases ordinary tree snapshots that no history entry claims", () => {
    const { controller, store } = createController();
    seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: "route:/ordinary-0" }));
    const firstTreeSnapshotId = readHistoryStateTreeSnapshotId(store.state);
    expect(firstTreeSnapshotId).not.toBeNull();
    const supersededTreeSnapshotIds = [firstTreeSnapshotId];

    for (let render = 1; render <= 52; render += 1) {
      seedSnapshotAtIndex(
        controller,
        0,
        createRouterState({ routeId: `route:/ordinary-${render}` }),
      );
      if (render < 52) {
        supersededTreeSnapshotIds.push(readHistoryStateTreeSnapshotId(store.state));
      }
    }

    const approveVisibleRestore = vi.fn(() => true);
    for (const treeSnapshotId of supersededTreeSnapshotIds) {
      expect(
        controller.restoreHistorySnapshot({
          historyState: createHistoryStateWithTreeSnapshotId(null, treeSnapshotId),
          preferExternalSnapshot: true,
          stageClientParams: vi.fn(),
          approveVisibleRestore,
        }),
      ).toBe(false);
    }
    expect(approveVisibleRestore).not.toHaveBeenCalled();
  });

  it("releases raw replace claims when app replace overwrites the same entry", () => {
    const { controller, store } = createController();
    const overwrittenTreeSnapshotIds: Array<number | null> = [];
    seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: "route:/cycle-0" }));

    for (let render = 1; render <= 52; render += 1) {
      overwrittenTreeSnapshotIds.push(readHistoryStateTreeSnapshotId(store.state));
      controller.claimCurrentHistoryTreeSnapshot("replace", store.state);
      controller.commitNavigationHistory({
        activeRoutePaths: [],
        bfcacheIds: {},
        href: `/cycle-${render}`,
        historyUpdateMode: "replace",
        previousNextUrl: null,
        stageClientParams: vi.fn(),
      });
      seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: `route:/cycle-${render}` }));
    }

    const approveVisibleRestore = vi.fn(() => true);
    for (const treeSnapshotId of overwrittenTreeSnapshotIds) {
      expect(
        controller.restoreHistorySnapshot({
          historyState: createHistoryStateWithTreeSnapshotId(null, treeSnapshotId),
          preferExternalSnapshot: true,
          stageClientParams: vi.fn(),
          approveVisibleRestore,
        }),
      ).toBe(false);
    }
    expect(approveVisibleRestore).not.toHaveBeenCalled();
  });

  it("releases an external claim overwritten by a captured app-owned replace", () => {
    const { controller, store } = createController({
      initialState: { __vinext_historyIndex: 0 },
    });
    seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: "route:/external" }));
    const overwrittenTreeSnapshotId = readHistoryStateTreeSnapshotId(store.state);
    expect(overwrittenTreeSnapshotId).not.toBeNull();

    const appOwnedState = store.state;
    store.setState({
      ...(appOwnedState as Record<string, unknown>),
      __vinext_externalHistoryState: true,
    });
    controller.claimCurrentHistoryTreeSnapshot("replace", appOwnedState);
    const overwrittenExternalState = store.state;

    const capturedAppState = { __vinext_historyIndex: 0, captured: true };
    store.setState(capturedAppState);
    controller.commitAppOwnedHistoryStateWrite("replace", overwrittenExternalState);
    controller.commitAppOwnedHistoryStateWrite("replace", overwrittenExternalState);
    expect(store.state).toEqual(capturedAppState);
    expect(isExternalHistoryState(store.state)).toBe(false);

    seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: "route:/replacement" }));
    expect(
      controller.restoreHistorySnapshot({
        historyState: createHistoryStateWithTreeSnapshotId(
          { __vinext_externalHistoryState: true },
          overwrittenTreeSnapshotId,
        ),
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore: vi.fn(() => true),
      }),
    ).toBe(false);
  });

  it("releases claimed snapshots when a push truncates forward history", () => {
    const { controller, store } = createController();
    const truncatedTreeSnapshotIds: Array<number | null> = [];

    for (let render = 0; render <= 52; render += 1) {
      seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: `route:/source-${render}` }));
      const sourceHistoryState = store.state;
      const sourceTreeSnapshotId = readHistoryStateTreeSnapshotId(sourceHistoryState);
      controller.claimCurrentHistoryTreeSnapshot("push", sourceHistoryState);

      if (render > 0) {
        truncatedTreeSnapshotIds.push(sourceTreeSnapshotId);
      }
      if (render === 52) break;

      store.setState(sourceHistoryState);
      controller.commitTraversalIndexFromHistoryState(sourceHistoryState);
      controller.commitNavigationHistory({
        activeRoutePaths: [],
        bfcacheIds: {},
        href: `/source-${render + 1}`,
        historyUpdateMode: "replace",
        previousNextUrl: null,
        stageClientParams: vi.fn(),
      });
    }

    const approveVisibleRestore = vi.fn(() => true);
    for (const treeSnapshotId of truncatedTreeSnapshotIds.slice(0, -1)) {
      expect(
        controller.restoreHistorySnapshot({
          historyState: createHistoryStateWithTreeSnapshotId(null, treeSnapshotId),
          preferExternalSnapshot: true,
          stageClientParams: vi.fn(),
          approveVisibleRestore,
        }),
      ).toBe(false);
    }
    expect(approveVisibleRestore).not.toHaveBeenCalled();
  });

  it("releases forward claims truncated by a captured app-owned push after Back", () => {
    const { controller, store } = createController({
      initialState: { __vinext_historyIndex: 0 },
    });
    seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: "route:/source" }));
    const sourceHistoryState = store.state;
    const truncatedTreeSnapshotId = readHistoryStateTreeSnapshotId(sourceHistoryState);
    expect(truncatedTreeSnapshotId).not.toBeNull();

    controller.claimCurrentHistoryTreeSnapshot("push", sourceHistoryState);
    controller.claimCurrentHistoryTreeSnapshot("push", store.state);
    store.setState(sourceHistoryState);
    controller.commitTraversalIndexFromHistoryState(sourceHistoryState);

    const capturedAppState = { __vinext_historyIndex: 0, captured: true };
    store.setState(capturedAppState);
    controller.commitAppOwnedHistoryStateWrite("push", sourceHistoryState);
    controller.commitAppOwnedHistoryStateWrite("push", sourceHistoryState);
    expect(store.state).toEqual(capturedAppState);
    expect(isExternalHistoryState(store.state)).toBe(false);

    seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: "route:/replacement" }));
    expect(
      controller.restoreHistorySnapshot({
        historyState: createHistoryStateWithTreeSnapshotId(
          { __vinext_externalHistoryState: true },
          truncatedTreeSnapshotId,
        ),
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore: vi.fn(() => true),
      }),
    ).toBe(false);
  });

  it("detaches a same-URL app replace from a tree claimed by another entry", () => {
    const { controller, store } = createController({ initialHref: "https://example.com/about" });
    const copiedState = createRouterState({ routeId: "route:/copied" });
    seedSnapshotAtIndex(controller, 0, copiedState);
    const copiedTreeSnapshotId = readHistoryStateTreeSnapshotId(store.state);
    expect(copiedTreeSnapshotId).not.toBeNull();

    controller.claimCurrentHistoryTreeSnapshot("push", store.state);
    controller.claimCurrentHistoryTreeSnapshot("push", store.state);
    controller.commitNavigationHistory({
      activeRoutePaths: [],
      bfcacheIds: {},
      href: "/about",
      historyUpdateMode: "replace",
      previousNextUrl: null,
      stageClientParams: vi.fn(),
    });
    expect(readHistoryStateTreeSnapshotId(store.state)).toBeNull();

    seedSnapshotAtIndex(controller, 0, createRouterState({ routeId: "route:/about" }));
    const approveVisibleRestore = vi.fn((candidate: RestorableSnapshotCandidate) => {
      candidate.beforeCommit();
      return true;
    });
    expect(
      controller.restoreHistorySnapshot({
        historyState: createHistoryStateWithTreeSnapshotId(
          { __vinext_externalHistoryState: true, __vinext_treeSnapshotClaimed: true },
          copiedTreeSnapshotId,
        ),
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore,
      }),
    ).toBe(true);
    expect(approveVisibleRestore.mock.calls[0]?.[0].state).toBe(copiedState);
  });

  it("refreshes reachable external tree snapshots across client-cache invalidation", () => {
    const { controller, store } = createController();
    const externalState = createRouterState({ routeId: "route:/external" });
    seedSnapshotAtIndex(controller, 0, externalState);
    const externalTreeSnapshotId = readHistoryStateTreeSnapshotId(store.state);
    expect(externalTreeSnapshotId).not.toBeNull();
    controller.claimCurrentHistoryTreeSnapshot("push", store.state);

    // router.refresh() invalidates BFCache ids and traversal-index snapshots,
    // but a forward raw pushState entry still owns this exact copied tree. The
    // refresh commit updates the state behind that stable identity rather than
    // replaying stale pre-refresh server elements.
    controller.invalidateRestorableClientState();
    const refreshedState = createRouterState({ routeId: "route:/external-refreshed" });
    seedSnapshotAtIndex(controller, 0, refreshedState);
    expect(readHistoryStateTreeSnapshotId(store.state)).toBe(externalTreeSnapshotId);

    const approveVisibleRestore = vi.fn((candidate: RestorableSnapshotCandidate) => {
      candidate.beforeCommit();
      return true;
    });
    expect(
      controller.restoreHistorySnapshot({
        historyState: createHistoryStateWithTreeSnapshotId(
          { __vinext_externalHistoryState: true },
          externalTreeSnapshotId,
        ),
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore,
      }),
    ).toBe(true);
    expect(approveVisibleRestore.mock.calls[0]?.[0].state).toBe(refreshedState);
  });
});

describe("history snapshot target normalization shared with same-route popstate matching", () => {
  it("strips basePath and canonicalizes search identically to a committed snapshot", () => {
    // isSameAppRoutePopstateTarget (browser entry) and the snapshot-restore
    // target check (navigation controller) both compare these two helpers, so a
    // basePath-prefixed, percent-encoded popstate URL must normalize to the same
    // string the snapshot produced. Guards the #1743 basePath target check.
    const snapshot = createClientNavigationRenderSnapshot(
      "https://example.com/scroll-restoration?q=a+b",
      {},
    );
    const popstateTarget = new URL("https://example.com/docs/scroll-restoration?q=a%20b");

    expect(createBasePathStrippedPathAndSearch(popstateTarget, "/docs")).toBe(
      createSnapshotPathAndSearch(snapshot),
    );
  });

  it("keeps snapshot search serialization stable across the planner URL round-trip", () => {
    const snapshot = createClientNavigationRenderSnapshot(
      "https://example.com/docs?space=a%20b&plus=%2B&empty=&encoded=%2520&order=1&order=2",
      {},
    );
    const snapshotPathAndSearch = createSnapshotPathAndSearch(snapshot);
    const plannerCurrentUrl = new URL(snapshotPathAndSearch, "https://example.com");

    expect(plannerCurrentUrl.searchParams.toString()).toBe(snapshot.searchParams.toString());
    expect([...plannerCurrentUrl.searchParams]).toEqual([...snapshot.searchParams]);
  });
});
