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
  createExternalHistoryStatePreservingMetadata,
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
import {
  createClientNavigationRenderSnapshot,
  type RouterHistoryWriteLanding,
} from "../packages/vinext/src/shims/navigation.js";
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
    // Like vinext's patched History API methods, a router write lands through
    // its landing hook.
    pushHistoryState: (next: unknown, nextHref: string, land?: RouterHistoryWriteLanding) => {
      const landing = land?.(next);
      state = landing ? landing.data : next;
      pushed.push({ state, href: nextHref });
      href = new URL(nextHref, href).href;
      landing?.commit();
    },
    replaceHistoryState: (next: unknown, nextHref?: string, land?: RouterHistoryWriteLanding) => {
      const landing = land?.(next);
      state = landing ? landing.data : next;
      replaced.push({ state, href: nextHref });
      if (nextHref !== undefined) {
        href = new URL(nextHref, href).href;
      }
      landing?.commit();
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

describe("AppBrowserHistoryController writes made by history wrappers", () => {
  type WrapperWrite = "push" | "replace";
  type Wrapper = {
    wraps: "push" | "replace";
    // The router write to wrap; the first one of its kind by default.
    wrapsHref?: string;
    before?: WrapperWrite[];
    after?: WrapperWrite[];
    throws?: boolean;
    // The browser rejects the forwarded write after it reaches the landing hook.
    writeThrows?: boolean;
    // ...and the wrapper catches that error, then gives up or retries.
    catchesWriteError?: "gives-up" | "retries";
    // Forwards a copy of the router's data, so the patched method no longer
    // recognises the router's write and its landing hook never runs.
    rewritesData?: boolean;
  };

  // A history wrapper installed after boot sees router writes with a URL
  // (#4339) and can make its own writes around the one it forwards. Models
  // vinext's patched History API methods: a wrapper's write is marked external
  // and claimed, and the forwarded router write lands through its landing
  // hook. State-only router writes go straight to the browser's methods.
  function createControllerWithWrapper(wrapper: Wrapper, maxHistoryStateSnapshots = 50) {
    const store = createHistoryStore(
      createHistoryStateWithNavigationMetadata(null, { previousNextUrl: null, traversalIndex: 0 }),
    );
    const wrapperEntryStates: unknown[] = [];
    let wrapped = false;
    const writeOwnEntry = (write: WrapperWrite) => {
      const previousHistoryState = store.state;
      const state = createExternalHistoryStatePreservingMetadata(
        { own: true },
        previousHistoryState,
      );
      if (write === "push") {
        store.pushHistoryState(state, `/own-${wrapperEntryStates.length}`);
      } else {
        store.replaceHistoryState(state);
      }
      controller.claimCurrentHistoryTreeSnapshot(write, previousHistoryState);
      wrapperEntryStates.push(store.state);
    };
    const writeThroughWrapper =
      (mode: "push" | "replace") =>
      (state: unknown, href: string | undefined, land?: RouterHistoryWriteLanding) => {
        const wrap =
          !wrapped &&
          mode === wrapper.wraps &&
          href !== undefined &&
          (wrapper.wrapsHref === undefined || href === wrapper.wrapsHref);
        if (wrap) wrapped = true;
        if (wrap) wrapper.before?.forEach(writeOwnEntry);
        if (wrap && wrapper.throws) throw new DOMException("blocked", "SecurityError");
        const forwarded = wrap && wrapper.rewritesData ? { ...(state as object) } : state;
        const forwardedLand = forwarded === state ? land : undefined;
        if (wrap && wrapper.writeThrows) {
          forwardedLand?.(forwarded);
          if (wrapper.catchesWriteError === undefined) {
            throw new DOMException("blocked", "SecurityError");
          }
          // The patched method re-arms the router write's marker, so a retry
          // lands it again.
          if (wrapper.catchesWriteError === "retries") {
            store.pushHistoryState(forwarded, href ?? store.href, forwardedLand);
          }
          return;
        }
        if (mode === "push") {
          store.pushHistoryState(forwarded, href ?? store.href, forwardedLand);
        } else {
          store.replaceHistoryState(forwarded, href, forwardedLand);
        }
        if (wrap) wrapper.after?.forEach(writeOwnEntry);
      };
    const controller: AppBrowserHistoryController = new AppBrowserHistoryController({
      initialHistoryState: store.state,
      maxHistoryStateSnapshots,
      readHistoryState: store.readHistoryState,
      readCurrentHref: store.readCurrentHref,
      pushHistoryState: writeThroughWrapper("push"),
      replaceHistoryState: writeThroughWrapper("replace"),
      readVisibleNavigationMetadata: () => null,
    });
    // The initial page has rendered, so its entry names a live tree.
    const initialTree = createRouterState({ renderId: 1 });
    controller.rememberHistoryStateSnapshot(initialTree);
    const initialEntryState = store.state;

    const navigate = (historyUpdateMode: "push" | "replace", href: string) => {
      controller.commitNavigationHistory({
        activeRoutePaths: [],
        bfcacheIds: {},
        href,
        historyUpdateMode,
        previousNextUrl: null,
        stageClientParams: vi.fn(),
      });
    };
    const restoredTree = (
      historyState: unknown,
      preferExternalSnapshot = false,
    ): AppRouterState | null => {
      let restored: AppRouterState | null = null;
      controller.restoreHistorySnapshot({
        historyState,
        preferExternalSnapshot,
        stageClientParams: vi.fn(),
        approveVisibleRestore: (candidate) => {
          restored = candidate.state;
          candidate.beforeCommit();
          return true;
        },
      });
      return restored;
    };
    return {
      controller,
      initialEntryState,
      initialTree,
      navigate,
      restoredTree,
      store,
      wrapperEntryStates,
    };
  }

  function findRouterEntryState(store: ReturnType<typeof createHistoryStore>, href: string) {
    const write = [...store.pushed, ...store.replaced].find((entry) => entry.href === href);
    return write?.state;
  }

  it("gives a push made after forwarding a router push the next index", () => {
    const { controller, initialEntryState, navigate, restoredTree, store, wrapperEntryStates } =
      createControllerWithWrapper({ wraps: "push", after: ["push"] });
    navigate("push", "/next");
    const routerEntryState = findRouterEntryState(store, "/next");
    const nextTree = createRouterState({ renderId: 2 });
    controller.rememberHistoryStateSnapshot(nextTree);
    const stampedWrapperEntryState = store.state;

    expect(readHistoryStateTraversalIndex(routerEntryState)).toBe(1);
    expect(readHistoryStateTraversalIndex(wrapperEntryStates[0])).toBe(2);
    expect(controller.currentHistoryTraversalIndex).toBe(2);

    // A later navigation from the wrapper's entry renders another tree. Back
    // to the wrapper's entry restores the tree it copied, and Back again to
    // the router's entry, written before its tree was remembered, restores
    // that tree too, not a later one.
    navigate("push", "/third");
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 3 }));
    expect(restoredTree(stampedWrapperEntryState, true)).toBe(nextTree);
    expect(controller.resolveTraversalIntent(routerEntryState).direction).toBe("back");
    expect(restoredTree(routerEntryState)).toBe(nextTree);
    expect(controller.resolveTraversalIntent(initialEntryState).direction).toBe("back");
  });

  it("puts a router push after a push the wrapper made before forwarding it", () => {
    const {
      controller,
      initialEntryState,
      initialTree,
      navigate,
      restoredTree,
      store,
      wrapperEntryStates,
    } = createControllerWithWrapper({ wraps: "push", before: ["push"] });
    navigate("push", "/next");
    const wrapperEntryState = wrapperEntryStates[0];
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 2 }));

    expect(readHistoryStateTraversalIndex(wrapperEntryState)).toBe(1);
    expect(readHistoryStateTraversalIndex(store.state)).toBe(2);
    expect(store.href).toBe("https://example.com/next");
    expect(controller.currentHistoryTraversalIndex).toBe(2);

    expect(controller.resolveTraversalIntent(wrapperEntryState).direction).toBe("back");
    expect(restoredTree(wrapperEntryState)).toBe(initialTree);
    expect(restoredTree(initialEntryState)).toBe(initialTree);
  });

  it("keeps indices increasing when the wrapper pushes on both sides of a router push", () => {
    const { controller, navigate, store, wrapperEntryStates } = createControllerWithWrapper({
      wraps: "push",
      before: ["push"],
      after: ["push"],
    });
    navigate("push", "/next");

    expect(wrapperEntryStates.map(readHistoryStateTraversalIndex)).toEqual([1, 3]);
    expect(readHistoryStateTraversalIndex(findRouterEntryState(store, "/next"))).toBe(2);
    expect(controller.currentHistoryTraversalIndex).toBe(3);
  });

  it("keeps a router push's index when the wrapper replaces the outgoing entry first", () => {
    const { controller, navigate, store } = createControllerWithWrapper({
      wraps: "push",
      before: ["replace"],
    });
    navigate("push", "/next");

    expect(readHistoryStateTraversalIndex(store.state)).toBe(1);
    expect(controller.currentHistoryTraversalIndex).toBe(1);
    // A replace on the destination keeps the router entry's own index.
    navigate("replace", "/next?tab=1");
    expect(readHistoryStateTraversalIndex(store.state)).toBe(1);
  });

  it("gives a router replace the index of the wrapper's entry it overwrites", () => {
    const {
      controller,
      initialEntryState,
      initialTree,
      navigate,
      restoredTree,
      store,
      wrapperEntryStates,
    } = createControllerWithWrapper({ wraps: "replace", before: ["push"] });
    navigate("replace", "/next");
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 2 }));
    // The overwritten wrapper entry's claim on the initial tree is released.
    expect(restoredTree(wrapperEntryStates[0], true)).toBeNull();

    // The wrapper pushed a copy of the initial entry, which the router replace
    // then overwrote, so Back leaves /next for the untouched initial entry.
    expect(readHistoryStateTraversalIndex(store.state)).toBe(1);
    expect(store.href).toBe("https://example.com/next");
    expect(controller.currentHistoryTraversalIndex).toBe(1);
    expect(controller.resolveTraversalIntent(initialEntryState).direction).toBe("back");
    expect(restoredTree(initialEntryState)).toBe(initialTree);
  });

  it("keeps a wrapper's push when the router push it forwards throws", () => {
    const { controller, navigate, wrapperEntryStates } = createControllerWithWrapper({
      wraps: "push",
      before: ["push"],
      throws: true,
    });

    expect(() => navigate("push", "/next")).toThrow("blocked");
    expect(readHistoryStateTraversalIndex(wrapperEntryStates[0])).toBe(1);
    expect(controller.currentHistoryTraversalIndex).toBe(1);
    expect(controller.allocateNavigationHistoryTraversalIndex("push")).toBe(2);
  });

  it("does not give the destination's tree to an outgoing entry whose tree was released", () => {
    const { controller, initialEntryState, initialTree, navigate, restoredTree, store } =
      createControllerWithWrapper({ wraps: "push", wrapsHref: "/c", before: ["push"] });
    navigate("push", "/b");
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 2 }));
    navigate("push", "/a");
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 3 }));

    // go(-2) back to the first entry commits its URL without a render, so it
    // keeps naming its released tree. The wrapper's push before forwarding
    // the next router push copies it.
    store.setState(initialEntryState);
    controller.commitTraversalIndexFromHistoryState(initialEntryState);
    navigate("push", "/c");
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 4 }));

    expect(restoredTree(initialEntryState)).toBe(initialTree);
  });

  it("commits the allocated index when the wrapper forwards a copy of the router's data", () => {
    const { controller, navigate, restoredTree, store } = createControllerWithWrapper({
      wraps: "push",
      rewritesData: true,
    });
    navigate("push", "/next");
    const routerEntryState = store.state;

    expect(readHistoryStateTraversalIndex(routerEntryState)).toBe(1);
    expect(controller.currentHistoryTraversalIndex).toBe(1);

    // A layout effect's raw push still leaves the router entry awaiting the
    // tree this navigation renders.
    store.pushHistoryState(
      createExternalHistoryStatePreservingMetadata({}, routerEntryState),
      "/next?f=1",
    );
    controller.claimCurrentHistoryTreeSnapshot("push", routerEntryState);
    const nextTree = createRouterState({ renderId: 2 });
    controller.rememberHistoryStateSnapshot(nextTree);
    expect(restoredTree(routerEntryState)).toBe(nextTree);
  });

  it("keeps a raw entry's claim when the browser rejects the router replace over it", () => {
    const { controller, initialEntryState, initialTree, navigate, restoredTree, store } =
      createControllerWithWrapper({ wraps: "replace", writeThrows: true });
    store.pushHistoryState(
      createExternalHistoryStatePreservingMetadata({}, initialEntryState),
      "/?f=1",
    );
    controller.claimCurrentHistoryTreeSnapshot("push", initialEntryState);
    const rawEntryState = store.state;

    expect(() => navigate("replace", "/next")).toThrow("blocked");
    expect(store.state).toBe(rawEntryState);

    // The raw entry stays reachable, so its tree must outlive the next render.
    navigate("push", "/next");
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 2 }));
    expect(restoredTree(rawEntryState, true)).toBe(initialTree);
  });

  it("commits nothing when the wrapper catches the browser's rejection of the router push", () => {
    const { controller, navigate, store, wrapperEntryStates } = createControllerWithWrapper({
      wraps: "push",
      before: ["push", "push"],
      writeThrows: true,
      catchesWriteError: "gives-up",
    });
    navigate("push", "/next");

    expect(store.state).toBe(wrapperEntryStates[1]);
    expect(controller.currentHistoryTraversalIndex).toBe(2);
  });

  it("commits the retried router push when the wrapper retries after a rejection", () => {
    const { controller, navigate, store, wrapperEntryStates } = createControllerWithWrapper({
      wraps: "push",
      before: ["push"],
      writeThrows: true,
      catchesWriteError: "retries",
    });
    navigate("push", "/next");

    expect(readHistoryStateTraversalIndex(wrapperEntryStates[0])).toBe(1);
    expect(readHistoryStateTraversalIndex(store.state)).toBe(2);
    expect(store.href).toBe("https://example.com/next");
    expect(controller.currentHistoryTraversalIndex).toBe(2);
  });

  it("gives each push the wrapper makes after forwarding its own index", () => {
    const { controller, navigate, restoredTree, wrapperEntryStates } = createControllerWithWrapper({
      wraps: "push",
      after: ["push", "push"],
    });
    navigate("push", "/next");
    const nextTree = createRouterState({ renderId: 2 });
    controller.rememberHistoryStateSnapshot(nextTree);
    navigate("push", "/third");
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 3 }));

    expect(wrapperEntryStates.map(readHistoryStateTraversalIndex)).toEqual([2, 3]);
    // The first wrapper entry was never current when the tree was remembered,
    // so it has no tree id of its own and refetches, as before.
    expect(readHistoryStateTreeSnapshotId(wrapperEntryStates[0])).toBeNull();
    expect(restoredTree(wrapperEntryStates[0], true)).toBeNull();
  });

  it("commits no traversal index when the router push throws", () => {
    const { controller, navigate } = createControllerWithWrapper({
      wraps: "push",
      throws: true,
    });

    expect(() => navigate("push", "/next")).toThrow("blocked");
    expect(controller.currentHistoryTraversalIndex).toBe(0);
    expect(controller.allocateNavigationHistoryTraversalIndex("push")).toBe(1);
  });
});

describe("AppBrowserHistoryController raw pushes from entries without a live tree", () => {
  it("gives a traversal's rendered tree to the entry a layout effect pushes from", () => {
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 0,
      }),
    });
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 1 }));
    const firstEntryState = store.state;
    const commit = (options: {
      href: string;
      historyUpdateMode?: "push";
      targetHistoryIndex?: number;
    }) =>
      controller.commitNavigationHistory({
        activeRoutePaths: [],
        bfcacheIds: {},
        historyUpdateMode: undefined,
        previousNextUrl: null,
        stageClientParams: vi.fn(),
        ...options,
      });
    commit({ href: "/b", historyUpdateMode: "push" });
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 2 }));

    // Back to the first entry, whose tree was released, renders it again. A
    // layout effect pushes from it before the root remembers the new tree.
    store.setState(firstEntryState);
    commit({ href: "/", targetHistoryIndex: 0 });
    store.pushHistoryState(
      createExternalHistoryStatePreservingMetadata({}, firstEntryState),
      "/?f=1",
    );
    controller.claimCurrentHistoryTreeSnapshot("push", firstEntryState);
    const traversedTree = createRouterState({ renderId: 3 });
    controller.rememberHistoryStateSnapshot(traversedTree);

    let restored: AppRouterState | null = null;
    controller.restoreHistorySnapshot({
      historyState: firstEntryState,
      stageClientParams: vi.fn(),
      approveVisibleRestore: (candidate) => {
        restored = candidate.state;
        return true;
      },
    });
    expect(restored).toBe(traversedTree);
  });

  it("gives a restored snapshot to the entry a layout effect pushes from", () => {
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 0,
      }),
    });
    controller.rememberHistoryStateSnapshot(createRouterState({ routeId: "route:/a" }));
    const firstEntryState = store.state;
    controller.commitNavigationHistory({
      activeRoutePaths: [],
      bfcacheIds: {},
      href: "/b",
      historyUpdateMode: "push",
      previousNextUrl: null,
      stageClientParams: vi.fn(),
    });
    controller.rememberHistoryStateSnapshot(createRouterState({ routeId: "route:/b" }));

    // Back restores the first entry's snapshot synchronously. A layout effect
    // pushes from it before the root remembers the restored tree.
    store.setState(firstEntryState);
    expect(
      controller.restoreHistorySnapshot({
        historyState: firstEntryState,
        stageClientParams: vi.fn(),
        approveVisibleRestore: (candidate) => {
          candidate.beforeCommit();
          return true;
        },
      }),
    ).toBe(true);
    store.pushHistoryState(
      createExternalHistoryStatePreservingMetadata({}, firstEntryState),
      "/a?f=1",
    );
    controller.claimCurrentHistoryTreeSnapshot("push", firstEntryState);
    const restoredTree = createRouterState({ routeId: "route:/a", renderId: 2 });
    controller.rememberHistoryStateSnapshot(restoredTree);
    const pushedEntryState = store.state;
    controller.commitNavigationHistory({
      activeRoutePaths: [],
      bfcacheIds: {},
      href: "/c",
      historyUpdateMode: "push",
      previousNextUrl: null,
      stageClientParams: vi.fn(),
    });
    controller.rememberHistoryStateSnapshot(createRouterState({ routeId: "route:/c" }));

    let restored: AppRouterState | null = null;
    controller.restoreHistorySnapshot({
      historyState: pushedEntryState,
      preferExternalSnapshot: true,
      stageClientParams: vi.fn(),
      approveVisibleRestore: (candidate) => {
        restored = candidate.state;
        return true;
      },
    });
    expect(restored).toBe(restoredTree);
  });

  it("refetches an external entry sharing the index of a router entry a raw push copied", () => {
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 0,
      }),
    });
    const navigate = (href: string, routeId: string) => {
      controller.commitNavigationHistory({
        activeRoutePaths: [],
        bfcacheIds: {},
        href,
        historyUpdateMode: "push",
        previousNextUrl: null,
        stageClientParams: vi.fn(),
      });
      controller.rememberHistoryStateSnapshot(createRouterState({ routeId }));
    };
    controller.rememberHistoryStateSnapshot(createRouterState({ routeId: "route:/" }));

    // A layout effect on /a captures the router entry's state and pushes from
    // it before the root remembers the /a tree.
    controller.commitNavigationHistory({
      activeRoutePaths: [],
      bfcacheIds: {},
      href: "/a",
      historyUpdateMode: "push",
      previousNextUrl: null,
      stageClientParams: vi.fn(),
    });
    const capturedRouterEntryState = store.state;
    store.pushHistoryState(
      createExternalHistoryStatePreservingMetadata({}, capturedRouterEntryState),
      "/a?f=1",
    );
    controller.claimCurrentHistoryTreeSnapshot("push", capturedRouterEntryState);
    controller.rememberHistoryStateSnapshot(createRouterState({ routeId: "route:/a" }));
    navigate("/c", "route:/c");

    // The app replays the captured state, then replaces it with its own, which
    // leaves an external entry sharing the router entry's index.
    const visibleState = store.state;
    store.pushHistoryState(capturedRouterEntryState, "/x");
    controller.commitAppOwnedHistoryStateWrite("push", visibleState);
    const replayedState = store.state;
    store.replaceHistoryState(
      createExternalHistoryStatePreservingMetadata({ foo: 1 }, replayedState),
      "/y",
    );
    controller.claimCurrentHistoryTreeSnapshot("replace", replayedState);
    const externalEntryState = store.state;
    expect(readHistoryStateTraversalIndex(externalEntryState)).toBe(
      readHistoryStateTraversalIndex(capturedRouterEntryState),
    );
    navigate("/d", "route:/d");

    const approveVisibleRestore = vi.fn(() => true);
    expect(
      controller.restoreHistorySnapshot({
        historyState: externalEntryState,
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore,
      }),
    ).toBe(false);
    expect(approveVisibleRestore).not.toHaveBeenCalled();
  });

  it("gives the hydrated tree to the entry a layout effect copies during hydration", () => {
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 0,
      }),
    });
    const initialEntryState = store.state;
    store.pushHistoryState(
      createExternalHistoryStatePreservingMetadata({}, initialEntryState),
      "/a?f=1",
    );
    controller.claimCurrentHistoryTreeSnapshot("push", initialEntryState);
    const hydratedTree = createRouterState();
    controller.rememberHistoryStateSnapshot(hydratedTree);
    controller.writeHydratedHistoryMetadata({
      activeRoutePaths: [],
      bfcacheIds: {},
      previousNextUrl: null,
    });
    expect(readHistoryStateTraversalIndex(store.state)).toBe(1);

    // The copied entry keeps the hydrated tree after a later navigation.
    controller.commitNavigationHistory({
      activeRoutePaths: [],
      bfcacheIds: {},
      href: "/b",
      historyUpdateMode: "push",
      previousNextUrl: null,
      stageClientParams: vi.fn(),
    });
    controller.rememberHistoryStateSnapshot(createRouterState({ renderId: 2 }));
    let restored: AppRouterState | null = null;
    controller.restoreHistorySnapshot({
      historyState: initialEntryState,
      stageClientParams: vi.fn(),
      approveVisibleRestore: (candidate) => {
        restored = candidate.state;
        return true;
      },
    });
    expect(restored).toBe(hydratedTree);
  });

  it("does not give a later navigation's tree to an entry whose tree was released", () => {
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 0,
      }),
    });
    const navigate = (href: string, routeId: string) => {
      controller.commitNavigationHistory({
        activeRoutePaths: [],
        bfcacheIds: {},
        href,
        historyUpdateMode: "push",
        previousNextUrl: null,
        stageClientParams: vi.fn(),
      });
      controller.rememberHistoryStateSnapshot(createRouterState({ routeId }));
    };
    const initialTree = createRouterState({ routeId: "route:/a" });
    controller.rememberHistoryStateSnapshot(initialTree);
    const firstEntryState = store.state;
    navigate("/b", "route:/b");
    navigate("/a", "route:/a");

    // go(-2) back to the first /a entry commits its URL without a render, so
    // the entry keeps naming its released tree. A raw shallow push follows.
    store.setState(firstEntryState);
    controller.commitTraversalIndexFromHistoryState(firstEntryState);
    store.pushHistoryState(
      createExternalHistoryStatePreservingMetadata({}, firstEntryState),
      "/a?f=1",
    );
    controller.claimCurrentHistoryTreeSnapshot("push", firstEntryState);
    const pushedEntryState = store.state;
    navigate("/c", "route:/c");

    const restore = (historyState: unknown, preferExternalSnapshot: boolean) => {
      let restored: AppRouterState | null = null;
      controller.restoreHistorySnapshot({
        historyState,
        preferExternalSnapshot,
        stageClientParams: vi.fn(),
        approveVisibleRestore: (candidate) => {
          restored = candidate.state;
          return true;
        },
      });
      return restored;
    };
    expect(restore(firstEntryState, false)).toBe(initialTree);
    // The pushed entry copied the released tree id and never rendered a tree
    // of its own, so it refetches rather than restoring another entry's tree.
    expect(restore(pushedEntryState, true)).toBeNull();
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
        { __vinext_externalHistoryState: true, __vinext_treeSnapshotId: "doc:7" },
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
    expect(readHistoryStateTreeSnapshotId(writtenState)).toBe("doc:7");
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

  it("restores the completed tree for entries that remembered an optimistic shell", () => {
    // Next.js shares one tree between an optimistic shell and the data that
    // fills it in, so going back to the shell's entry after a shallow history
    // write shows the full page.
    const { controller, store } = createController();
    const createOperation = (navigationCommitKind: "authoritative" | "detached") => ({
      id: 1,
      lane: "navigation" as const,
      navigationCommitKind,
      navigationId: 3,
      startedVisibleCommitVersion: 0,
      state: "committed" as const,
      visibleCommitVersion: 1,
    });
    const navigationSnapshot = createClientNavigationRenderSnapshot(
      "https://example.com/slow/2",
      {},
    );
    const shellState = createRouterState({
      activeOperation: createOperation("detached"),
      navigationSnapshot,
      routeId: "route:/slow/[id]",
    });
    seedSnapshotAtIndex(controller, 1, shellState);
    // A raw pushState copies the shell's tree onto a new entry.
    controller.claimCurrentHistoryTreeSnapshot("push", store.state);
    expect(controller.currentHistoryTraversalIndex).toBe(2);

    const completedState = createRouterState({
      activeOperation: createOperation("authoritative"),
      navigationSnapshot,
      routeId: "route:/slow/[id]",
    });
    controller.rememberHistoryStateSnapshot(completedState);

    const approveVisibleRestore = vi.fn((candidate: RestorableSnapshotCandidate) => {
      candidate.beforeCommit();
      return true;
    });
    for (const historyState of [
      createHistoryStateWithNavigationMetadata(null, { previousNextUrl: null, traversalIndex: 1 }),
      store.state,
    ]) {
      expect(
        controller.restoreHistorySnapshot({
          historyState,
          stageClientParams: vi.fn(),
          approveVisibleRestore,
        }),
      ).toBe(true);
    }
    expect(approveVisibleRestore.mock.calls.map(([candidate]) => candidate.state)).toEqual([
      completedState,
      completedState,
    ]);
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
    const overwrittenTreeSnapshotIds: Array<string | null> = [];
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
    const truncatedTreeSnapshotIds: Array<string | null> = [];

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

  it("refetches an external entry whose released tree's index another entry reused", () => {
    const { controller, store } = createController({
      initialState: createHistoryStateWithNavigationMetadata(null, {
        previousNextUrl: null,
        traversalIndex: 0,
      }),
    });
    controller.rememberHistoryStateSnapshot(createRouterState({ routeId: "route:/" }));
    const firstEntryState = store.state;

    // An app-owned replay copies the first entry, index and tree id included,
    // and a raw replace then makes that copy an external entry at index 0.
    store.pushHistoryState({ ...(firstEntryState as object) }, "/n");
    controller.commitAppOwnedHistoryStateWrite("push", firstEntryState);
    const copiedEntryState = store.state;
    store.replaceHistoryState(
      createExternalHistoryStatePreservingMetadata({ foo: 1 }, copiedEntryState),
      "/n2",
    );
    controller.claimCurrentHistoryTreeSnapshot("replace", copiedEntryState);
    const externalEntryState = store.state;
    expect(readHistoryStateTraversalIndex(externalEntryState)).toBe(0);

    // Back on the first entry, a router replace releases the claim at index 0
    // and stores another route's tree there.
    store.setState(firstEntryState);
    controller.commitTraversalIndexFromHistoryState(firstEntryState);
    controller.commitNavigationHistory({
      activeRoutePaths: [],
      bfcacheIds: {},
      href: "/d",
      historyUpdateMode: "replace",
      previousNextUrl: null,
      stageClientParams: vi.fn(),
    });
    controller.rememberHistoryStateSnapshot(createRouterState({ routeId: "route:/d" }));

    const approveVisibleRestore = vi.fn(() => true);
    expect(
      controller.restoreHistorySnapshot({
        historyState: externalEntryState,
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore,
      }),
    ).toBe(false);
    expect(approveVisibleRestore).not.toHaveBeenCalled();
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

  it("does not resolve a copied tree id that an earlier document wrote", () => {
    // History state survives a reload, but the trees its ids name do not.
    const firstDocument = createController();
    seedSnapshotAtIndex(
      firstDocument.controller,
      0,
      createRouterState({ routeId: "route:/shallow-test" }),
    );
    firstDocument.controller.claimCurrentHistoryTreeSnapshot("replace", firstDocument.store.state);
    const copiedHistoryState = firstDocument.store.state;
    expect(readHistoryStateTreeSnapshotId(copiedHistoryState)).not.toBeNull();

    const reloadedDocument = createController();
    seedSnapshotAtIndex(
      reloadedDocument.controller,
      1,
      createRouterState({ routeId: "route:/about" }),
    );

    expect(reloadedDocument.controller.isCurrentExternalHistoryTree(copiedHistoryState)).toBe(
      false,
    );
    const approveVisibleRestore = vi.fn(() => true);
    expect(
      reloadedDocument.controller.restoreHistorySnapshot({
        historyState: copiedHistoryState,
        preferExternalSnapshot: true,
        stageClientParams: vi.fn(),
        approveVisibleRestore,
      }),
    ).toBe(false);
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
