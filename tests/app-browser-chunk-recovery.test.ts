import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DOCUMENT_UNLOAD_TIMEOUT_MS,
  toDocumentLoadHref,
} from "../packages/vinext/src/client/chunk-load-recovery.js";
import {
  createAppBrowserChunkRecovery,
  createRootErrorRecovery,
  type InFlightNavigation,
} from "../packages/vinext/src/server/app-browser-chunk-recovery.js";
import { createAppBrowserDocumentNavigation } from "../packages/vinext/src/server/app-browser-document-navigation.js";
import { createProdOnCaughtError } from "../packages/vinext/src/server/app-browser-error.js";
import {
  clearHardNavigationLoopGuard,
  performHardNavigationWithLoopGuard,
} from "../packages/vinext/src/server/app-browser-navigation-controller.js";

const STATE_KEY = Symbol.for("vinext.chunk-recovery");
const LOOP_GUARD_KEY = "__vinext_hard_navigation_target__";
const PAGE = "https://example.com/page";
const OTHER = "https://example.com/other";

type Outcome = { onAbandoned: () => void; onCanceled: () => void };

function navigationOf(
  overrides: Partial<InFlightNavigation> & Pick<InFlightNavigation, "historyUpdateMode">,
): InFlightNavigation {
  return { href: OTHER, navId: 1, ...overrides };
}

function createHarness(currentHref: string, options: { silent?: boolean } = {}) {
  const assign = vi.fn();
  const replace = vi.fn();
  const storage = new Map<string, string>();
  const location = { assign, href: currentHref, origin: new URL(currentHref).origin, replace };
  const navigation = new EventTarget();
  const attempts: AbortController[] = [];
  vi.stubGlobal("window", {
    history: { state: null },
    location,
    navigation,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });

  const dispatchNavigate = (url: string) => {
    if (options.silent) return;
    const attempt = new AbortController();
    attempts.push(attempt);
    navigation.dispatchEvent(
      Object.assign(new Event("navigate"), {
        destination: { sameDocument: false, url: new URL(url, currentHref).href },
        downloadRequest: null,
        signal: attempt.signal,
      }),
    );
  };
  assign.mockImplementation(dispatchNavigate);
  replace.mockImplementation(dispatchNavigate);

  const expireDocumentNavigation = vi.fn();
  const resumeAfterDocumentNavigation = vi.fn();
  const documentNavigation = createAppBrowserDocumentNavigation({
    clearHardNavigationLoopGuard,
    discardPendingNavigation: vi.fn(),
    expireDocumentNavigation,
    mpaNavigationScheduler: { navigate: vi.fn(), reset: vi.fn() },
    performHardNavigationWithLoopGuard,
    resumeAfterDocumentNavigation,
    stopRefreshes: vi.fn(),
  });
  const recovery = createAppBrowserChunkRecovery({
    beforeDocumentNavigation: documentNavigation.beforeDocumentNavigation,
    getCurrentHref: () => window.location.href,
    performHardNavigationWithLoopGuard,
    toDocumentLoadHref,
  });
  const outcome = { onAbandoned: vi.fn(), onCanceled: vi.fn() } satisfies Outcome;

  return {
    assign,
    attempts,
    documentNavigation,
    expireDocumentNavigation,
    location,
    outcome,
    recovery,
    replace,
    resumeAfterDocumentNavigation,
    storage,
  };
}

function loads(harness: ReturnType<typeof createHarness>) {
  return {
    assign: harness.assign.mock.calls.map(([href]) => href),
    replace: harness.replace.mock.calls.map(([href]) => href),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, STATE_KEY);
});

describe("app browser chunk recovery navigator", () => {
  describe("target", () => {
    it("loads the current URL in place when no navigation is recorded", () => {
      const harness = createHarness(PAGE);

      expect(harness.recovery.navigator(harness.outcome)).toBe(true);

      expect(loads(harness)).toEqual({ assign: [], replace: [PAGE] });
    });

    it("loads the recorded navigation target instead of the current URL", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [OTHER], replace: [] });
    });

    it("keeps the record when clearNavigation names a different navigation", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ navId: 2, historyUpdateMode: "push" }));

      harness.recovery.clearNavigation(1);
      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [OTHER], replace: [] });
    });

    it("falls back to the current URL once the recorded navigation is cleared", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ navId: 2, historyUpdateMode: "push" }));

      harness.recovery.clearNavigation(2);
      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: [PAGE] });
    });

    it("falls back to the current URL after discardNavigation", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));

      harness.recovery.discardNavigation();
      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: [PAGE] });
    });

    it("targets the redirect a later record names for the same navigation", () => {
      const harness = createHarness(PAGE);
      const redirected = "https://example.com/redirected?from=action";
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));
      harness.recovery.recordNavigation(
        navigationOf({ href: redirected, historyUpdateMode: "replace" }),
      );

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: [redirected] });
    });
  });

  describe("history mode", () => {
    it("assigns a pushed target so Back returns to the page the user left", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [OTHER], replace: [] });
    });

    it("replaces when the pushed URL already committed before the render failed", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));
      harness.location.href = OTHER;

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: [OTHER] });
    });

    it("treats a relative pushed target that equals the current URL as committed", () => {
      const harness = createHarness("https://example.com/other?x=1");
      harness.recovery.recordNavigation(
        navigationOf({ href: "/other?x=1", historyUpdateMode: "push" }),
      );

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: ["https://example.com/other?x=1"] });
    });

    it("replaces for a replace navigation", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "replace" }));

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: [OTHER] });
    });

    it("replaces for a traversal", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "traverse" }));

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: [OTHER] });
    });
  });

  describe("fragments", () => {
    it("drops the fragment when a pushed target differs from the current URL only by fragment", () => {
      const harness = createHarness("https://example.com/page#old");
      harness.recovery.recordNavigation(
        navigationOf({ href: "https://example.com/page#new", historyUpdateMode: "push" }),
      );

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [PAGE], replace: [] });
    });

    it("drops the fragment from the current URL when nothing is recorded", () => {
      const harness = createHarness("https://example.com/page#section");

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: [], replace: [PAGE] });
    });

    it("keeps the fragment of a target on another page", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(
        navigationOf({ href: "https://example.com/other#part", historyUpdateMode: "push" }),
      );

      harness.recovery.navigator(harness.outcome);

      expect(loads(harness)).toEqual({ assign: ["https://example.com/other#part"], replace: [] });
    });
  });

  describe("loop guard", () => {
    it("returns false and loads nothing when the guard refuses a repeated reload", () => {
      const harness = createHarness(PAGE);
      harness.storage.set(LOOP_GUARD_KEY, PAGE);

      expect(harness.recovery.navigator(harness.outcome)).toBe(false);

      expect(loads(harness)).toEqual({ assign: [], replace: [] });
      expect(harness.storage.has(LOOP_GUARD_KEY)).toBe(false);
    });

    it("leaves the document untouched when the guard cannot persist for a same-URL reload", () => {
      const harness = createHarness(PAGE);
      Object.assign(window, { sessionStorage: { getItem: () => null, setItem: () => undefined } });

      expect(harness.recovery.navigator(harness.outcome)).toBe(false);

      expect(loads(harness)).toEqual({ assign: [], replace: [] });
    });

    it("records the loaded URL in the guard after a successful start", () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));

      expect(harness.recovery.navigator(harness.outcome)).toBe(true);

      expect(harness.storage.get(LOOP_GUARD_KEY)).toBe(OTHER);
    });
  });

  describe("outcome", () => {
    it("reports a confirmed cancel as onCanceled and replays held Server Actions", async () => {
      const harness = createHarness(PAGE);
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));
      harness.recovery.navigator(harness.outcome);

      harness.attempts[0]?.abort();
      await Promise.resolve();

      expect(harness.outcome.onCanceled).toHaveBeenCalledOnce();
      expect(harness.outcome.onAbandoned).not.toHaveBeenCalled();
      expect(harness.resumeAfterDocumentNavigation).toHaveBeenCalledOnce();
      expect(harness.storage.has(LOOP_GUARD_KEY)).toBe(false);
    });

    it("reports a load that never unloads as onAbandoned and keeps the loop guard", () => {
      const harness = createHarness(PAGE, { silent: true });
      harness.recovery.recordNavigation(navigationOf({ historyUpdateMode: "push" }));
      harness.recovery.navigator(harness.outcome);

      vi.advanceTimersByTime(DOCUMENT_UNLOAD_TIMEOUT_MS);

      expect(harness.outcome.onAbandoned).toHaveBeenCalledOnce();
      expect(harness.outcome.onCanceled).not.toHaveBeenCalled();
      expect(harness.expireDocumentNavigation).toHaveBeenCalledOnce();
      expect(harness.storage.get(LOOP_GUARD_KEY)).toBe(OTHER);
    });

    it("reports neither outcome while the load is still pending", () => {
      const harness = createHarness(PAGE);
      harness.recovery.navigator(harness.outcome);

      vi.advanceTimersByTime(DOCUMENT_UNLOAD_TIMEOUT_MS - 1);

      expect(harness.outcome.onAbandoned).not.toHaveBeenCalled();
      expect(harness.outcome.onCanceled).not.toHaveBeenCalled();
    });
  });
});

describe("root error recovery", () => {
  async function setup() {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, STATE_KEY);
    const storage = new Map<string, string>();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        location: { href: PAGE },
        sessionStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const primitive = await import("../packages/vinext/src/client/chunk-load-recovery.js");
    const navigator = vi.fn((_outcome: Outcome) => true);
    primitive.setChunkRecoveryNavigator(navigator);
    primitive.registerChunkRecovery({ entryUrl: "https://example.com/assets/index-abc123.js" });
    return { navigator, primitive };
  }

  async function failedImport(primitive: Awaited<ReturnType<typeof setup>>["primitive"]) {
    const error = new Error("Failed to fetch dynamically imported module");
    const loading = primitive.loadChunk(() => Promise.reject(error), { retry: false });
    const settled = loading.catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(600);
    expect(await settled).toBe(error);
    return error;
  }

  it("starts one recovery when a caught error also reaches the uncaught callback", async () => {
    const { navigator, primitive } = await setup();
    const error = await failedImport(primitive);
    const recoverFromRootError = createRootErrorRecovery(primitive.recoverFromChunkFailure);
    const onUncaughtError = (caught: unknown) => recoverFromRootError(caught);
    const forwarding = createProdOnCaughtError(onUncaughtError);
    const onCaughtError = (caught: unknown, info: Parameters<typeof forwarding>[1]) => {
      recoverFromRootError(caught);
      forwarding(caught, info);
    };

    onCaughtError(error, { errorBoundary: { props: { isImplicitRootErrorBoundary: true } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(navigator).toHaveBeenCalledOnce();
  });

  it("swallows the rejection so a declined recovery leaves no unhandled rejection", async () => {
    const { navigator, primitive } = await setup();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      createRootErrorRecovery(primitive.recoverFromChunkFailure)(new Error("not a chunk failure"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
      expect(navigator).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("hands the error to the injected recovery", () => {
    const recover = vi.fn(() => Promise.reject(new Error("declined")));
    const error = new Error("boom");

    createRootErrorRecovery(recover)(error);

    expect(recover).toHaveBeenCalledExactlyOnceWith(error);
  });
});

// The entry runs main() at import, so its wiring is pinned from source.
describe("app browser entry chunk recovery wiring", () => {
  const source = readFileSync(
    new URL("../packages/vinext/src/server/app-browser-entry.ts", import.meta.url),
    "utf8",
  );

  it("ends immediate client-reference recovery where the first commit is recorded", () => {
    expect(source).toMatch(
      /browserRouterStateHasEverCommitted = true;\s+endImmediateClientReferenceRecovery\(\);/,
    );
  });

  it("registers the navigator once, inside bootstrapHydration", () => {
    const registration = "setChunkRecoveryNavigator(chunkRecovery.navigator);";
    const bootstrap = source.slice(
      source.indexOf("function bootstrapHydration("),
      source.indexOf('if (typeof document !== "undefined")'),
    );

    expect(source.split(registration)).toHaveLength(2);
    expect(bootstrap).toContain(registration);
  });

  it("starts a recovery from both root error callbacks", () => {
    expect(source).toMatch(
      /const onUncaughtError = [^]*?recoverFromRootError\(args\[0\]\);\s+reportUncaughtError\(\.\.\.args\);/,
    );
    expect(source).toMatch(
      /const invalidateOnCaughtError =[^]*?recoverFromRootError\(args\[0\]\);\s+handler\(\.\.\.args\);/,
    );
  });

  it("clears the in-flight record when a navigation finalizes and on every new one", () => {
    expect(source).toMatch(
      /function beginNavigation\([^]*?chunkRecovery\.discardNavigation\(\);[^]*?\n\}/,
    );
    expect(source).toMatch(
      /function finalizeNavigation\([^]*?chunkRecovery\.clearNavigation\(navId\);[^]*?\n\}/,
    );
  });

  // Sites that render a new target record it: renderRedirectPayload, and
  // navigateRsc for its first target and each redirect hop. Every other site
  // finalizes at once (same-document commits, history snapshot restores, the
  // bfcache restore) or leaves the document (navigateExternal).
  it("accounts for every beginNavigation call site", () => {
    const callSites = source.match(/(?<![.\w])beginNavigation\((?!refreshBase)/g) ?? [];

    expect(callSites).toHaveLength(6);
    expect(source.match(/chunkRecovery\.recordNavigation\(/g)).toHaveLength(2);
    expect(source.match(/recordChunkRecoveryTarget\(\);/g)).toHaveLength(3);
  });
});
