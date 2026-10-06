import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  shouldYieldBeforePreparedPrefetchCommit,
  waitForNextPaint,
} from "../packages/vinext/src/server/app-browser-paint-yield.js";

type TestDocument = EventTarget & { visibilityState: DocumentVisibilityState };

function stubDocument(visibilityState: DocumentVisibilityState): TestDocument {
  const doc = Object.assign(new EventTarget(), { visibilityState });
  vi.stubGlobal("document", doc);
  return doc;
}

function stubAnimationFrames(): { flush: () => void; pending: () => number } {
  let callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    callbacks.delete(handle);
  });
  return {
    flush() {
      const queued = callbacks;
      callbacks = new Map();
      for (const callback of queued.values()) callback(0);
    },
    pending: () => callbacks.size,
  };
}

function track(promise: Promise<void>): { settled: () => boolean } {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  return { settled: () => settled };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldYieldBeforePreparedPrefetchCommit", () => {
  it("yields only for ordinary navigations upgraded to a synchronous commit", () => {
    expect(
      shouldYieldBeforePreparedPrefetchCommit({
        hasPreparedElements: true,
        navigationKind: "navigate",
        visibleCommitMode: "transition",
      }),
    ).toBe(true);
  });

  it("does not yield without prepared prefetch elements", () => {
    expect(
      shouldYieldBeforePreparedPrefetchCommit({
        hasPreparedElements: false,
        navigationKind: "navigate",
        visibleCommitMode: "transition",
      }),
    ).toBe(false);
  });

  it("keeps traversals committing without a yield so scroll restoration stays in step", () => {
    expect(
      shouldYieldBeforePreparedPrefetchCommit({
        hasPreparedElements: true,
        navigationKind: "traverse",
        visibleCommitMode: "transition",
      }),
    ).toBe(false);
    expect(
      shouldYieldBeforePreparedPrefetchCommit({
        hasPreparedElements: true,
        navigationKind: "refresh",
        visibleCommitMode: "transition",
      }),
    ).toBe(false);
  });

  it("leaves explicitly synchronous (gesture) commits on their own timing", () => {
    expect(
      shouldYieldBeforePreparedPrefetchCommit({
        hasPreparedElements: true,
        navigationKind: "navigate",
        visibleCommitMode: "synchronous",
      }),
    ).toBe(false);
  });
});

describe("waitForNextPaint", () => {
  it("resolves without a frame when requestAnimationFrame is unavailable", async () => {
    stubDocument("visible");
    vi.stubGlobal("requestAnimationFrame", undefined);

    const wait = track(waitForNextPaint());
    await flushMicrotasks();

    expect(wait.settled()).toBe(true);
  });

  it("resolves without a frame when the document is hidden", async () => {
    stubDocument("hidden");
    const frames = stubAnimationFrames();

    const wait = track(waitForNextPaint());
    await flushMicrotasks();

    expect(wait.settled()).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  it("resolves in a task after the next animation frame, not inside it", async () => {
    stubDocument("visible");
    const frames = stubAnimationFrames();

    const promise = waitForNextPaint();
    const wait = track(promise);
    await nextMacrotask();
    expect(wait.settled()).toBe(false);
    expect(frames.pending()).toBe(1);

    frames.flush();
    await flushMicrotasks();
    // The frame callback runs before paint; the commit must wait for the task
    // queued from it.
    expect(wait.settled()).toBe(false);

    await promise;
  });

  it("completes through the frame even when test timers never fire", async () => {
    stubDocument("visible");
    const frames = stubAnimationFrames();
    const setTimeoutSpy = vi.fn(() => 1);
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("clearTimeout", clearTimeoutSpy);

    const wait = waitForNextPaint();
    frames.flush();
    await wait;

    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
  });

  it("stops waiting when a visible document produces no frame", async () => {
    stubDocument("visible");
    const frames = stubAnimationFrames();
    let fireTimeout: (() => void) | undefined;
    const setTimeoutSpy = vi.fn((callback: () => void) => {
      fireTimeout = callback;
      return 1;
    });
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("clearTimeout", vi.fn());

    const wait = track(waitForNextPaint());
    await nextMacrotask();
    expect(wait.settled()).toBe(false);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);

    // Offscreen cross-origin iframes stay "visible" but get no frames.
    fireTimeout?.();
    await flushMicrotasks();

    expect(wait.settled()).toBe(true);
    // The queued frame is cancelled so it does not outlive the wait.
    expect(frames.pending()).toBe(0);
  });

  it("stops waiting when the document is hidden before the frame arrives", async () => {
    const doc = stubDocument("visible");
    const frames = stubAnimationFrames();

    const wait = track(waitForNextPaint());
    await nextMacrotask();
    expect(wait.settled()).toBe(false);

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();

    expect(wait.settled()).toBe(true);
    expect(frames.pending()).toBe(0);
  });
});
