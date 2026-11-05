import { describe, expect, it, vi } from "vite-plus/test";
import { createAppBrowserRefreshQueue } from "../packages/vinext/src/server/app-browser-refresh-queue.js";

function createQueue() {
  const tasks: (() => void)[] = [];
  const queue = createAppBrowserRefreshQueue({ queueTask: (task) => tasks.push(task) });
  const flushTasks = () => {
    for (const task of tasks.splice(0)) task();
  };
  return { flushTasks, queue };
}

describe("app browser refresh queue", () => {
  it("lets a refresh run at once when no navigation is in flight", () => {
    const { queue } = createQueue();
    expect(queue.queueRefresh(vi.fn())).toBe(false);
  });

  it("runs a refresh queued behind a navigation once it settles", () => {
    const { flushTasks, queue } = createQueue();
    const refresh = vi.fn();
    const navigation = queue.beginNavigation();

    expect(queue.queueRefresh(refresh)).toBe(true);
    flushTasks();
    expect(refresh).not.toHaveBeenCalled();

    navigation.settle();
    expect(refresh).not.toHaveBeenCalled();
    flushTasks();
    expect(refresh).toHaveBeenCalledOnce();

    // Settling again (from the navigation's finally) does nothing.
    navigation.settle();
    flushTasks();
    expect(refresh).toHaveBeenCalledOnce();
    expect(queue.queueRefresh(vi.fn())).toBe(false);
  });

  it("runs refreshes queued behind one navigation once", () => {
    const { flushTasks, queue } = createQueue();
    const first = vi.fn();
    const second = vi.fn();
    const navigation = queue.beginNavigation();

    queue.queueRefresh(first);
    queue.queueRefresh(second);
    navigation.settle();
    flushTasks();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("moves a queued refresh behind a newer navigation", () => {
    const { flushTasks, queue } = createQueue();
    const refresh = vi.fn();
    const older = queue.beginNavigation();
    queue.queueRefresh(refresh);
    const newer = queue.beginNavigation();

    older.settle();
    flushTasks();
    expect(refresh).not.toHaveBeenCalled();

    newer.settle();
    flushTasks();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("moves a released refresh behind a navigation that starts before it runs", () => {
    const { flushTasks, queue } = createQueue();
    const refresh = vi.fn();
    const first = queue.beginNavigation();
    queue.queueRefresh(refresh);
    first.settle();
    const second = queue.beginNavigation();

    flushTasks();
    expect(refresh).not.toHaveBeenCalled();

    second.settle();
    flushTasks();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("drops a released refresh when a refresh starts before it runs", () => {
    const { flushTasks, queue } = createQueue();
    const released = vi.fn();
    const navigation = queue.beginNavigation();
    queue.queueRefresh(released);
    navigation.settle();

    expect(queue.queueRefresh(vi.fn())).toBe(false);
    flushTasks();
    expect(released).not.toHaveBeenCalled();
  });

  it("drops the refresh queued behind a navigation that starts a document load", () => {
    const { flushTasks, queue } = createQueue();
    const refresh = vi.fn();
    const navigation = queue.beginNavigation();
    queue.queueRefresh(refresh);

    navigation.drop();
    navigation.settle();
    flushTasks();

    expect(refresh).not.toHaveBeenCalled();
    expect(queue.queueRefresh(vi.fn())).toBe(false);
  });

  it("ignores a drop from a navigation a newer one replaced", () => {
    const { flushTasks, queue } = createQueue();
    const refresh = vi.fn();
    const older = queue.beginNavigation();
    queue.queueRefresh(refresh);
    const newer = queue.beginNavigation();

    older.drop();
    newer.settle();
    flushTasks();

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("drops a queued or released refresh when a document load starts", () => {
    const { flushTasks, queue } = createQueue();
    const queued = vi.fn();
    const released = vi.fn();
    const first = queue.beginNavigation();
    queue.queueRefresh(released);
    first.settle();
    queue.dropQueuedRefresh();
    flushTasks();
    expect(released).not.toHaveBeenCalled();

    const second = queue.beginNavigation();
    queue.queueRefresh(queued);
    queue.dropQueuedRefresh();
    second.settle();
    flushTasks();
    expect(queued).not.toHaveBeenCalled();
  });
});
