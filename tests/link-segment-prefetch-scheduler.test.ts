import { describe, expect, it, vi } from "vite-plus/test";
import {
  createLinkSegmentPrefetchScheduler,
  type LinkSegmentPrefetchInstance,
  type LinkSegmentPrefetchPhaseRequest,
} from "../packages/vinext/src/shims/internal/link-segment-prefetch-scheduler.js";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (resolve === undefined) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

async function flushScheduler(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function createInstance(href: string): LinkSegmentPrefetchInstance {
  return {
    href,
    isVisible: true,
    pagesRouteHref: undefined,
  };
}

function createSchedulerHarness() {
  const requests: LinkSegmentPrefetchPhaseRequest[] = [];
  const deferredRequests: Array<ReturnType<typeof createDeferred>> = [];
  const runPhase = vi.fn((request: LinkSegmentPrefetchPhaseRequest) => {
    requests.push({ ...request });
    const deferred = createDeferred();
    deferredRequests.push(deferred);
    return deferred.promise;
  });
  const scheduler = createLinkSegmentPrefetchScheduler({ runPhase });

  return {
    deferredRequests,
    requests,
    runPhase,
    scheduler,
  };
}

describe("Link Segment Cache prefetch scheduler", () => {
  it("runs the route-tree phase before the segment phase", async () => {
    // Mirrors the phase split in Next.js's Segment Cache scheduler:
    // packages/next/src/client/components/segment-cache/scheduler.ts
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/dashboard");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/dashboard",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/dashboard",
      phase: "segment",
      priority: "low",
    });
  });

  it("reschedules a running hover without double-running route-tree and upgrades segment priority", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/reports");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    scheduler.schedule(instance, "high", 1);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/reports",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/reports",
      phase: "segment",
      priority: "high",
    });
  });

  it("continues to the segment phase after visibility cancellation is rescheduled during route-tree", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/feed");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    instance.isVisible = false;
    scheduler.cancel(instance);
    instance.isVisible = true;
    scheduler.schedule(instance, "low", 2);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/feed",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/feed",
      phase: "segment",
      priority: "low",
    });
  });

  it("preserves a forced route-tree restart across visibility cancellation and re-entry", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/alerts");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    scheduler.schedule(instance, "low", 2, { force: true });
    instance.isVisible = false;
    scheduler.cancel(instance);
    instance.isVisible = true;
    scheduler.schedule(instance, "low", 2);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/alerts",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/alerts",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[1]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(3);
    expect(requests[2]).toMatchObject({
      href: "/alerts",
      phase: "segment",
      priority: "low",
    });
  });

  it("restarts a completed task only when forced", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/settings");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();
    deferredRequests[0]?.resolve();
    await flushScheduler();
    deferredRequests[1]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);

    scheduler.schedule(instance, "high", 1);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);

    scheduler.schedule(instance, "low", 2, { force: true });
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(3);
    expect(requests[2]).toMatchObject({
      href: "/settings",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[2]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(4);
    expect(requests[3]).toMatchObject({
      href: "/settings",
      phase: "segment",
      priority: "low",
    });
  });

  it("restarts from route-tree after forced invalidation while route-tree is running", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/notifications");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();

    scheduler.schedule(instance, "high", 1);
    scheduler.schedule(instance, "low", 2, { force: true });
    scheduler.schedule(instance, "high", 2);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      href: "/notifications",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/notifications",
      phase: "route-tree",
      priority: "high",
    });

    deferredRequests[1]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(3);
    expect(requests[2]).toMatchObject({
      href: "/notifications",
      phase: "segment",
      priority: "high",
    });
  });

  it("restarts from route-tree after forced invalidation while segment is running", async () => {
    const { deferredRequests, requests, runPhase, scheduler } = createSchedulerHarness();
    const instance = createInstance("/activity");

    scheduler.schedule(instance, "low", 1);
    await flushScheduler();
    deferredRequests[0]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);
    expect(requests[1]).toMatchObject({
      href: "/activity",
      phase: "segment",
      priority: "low",
    });

    scheduler.schedule(instance, "low", 2, { force: true });
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(2);

    deferredRequests[1]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(3);
    expect(requests[2]).toMatchObject({
      href: "/activity",
      phase: "route-tree",
      priority: "low",
    });

    deferredRequests[2]?.resolve();
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(4);
    expect(requests[3]).toMatchObject({
      href: "/activity",
      phase: "segment",
      priority: "low",
    });
  });

  it("starts low-priority route-tree work in batch order while preserving newest-first order within a batch", async () => {
    const { requests, runPhase, scheduler } = createSchedulerHarness();
    const firstBatch = createInstance("/batch-first");
    const secondBatchOlder = createInstance("/batch-second-older");
    const secondBatchNewer = createInstance("/batch-second-newer");
    const thirdBatch = createInstance("/batch-third");

    scheduler.schedule(firstBatch, "low", 1);
    scheduler.schedule(secondBatchOlder, "low", 2);
    scheduler.schedule(secondBatchNewer, "low", 2);
    scheduler.schedule(thirdBatch, "low", 3);
    await flushScheduler();

    expect(runPhase).toHaveBeenCalledTimes(4);
    expect(requests.map((request) => request.href)).toEqual([
      "/batch-first",
      "/batch-second-newer",
      "/batch-second-older",
      "/batch-third",
    ]);
    expect(requests.map((request) => request.phase)).toEqual([
      "route-tree",
      "route-tree",
      "route-tree",
      "route-tree",
    ]);
  });
});
