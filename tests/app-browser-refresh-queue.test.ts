import { describe, expect, it, vi } from "vitest";
import { createAppBrowserRefreshQueue } from "../packages/vinext/src/server/app-browser-refresh-queue.js";

function createQueue() {
  const tasks: Array<() => void> = [];
  const onDropRefresh = vi.fn();
  const runRefresh = vi.fn();
  const queue = createAppBrowserRefreshQueue({
    onDropRefresh,
    queueTask: (task) => tasks.push(task),
    runRefresh,
  });
  const flushTasks = () => {
    for (const task of tasks.splice(0)) task();
  };
  return { flushTasks, onDropRefresh, queue, runRefresh };
}

describe("app browser refresh queue", () => {
  it("lets a refresh run immediately when no navigation is in flight", () => {
    const { queue } = createQueue();

    expect(queue.queueRefresh()).toBe(false);

    queue.beginNavigation().settle();
    expect(queue.queueRefresh()).toBe(false);
  });

  it("runs one refresh once the navigation ahead of it settles", () => {
    const { flushTasks, queue, runRefresh } = createQueue();
    const navigation = queue.beginNavigation();

    expect(queue.queueRefresh()).toBe(true);
    expect(queue.queueRefresh()).toBe(true);
    flushTasks();
    expect(runRefresh).not.toHaveBeenCalled();

    navigation.settle();
    navigation.settle();
    // The refresh does not re-enter the settling navigation synchronously.
    expect(runRefresh).not.toHaveBeenCalled();
    flushTasks();
    expect(runRefresh).toHaveBeenCalledTimes(1);

    queue.beginNavigation().settle();
    flushTasks();
    expect(runRefresh).toHaveBeenCalledTimes(1);
  });

  it("lets a refresh that starts before a released refresh runs replace it", () => {
    const { flushTasks, queue, runRefresh } = createQueue();
    const navigation = queue.beginNavigation();
    queue.queueRefresh();
    navigation.settle();

    expect(queue.queueRefresh()).toBe(false);
    flushTasks();

    expect(runRefresh).not.toHaveBeenCalled();
  });

  it("moves a released refresh behind a navigation that starts before it runs", () => {
    const { flushTasks, queue, runRefresh } = createQueue();
    const first = queue.beginNavigation();
    queue.queueRefresh();
    first.settle();
    const second = queue.beginNavigation();

    flushTasks();
    expect(runRefresh).not.toHaveBeenCalled();

    second.settle();
    flushTasks();
    expect(runRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not run a refresh when nothing was queued", () => {
    const { flushTasks, queue, runRefresh } = createQueue();

    queue.beginNavigation().settle();
    flushTasks();

    expect(runRefresh).not.toHaveBeenCalled();
  });

  it("moves a queued refresh behind a newer navigation", () => {
    const { flushTasks, queue, runRefresh } = createQueue();
    const first = queue.beginNavigation();
    queue.queueRefresh();
    const second = queue.beginNavigation();

    first.settle();
    flushTasks();
    expect(runRefresh).not.toHaveBeenCalled();

    second.settle();
    flushTasks();
    expect(runRefresh).toHaveBeenCalledTimes(1);
  });

  it("drops a queued refresh when the router starts a document load", () => {
    const { flushTasks, queue, runRefresh } = createQueue();
    const navigation = queue.beginNavigation();
    queue.queueRefresh();

    queue.drop();
    navigation.settle();
    flushTasks();

    expect(runRefresh).not.toHaveBeenCalled();
    expect(queue.queueRefresh()).toBe(false);

    queue.beginNavigation().settle();
    flushTasks();
    expect(runRefresh).not.toHaveBeenCalled();
  });

  it("drops a refresh issued after a document load starts, until a newer navigation", () => {
    const { flushTasks, queue, runRefresh } = createQueue();
    const leaving = queue.beginNavigation();
    queue.drop();

    expect(queue.queueRefresh()).toBe(true);
    leaving.settle();
    flushTasks();
    expect(runRefresh).not.toHaveBeenCalled();

    const next = queue.beginNavigation();
    expect(queue.queueRefresh()).toBe(true);
    next.settle();
    flushTasks();
    expect(runRefresh).toHaveBeenCalledTimes(1);
  });

  it("drops a released refresh that has not run yet when the router starts a document load", () => {
    const { flushTasks, queue, runRefresh } = createQueue();
    const navigation = queue.beginNavigation();
    queue.queueRefresh();
    navigation.settle();

    queue.drop();
    flushTasks();

    expect(runRefresh).not.toHaveBeenCalled();
  });

  it("reports each refresh it drops, so its caches are still invalidated", () => {
    const { flushTasks, onDropRefresh, queue } = createQueue();

    queue.beginNavigation().settle();
    queue.drop();
    expect(onDropRefresh).not.toHaveBeenCalled();

    const leaving = queue.beginNavigation();
    queue.queueRefresh();
    queue.drop();
    expect(onDropRefresh).toHaveBeenCalledTimes(1);

    queue.queueRefresh();
    expect(onDropRefresh).toHaveBeenCalledTimes(2);

    leaving.settle();
    flushTasks();
    const released = queue.beginNavigation();
    queue.queueRefresh();
    released.settle();
    queue.drop();
    expect(onDropRefresh).toHaveBeenCalledTimes(3);
  });
});
