import { describe, expect, it, vi } from "vite-plus/test";
import {
  createLinkSegmentPrefetchScheduler,
  type LinkSegmentPrefetchInstance,
  type LinkSegmentPrefetchPhaseRequest,
} from "../packages/vinext/src/shims/internal/link-segment-prefetch-scheduler.js";

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function createDeferred(): Deferred {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (resolve === undefined) throw new Error("Expected a deferred resolver");
  return { promise, resolve };
}

async function flushScheduler(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function createInstance(
  href: string,
  fetchStrategy: LinkSegmentPrefetchInstance["fetchStrategy"] = "auto",
): LinkSegmentPrefetchInstance {
  return { fetchStrategy, href, isVisible: true };
}

function createHarness() {
  const deferred: Deferred[] = [];
  const requests: LinkSegmentPrefetchPhaseRequest[] = [];
  const runPhase = vi.fn((request: LinkSegmentPrefetchPhaseRequest) => {
    requests.push({ ...request });
    const result = createDeferred();
    deferred.push(result);
    return result.promise;
  });
  return {
    deferred,
    requests,
    runPhase,
    scheduler: createLinkSegmentPrefetchScheduler({ runPhase }),
  };
}

describe("Cache Components Link prefetch scheduling", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/prefetch-scheduling/prefetch-scheduling.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/prefetch-scheduling/prefetch-scheduling.test.ts
  it("raises hovered viewport tasks and preserves most-recent-first segment order", async () => {
    const { deferred, requests, scheduler } = createHarness();
    const page2 = createInstance("/cancellation/2");
    const page4 = createInstance("/cancellation/4");
    const page5 = createInstance("/cancellation/5");

    scheduler.schedule(page2, "default");
    scheduler.schedule(page4, "default");
    scheduler.schedule(page5, "default");
    await flushScheduler();

    scheduler.schedule(page2, "intent");
    scheduler.schedule(page5, "intent");
    for (const request of deferred.splice(0)) request.resolve();
    await flushScheduler();

    expect(
      requests.slice(3).map(({ href, phase, priority }) => ({ href, phase, priority })),
    ).toEqual([
      { href: "/cancellation/5", phase: "segment", priority: "intent" },
      { href: "/cancellation/2", phase: "segment", priority: "default" },
    ]);

    deferred.shift()?.resolve();
    await flushScheduler();
    expect(requests).toHaveLength(5);

    deferred.shift()?.resolve();
    await flushScheduler();
    expect(requests.at(-1)).toMatchObject({
      href: "/cancellation/4",
      phase: "segment",
      priority: "default",
    });
  });

  it("reserves bandwidth only for the most recently hovered task", async () => {
    const { deferred, requests, scheduler } = createHarness();
    const initial = Array.from({ length: 4 }, (_, index) =>
      createInstance(`/cancellation/${index + 4}`),
    );
    const page2 = createInstance("/cancellation/2");
    const page3 = createInstance("/cancellation/3");

    for (const instance of initial) scheduler.schedule(instance, "default");
    await flushScheduler();
    expect(requests).toHaveLength(4);

    scheduler.schedule(page2, "default");
    scheduler.schedule(page3, "default");
    await flushScheduler();
    expect(requests).toHaveLength(4);

    scheduler.schedule(page2, "intent");
    await flushScheduler();
    scheduler.schedule(page3, "intent");
    await flushScheduler();
    expect(requests.slice(4).map(({ href, phase }) => ({ href, phase }))).toEqual([
      { href: "/cancellation/2", phase: "route-tree" },
      { href: "/cancellation/3", phase: "route-tree" },
    ]);

    deferred[4]?.resolve();
    deferred[5]?.resolve();
    await flushScheduler();

    expect(requests.at(-1)).toMatchObject({
      href: "/cancellation/3",
      phase: "segment",
      priority: "intent",
    });
    expect(
      requests.some((request) => request.href === "/cancellation/2" && request.phase === "segment"),
    ).toBe(false);
  });

  it("finishes older visibility-batch route trees before newly revealed links", async () => {
    const { deferred, requests, scheduler } = createHarness();
    const olderBatch = scheduler.createBatch();
    const newerBatch = scheduler.createBatch();
    const older = Array.from({ length: 5 }, (_, index) =>
      createInstance(`/cancellation/${index + 1}`),
    );
    const page8 = createInstance("/cancellation/8");

    for (const instance of older) scheduler.schedule(instance, "default", olderBatch);
    scheduler.schedule(page8, "default", newerBatch);
    await flushScheduler();

    expect(requests).toHaveLength(4);
    expect(requests.some((request) => request.href === "/cancellation/8")).toBe(false);

    deferred.shift()?.resolve();
    await flushScheduler();

    expect(requests.at(-1)).toMatchObject({
      href: "/cancellation/1",
      phase: "route-tree",
    });
    expect(requests.some((request) => request.href === "/cancellation/8")).toBe(false);
  });

  it("applies shared viewport bandwidth to full-prefetch links without changing strategy", async () => {
    const { deferred, requests, scheduler } = createHarness();
    const instances = Array.from({ length: 5 }, (_, index) =>
      createInstance(`/full/${index + 1}`, "full"),
    );

    for (const instance of instances) scheduler.schedule(instance, "default");
    await flushScheduler();

    expect(requests).toHaveLength(4);
    expect(requests).toEqual(
      expect.arrayContaining(
        instances.slice(0, 4).map((instance) =>
          expect.objectContaining({
            fetchStrategy: "full",
            href: instance.href,
            phase: "route-tree",
            priority: "default",
          }),
        ),
      ),
    );

    deferred.shift()?.resolve();
    await flushScheduler();
    expect(requests.at(-1)).toMatchObject({
      fetchStrategy: "full",
      href: "/full/5",
      phase: "route-tree",
      priority: "default",
    });

    deferred.at(-1)?.resolve();
    await flushScheduler();
    expect(requests.at(-1)).toMatchObject({
      fetchStrategy: "full",
      href: "/full/5",
      phase: "segment",
      priority: "default",
    });
  });

  it("gives dynamic-on-hover upgrades intent bandwidth and preserves their full strategy", async () => {
    const { deferred, requests, scheduler } = createHarness();
    const blocking = Array.from({ length: 4 }, (_, index) =>
      createInstance(`/blocking/${index + 1}`),
    );
    const dynamic = createInstance("/blog/hello");

    for (const instance of blocking) scheduler.schedule(instance, "default");
    scheduler.schedule(dynamic, "default");
    await flushScheduler();
    expect(requests).toHaveLength(4);

    dynamic.fetchStrategy = "full-after-shell";
    scheduler.schedule(dynamic, "intent");
    await flushScheduler();
    expect(requests.at(-1)).toMatchObject({
      fetchStrategy: "full-after-shell",
      href: "/blog/hello",
      phase: "route-tree",
      priority: "intent",
    });

    deferred.at(-1)?.resolve();
    await flushScheduler();
    expect(requests.at(-1)).toMatchObject({
      fetchStrategy: "full-after-shell",
      href: "/blog/hello",
      phase: "segment",
      priority: "intent",
    });
  });

  it("forces segment fetches for viewport work scheduled after user interaction", async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: () => void) => {
        listeners.set(type, listener);
      }),
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);

    try {
      const { deferred, requests, scheduler } = createHarness();
      scheduler.registerUserInteractionListeners();
      listeners.get("pointerdown")?.();

      scheduler.schedule(createInstance("/cancellation/8"), "default");
      await flushScheduler();
      expect(requests[0]).toMatchObject({
        forceSegmentCacheFetch: true,
        href: "/cancellation/8",
        phase: "route-tree",
      });

      deferred.shift()?.resolve();
      await flushScheduler();
      expect(requests[1]).toMatchObject({
        forceSegmentCacheFetch: true,
        href: "/cancellation/8",
        phase: "segment",
      });

      deferred.shift()?.resolve();
      await flushScheduler();

      scheduler.schedule(createInstance("/rewrite-to-dynamic", "full"), "default");
      await flushScheduler();
      expect(requests[2]).toMatchObject({
        forceSegmentCacheFetch: false,
        href: "/rewrite-to-dynamic",
        phase: "route-tree",
      });

      deferred.shift()?.resolve();
      await flushScheduler();
      expect(requests[3]).toMatchObject({
        forceSegmentCacheFetch: false,
        href: "/rewrite-to-dynamic",
        phase: "segment",
      });
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("cancels queued and running viewport tasks before the segment phase", async () => {
    const { deferred, requests, scheduler } = createHarness();
    const instances = Array.from({ length: 7 }, (_, index) =>
      createInstance(`/cancellation/${index + 1}`),
    );

    for (const instance of instances) scheduler.schedule(instance, "default");
    await flushScheduler();
    expect(requests).toHaveLength(4);

    for (const instance of instances) {
      instance.isVisible = false;
      scheduler.cancel(instance);
    }
    for (const request of deferred.splice(0)) request.resolve();
    await flushScheduler();

    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.phase === "route-tree")).toBe(true);
  });

  it("reschedules a canceled task when its Link re-enters the viewport", async () => {
    const { deferred, requests, scheduler } = createHarness();
    const instance = createInstance("/cancellation/5");

    scheduler.schedule(instance, "default");
    await flushScheduler();
    instance.isVisible = false;
    scheduler.cancel(instance);
    deferred.shift()?.resolve();
    await flushScheduler();
    expect(requests).toHaveLength(1);

    instance.isVisible = true;
    scheduler.schedule(instance, "default");
    await flushScheduler();
    expect(requests.at(-1)).toMatchObject({ phase: "route-tree" });

    deferred.shift()?.resolve();
    await flushScheduler();
    expect(requests.at(-1)).toMatchObject({
      href: "/cancellation/5",
      phase: "segment",
      priority: "default",
    });
  });
});
