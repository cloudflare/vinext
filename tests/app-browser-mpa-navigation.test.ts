import { describe, expect, it, vi } from "vite-plus/test";
import {
  AppBrowserMpaNavigationScheduler,
  hasPendingAppRouterPageRedirect,
  observeDocumentNavigationCancellation,
  type AppBrowserMpaNavigationWindow,
} from "../packages/vinext/src/server/app-browser-mpa-navigation.js";

import { performHardNavigationWithLoopGuard } from "../packages/vinext/src/server/app-browser-navigation-controller.js";

function createNavigationWindow(): {
  assign: ReturnType<typeof vi.fn>;
  flushNextTimeout: () => void;
  replace: ReturnType<typeof vi.fn>;
  targetWindow: AppBrowserMpaNavigationWindow;
  timeoutCount: () => number;
} {
  const assign = vi.fn();
  const replace = vi.fn();
  const timeouts: Array<() => void> = [];
  const targetWindow = {
    location: { assign, replace },
    setTimeout(callback: () => void) {
      timeouts.push(callback);
      return timeouts.length;
    },
  } satisfies AppBrowserMpaNavigationWindow;

  return {
    assign,
    flushNextTimeout() {
      const callback = timeouts.shift();
      if (!callback) throw new Error("Expected a pending navigation timeout");
      callback();
    },
    replace,
    targetWindow,
    timeoutCount() {
      return timeouts.length;
    },
  };
}

describe("hasPendingAppRouterPageRedirect", () => {
  it("treats a missing document as no pending redirect marker", () => {
    expect(hasPendingAppRouterPageRedirect(undefined)).toBe(false);
  });

  it("treats a partial document without DOM lookup support as no pending redirect marker", () => {
    expect(hasPendingAppRouterPageRedirect({ createElement: vi.fn() })).toBe(false);
  });

  it("detects Next.js's streamed redirect marker", () => {
    expect(
      hasPendingAppRouterPageRedirect({
        getElementById(id: string) {
          return id === "__next-page-redirect" ? { id } : null;
        },
      }),
    ).toBe(true);
  });

  it("does not classify unrelated elements as page redirect markers", () => {
    expect(
      hasPendingAppRouterPageRedirect({
        getElementById() {
          return null;
        },
      }),
    ).toBe(false);
  });
});

describe("AppBrowserMpaNavigationScheduler", () => {
  it("supersedes a pending same-href push with a replace before the delayed navigation fires", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, replace, targetWindow, timeoutCount } =
      createNavigationWindow();

    scheduler.navigate(targetWindow, "https://external.test/login", "push");
    scheduler.navigate(targetWindow, "https://external.test/login", "replace");

    expect(timeoutCount()).toBe(2);

    flushNextTimeout();
    expect(assign).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    flushNextTimeout();
    expect(assign).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("https://external.test/login");
  });

  it("dedupes an identical pending external navigation", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { flushNextTimeout, replace, targetWindow, timeoutCount } = createNavigationWindow();

    scheduler.navigate(targetWindow, "https://external.test/login", "replace");
    scheduler.navigate(targetWindow, "https://external.test/login", "replace");

    expect(timeoutCount()).toBe(1);

    flushNextTimeout();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("recovers when the scheduled location mutation throws", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, targetWindow } = createNavigationWindow();
    const recover = vi.fn();
    const error = new DOMException("Navigation blocked", "SecurityError");
    assign.mockImplementation(() => {
      throw error;
    });
    scheduler.navigate(targetWindow, "https://example.com/target", "push", () => recover);
    expect(flushNextTimeout).toThrow(error);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("keeps the live cancellation observer when the same MPA render repeats", async () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, targetWindow } = createNavigationWindow();
    const navigation = new EventTarget();
    const attempt = new AbortController();
    const recover = vi.fn();
    const href = "https://example.com/target";
    const arm = vi.fn(() => observeDocumentNavigationCancellation(navigation, href, recover));
    assign.mockImplementation(() =>
      navigation.dispatchEvent(
        Object.assign(new Event("navigate"), {
          destination: { url: href, sameDocument: false },
          signal: attempt.signal,
        }),
      ),
    );
    scheduler.navigate(targetWindow, href, "push", arm);
    expect(arm).not.toHaveBeenCalled();
    flushNextTimeout();
    scheduler.navigate(targetWindow, href, "push", arm);
    expect(arm).toHaveBeenCalledOnce();
    attempt.abort();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("allows the same external navigation again after reset", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, targetWindow } = createNavigationWindow();

    scheduler.navigate(targetWindow, "https://external.test/login", "push");
    flushNextTimeout();
    expect(assign).toHaveBeenCalledTimes(1);

    scheduler.reset();

    scheduler.navigate(targetWindow, "https://external.test/login", "push");
    flushNextTimeout();
    expect(assign).toHaveBeenCalledTimes(2);
  });
});

describe("document navigation cancellation", () => {
  const href = "https://example.com/target";
  function navigate(
    navigation: EventTarget,
    url = href,
    sameDocument = false,
    controller = new AbortController(),
  ) {
    navigation.dispatchEvent(
      Object.assign(new Event("navigate"), {
        destination: { url, sameDocument },
        signal: controller.signal,
      }),
    );
    return controller;
  }

  it("recovers only after the owned attempt aborts and the call unwinds", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    observeDocumentNavigationCancellation(navigation, href, recover);
    const attempt = navigate(navigation);
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    attempt.abort();
    expect(recover).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it.each(["new navigation", "pagehide or router operation"])(
    "ignores an abort superseded by %s",
    async (superseding) => {
      const navigation = new EventTarget();
      const recover = vi.fn();
      const reset = observeDocumentNavigationCancellation(navigation, href, recover);
      const attempt = navigate(navigation);
      attempt.abort();
      if (superseding === "new navigation") navigate(navigation, "https://example.com/newer");
      else reset();
      await Promise.resolve();
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it("recovers an owned abort superseded by a raw hash navigation", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation).abort();
    navigate(navigation, "https://example.com/source#resumed", true);
    expect(recover).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("keeps recovery invalidation when hash navigation is followed by another document", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation).abort();
    navigate(navigation, "https://example.com/source#resumed", true);
    navigate(navigation, "https://example.com/newer");
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([false, true])("recovers when a replacement document aborts (hash=%s)", async (hash) => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation).abort();
    if (hash) navigate(navigation, "https://example.com/source#resumed", true);
    const replacement = navigate(navigation, "https://example.com/replacement");
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    replacement.abort();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("recovers when an owned replacement finishes in the surviving document", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation).abort();
    navigate(navigation, "https://example.com/intercepted");
    navigation.dispatchEvent(new Event("navigatesuccess"));
    expect(recover).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("does not re-adopt an aborted outer document event after nested navigation", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    const outer = new AbortController();
    let latest: AbortController | undefined;
    navigation.addEventListener("navigate", (event) => {
      if ((event as Event & { destination: { url: string } }).destination.url.endsWith("/outer")) {
        outer.abort();
        latest = navigate(navigation, "https://example.com/latest");
      }
    });
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation).abort();
    navigate(navigation, "https://example.com/outer", false, outer);
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
    latest!.abort();
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("retains a replacement started before the initial event reaches the observer", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    const initial = new AbortController();
    navigation.addEventListener("navigate", (event) => {
      if ((event as Event & { destination: { url: string } }).destination.url === href) {
        initial.abort();
        navigate(navigation, "https://example.com/replacement").abort();
      }
    });
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation, href, false, initial);
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("recovers an initial document replaced by a canceled hash before observation", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    const initial = new AbortController();
    navigation.addEventListener("navigate", (event) => {
      if ((event as Event & { destination: { url: string } }).destination.url === href) {
        initial.abort();
        navigate(navigation, "https://example.com/source#canceled", true).abort();
      }
    });
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation, href, false, initial);
    await Promise.resolve();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("does not claim an unrelated document navigation", async () => {
    const navigation = new EventTarget();
    const recover = vi.fn();
    observeDocumentNavigationCancellation(navigation, href, recover);
    navigate(navigation, "https://example.com/unrelated").abort();
    await Promise.resolve();
    expect(recover).not.toHaveBeenCalled();
  });
});

it("recovers when a guarded hard navigation throws synchronously", () => {
  const storage = new Map<string, string>();
  const recover = vi.fn();
  const error = new DOMException("Navigation blocked", "SecurityError");
  vi.stubGlobal("window", {
    location: {
      href: "https://example.com/source",
      assign() {
        throw error;
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  try {
    expect(() =>
      performHardNavigationWithLoopGuard("https://example.com/target", "assign", () => recover),
    ).toThrow(error);
    expect(recover).toHaveBeenCalledOnce();
    expect(storage.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
