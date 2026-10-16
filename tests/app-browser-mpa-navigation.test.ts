import { describe, expect, it, vi } from "vite-plus/test";
import {
  AppBrowserMpaNavigationScheduler,
  hasPendingAppRouterPageRedirect,
  type AppBrowserMpaNavigationWindow,
} from "../packages/vinext/src/server/app-browser-mpa-navigation.js";

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
  it("keeps the first navigation's history mode for a later navigation to the same href", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, replace, targetWindow, timeoutCount } =
      createNavigationWindow();

    scheduler.navigate(targetWindow, "https://external.test/login", "push");
    scheduler.navigate(targetWindow, "https://external.test/login", "replace");

    expect(timeoutCount()).toBe(1);

    flushNextTimeout();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://external.test/login");

    scheduler.navigate(targetWindow, "https://external.test/login", "replace");
    expect(timeoutCount()).toBe(0);
    expect(replace).not.toHaveBeenCalled();
  });

  it("navigates only to the latest href when a navigation supersedes a pending one", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, targetWindow } = createNavigationWindow();

    scheduler.navigate(targetWindow, "/first", "push");
    scheduler.navigate(targetWindow, "/second", "push");

    flushNextTimeout();
    flushNextTimeout();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/second");
  });

  it("drops a pending navigation when reset before it fires", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, replace, targetWindow } = createNavigationWindow();

    scheduler.navigate(targetWindow, "/login", "push");
    scheduler.reset();

    flushNextTimeout();
    expect(assign).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
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

  it("waits for a frame before navigating a visible document", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, flushNextTimeout, targetWindow, timeoutCount } = createNavigationWindow();
    const frames: FrameRequestCallback[] = [];

    scheduler.navigate(
      {
        ...targetWindow,
        document: { visibilityState: "visible" },
        requestAnimationFrame(callback) {
          frames.push(callback);
          return frames.length;
        },
      },
      "/login",
      "push",
    );

    expect(timeoutCount()).toBe(0);
    frames.shift()?.(0);
    flushNextTimeout();
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("navigates a hidden document without waiting for a frame or timer", () => {
    const scheduler = new AppBrowserMpaNavigationScheduler();
    const { assign, targetWindow, timeoutCount } = createNavigationWindow();
    const requestAnimationFrame = vi.fn();
    const hiddenWindow = {
      ...targetWindow,
      document: { visibilityState: "hidden" as const },
      requestAnimationFrame,
    };

    scheduler.navigate(hiddenWindow, "/login", "push");
    scheduler.navigate(hiddenWindow, "/login", "push");

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(timeoutCount()).toBe(0);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login");
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
