import { describe, expect, it } from "vitest";
import { createAppBrowserActionQueue } from "../packages/vinext/src/server/app-browser-action-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("app browser action queue", () => {
  it("settles action values early but snapshots the next action after the prior completion", async () => {
    const firstValue = deferred<string>();
    const firstCompletion = deferred<void>();
    const snapshots: string[] = [];
    let committedTree = "initial";
    const queue = createAppBrowserActionQueue();

    const actionA = queue.enqueue(() => {
      snapshots.push(committedTree);
      return { completion: firstCompletion.promise, value: firstValue.promise };
    });
    const actionB = queue.enqueue(() => {
      snapshots.push(committedTree);
      return { completion: Promise.resolve(), value: Promise.resolve("B") };
    });

    firstValue.resolve("A");
    await expect(actionA).resolves.toBe("A");
    expect(snapshots).toEqual(["initial"]);

    committedTree = "after-A";
    firstCompletion.resolve();
    await expect(actionB).resolves.toBe("B");
    expect(snapshots).toEqual(["initial", "after-A"]);
  });

  it("lets navigation preempt an active action and gates queued actions on navigation", async () => {
    const firstCompletion = deferred<void>();
    const navigationCompletion = deferred<void>();
    const events: string[] = [];
    const queue = createAppBrowserActionQueue();

    const actionA = queue.enqueue(() => ({
      completion: firstCompletion.promise,
      value: Promise.resolve("A"),
    }));
    const actionB = queue.enqueue(() => {
      events.push("B started");
      return { completion: Promise.resolve(), value: Promise.resolve("B") };
    });
    const navigation = queue.runNavigation(() => {
      events.push("navigation started");
      return navigationCompletion.promise;
    });

    await expect(actionA).resolves.toBe("A");
    firstCompletion.resolve();
    await Promise.resolve();
    expect(events).toEqual(["navigation started"]);

    navigationCompletion.resolve();
    await navigation;
    await expect(actionB).resolves.toBe("B");
    expect(events).toEqual(["navigation started", "B started"]);
  });

  it("queues refresh behind active and already-queued actions", async () => {
    const firstCompletion = deferred<void>();
    const events: string[] = [];
    const queue = createAppBrowserActionQueue();

    const actionA = queue.enqueue(() => {
      events.push("A started");
      return { completion: firstCompletion.promise, value: Promise.resolve("A") };
    });
    const actionB = queue.enqueue(() => {
      events.push("B started");
      return { completion: Promise.resolve(), value: Promise.resolve("B") };
    });
    const refresh = queue.runQueuedNavigation(async () => {
      events.push("refresh started");
    });

    await expect(actionA).resolves.toBe("A");
    expect(events).toEqual(["A started"]);

    firstCompletion.resolve();
    await expect(actionB).resolves.toBe("B");
    await refresh;
    expect(events).toEqual(["A started", "B started", "refresh started"]);
  });
});
