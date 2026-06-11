import { describe, expect, it, vi } from "vite-plus/test";
import {
  AppBrowserHistoryController,
  type RestorableSnapshotCandidate,
} from "../packages/vinext/src/server/app-browser-history-controller.js";
import {
  createBasePathStrippedPathAndSearch,
  createSnapshotPathAndSearch,
} from "../packages/vinext/src/server/app-browser-navigation-controller.js";
import {
  createHistoryStateWithNavigationMetadata,
  readHistoryStateTraversalIndex,
} from "../packages/vinext/src/server/app-history-state.js";
import {
  AppElementsWire,
  normalizeAppElements,
  type AppElements,
} from "../packages/vinext/src/server/app-elements.js";
import { createClientNavigationRenderSnapshot } from "../packages/vinext/src/shims/navigation.js";
import type { AppRouterState } from "../packages/vinext/src/server/app-browser-state.js";

type HistoryWrite = { state: unknown; href: string };

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
    replaceHistoryState: (next: unknown, nextHref: string) => {
      replaced.push({ state: next, href: nextHref });
      state = next;
      href = new URL(nextHref, href).href;
    },
  };
}

function createController(options?: {
  initialState?: unknown;
  initialHref?: string;
  visibleMetadata?: VisibleNavigationMetadata | null;
}) {
  const store = createHistoryStore(options?.initialState ?? null, options?.initialHref);
  let visibleMetadata = options?.visibleMetadata ?? null;
  const controller = new AppBrowserHistoryController({
    initialHistoryState: store.state,
    maxHistoryStateSnapshots: 50,
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
      initialState: { __vinext_scrollY: 10, __vinext_historyIndex: 0 },
    });

    controller.commitHashOnlyNavigation("/page#section", "push", false);

    expect(store.pushed).toHaveLength(1);
    const writtenState = readWrittenState(store.pushed[0]);
    // A push starts from a null base, so prior scroll metadata never carries.
    expect("__vinext_scrollY" in writtenState).toBe(false);
    expect(readHistoryStateTraversalIndex(writtenState)).toBe(1);
    expect(controller.currentHistoryTraversalIndex).toBe(1);
  });
});

describe("AppBrowserHistoryController history metadata sync", () => {
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
});
