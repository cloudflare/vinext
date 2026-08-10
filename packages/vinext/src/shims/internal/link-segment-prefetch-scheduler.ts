"use client";

export type LinkSegmentPrefetchPhase = "route-tree" | "segment";
export type LinkSegmentPrefetchPriority = "default" | "intent";
export type LinkSegmentPrefetchFetchStrategy = "auto" | "full" | "full-after-shell";

export type LinkSegmentPrefetchInstance = {
  fetchStrategy: LinkSegmentPrefetchFetchStrategy;
  href: string;
  isVisible: boolean;
  locale?: string | false;
  pagesRouteHref?: string;
};

export type LinkSegmentPrefetchPhaseRequest = {
  fetchStrategy: LinkSegmentPrefetchFetchStrategy;
  forceSegmentCacheFetch: boolean;
  href: string;
  locale?: string | false;
  pagesRouteHref?: string;
  phase: LinkSegmentPrefetchPhase;
  priority: LinkSegmentPrefetchPriority;
};

export type LinkSegmentPrefetchScheduler = {
  cancel(instance: LinkSegmentPrefetchInstance): void;
  createBatch(): number;
  registerUserInteractionListeners(): void;
  schedule(
    instance: LinkSegmentPrefetchInstance,
    priority: LinkSegmentPrefetchPriority,
    batchId?: number,
  ): void;
};

type SchedulerOptions = {
  runPhase(request: LinkSegmentPrefetchPhaseRequest): Promise<void>;
};

type PrefetchTask = {
  batchId: number;
  forceSegmentCacheFetch: boolean;
  instance: LinkSegmentPrefetchInstance;
  isCanceled: boolean;
  isQueued: boolean;
  isRunning: boolean;
  phase: LinkSegmentPrefetchPhase;
  priority: LinkSegmentPrefetchPriority;
  sortId: number;
};

const DEFAULT_REQUEST_LIMIT = 4;
const INTENT_REQUEST_LIMIT = 12;

/**
 * Coordinates the two observable phases of a Cache Components Link prefetch.
 *
 * This mirrors the task lifecycle in Next.js's Segment Cache scheduler: route
 * trees are requested before segment data, viewport work is capped at four
 * open connections, the most recently hovered Link gets reserved bandwidth,
 * and canceled task objects can be rescheduled when their Link becomes visible
 * again.
 */
export function createLinkSegmentPrefetchScheduler(
  options: SchedulerOptions,
): LinkSegmentPrefetchScheduler {
  const tasksByInstance = new WeakMap<LinkSegmentPrefetchInstance, PrefetchTask>();
  const queue: PrefetchTask[] = [];

  let activeRequests = 0;
  let batchIdCounter = 0;
  let didScheduleDrain = false;
  let lastUserInteractionAt = 0;
  let mostRecentIntentTask: PrefetchTask | null = null;
  let previousIntentTask: PrefetchTask | null = null;
  let sortIdCounter = 0;
  let userInteractionListenersRegistered = false;

  function markUserInteraction(): void {
    lastUserInteractionAt = Date.now();
  }

  function hasRecentUserInteraction(): boolean {
    return Date.now() - lastUserInteractionAt < 1_000;
  }

  function registerUserInteractionListeners(): void {
    if (typeof window === "undefined" || userInteractionListenersRegistered) return;
    userInteractionListenersRegistered = true;
    window.addEventListener("pointerdown", markUserInteraction, true);
    window.addEventListener("mousedown", markUserInteraction, true);
    window.addEventListener("click", markUserInteraction, true);
    window.addEventListener("input", markUserInteraction, true);
    window.addEventListener("change", markUserInteraction, true);
    window.addEventListener("keydown", markUserInteraction, true);
  }

  function compareTasks(a: PrefetchTask, b: PrefetchTask): number {
    const priorityDifference =
      (a.priority === "intent" ? 1 : 0) - (b.priority === "intent" ? 1 : 0);
    if (priorityDifference !== 0) return priorityDifference;

    const phaseDifference = (a.phase === "route-tree" ? 1 : 0) - (b.phase === "route-tree" ? 1 : 0);
    if (phaseDifference !== 0) return phaseDifference;

    // Newer tasks win within the same priority and phase, matching Next.js's
    // incrementing sortId heap ordering.
    return a.sortId - b.sortId;
  }

  function hasBandwidth(task: PrefetchTask): boolean {
    // Vinext's segment phase is a unified page response rather than Next.js's
    // independently cached segment reads. Keep the second-most-recent hover's
    // response ahead of ordinary segment work once it starts, so a very fast
    // later viewport response cannot overtake the hover ordering.
    if (
      task.phase === "segment" &&
      task.priority === "default" &&
      task !== previousIntentTask &&
      previousIntentTask?.phase === "segment" &&
      previousIntentTask.isRunning
    ) {
      return false;
    }

    // IntersectionObserver reports a set of links as one batch. Finish route
    // trees from an older visibility batch before starting a newer one; this
    // prevents newly inserted links from jumping ahead while the old batch is
    // still blocked on the network.
    if (task.phase === "route-tree" && task.priority === "default") {
      for (const queuedTask of queue) {
        if (
          queuedTask !== task &&
          queuedTask.priority === "default" &&
          queuedTask.phase === "route-tree" &&
          queuedTask.batchId < task.batchId
        ) {
          return false;
        }
      }
    }
    return (
      activeRequests < (task.priority === "intent" ? INTENT_REQUEST_LIMIT : DEFAULT_REQUEST_LIMIT)
    );
  }

  function removeFromQueue(task: PrefetchTask): void {
    if (!task.isQueued) return;
    task.isQueued = false;
    const index = queue.indexOf(task);
    if (index !== -1) queue.splice(index, 1);
  }

  function enqueue(task: PrefetchTask): void {
    if (task.isQueued || task.isRunning || task.isCanceled) return;
    task.isQueued = true;
    queue.push(task);
  }

  function findNextTask(): PrefetchTask | null {
    let best: PrefetchTask | null = null;
    for (const task of queue) {
      if (!hasBandwidth(task)) continue;
      if (best === null || compareTasks(task, best) > 0) best = task;
    }
    return best;
  }

  function scheduleDrain(): void {
    if (didScheduleDrain) return;
    didScheduleDrain = true;
    queueMicrotask(drain);
  }

  function finishTaskPhase(task: PrefetchTask, phase: LinkSegmentPrefetchPhase): void {
    task.isRunning = false;
    activeRequests -= 1;

    if (!task.isCanceled && task.instance.isVisible) {
      if (phase === "route-tree") {
        task.phase = "segment";
        enqueue(task);
      } else if (task === mostRecentIntentTask) {
        mostRecentIntentTask = null;
      }
      if (phase === "segment" && task === previousIntentTask) {
        previousIntentTask = null;
      }
    }

    scheduleDrain();
  }

  function drain(): void {
    didScheduleDrain = false;

    let task = findNextTask();
    while (task !== null) {
      removeFromQueue(task);
      if (task.isCanceled || !task.instance.isVisible) {
        task = findNextTask();
        continue;
      }

      const currentTask = task;
      const phase = currentTask.phase;
      currentTask.isRunning = true;
      activeRequests += 1;

      void Promise.resolve(
        options.runPhase({
          fetchStrategy: currentTask.instance.fetchStrategy,
          forceSegmentCacheFetch: currentTask.forceSegmentCacheFetch,
          href: currentTask.instance.href,
          locale: currentTask.instance.locale,
          pagesRouteHref: currentTask.instance.pagesRouteHref,
          phase,
          priority: currentTask.priority,
        }),
      )
        .catch(() => {})
        .finally(() => finishTaskPhase(currentTask, phase));

      task = findNextTask();
    }
  }

  function trackIntentTask(task: PrefetchTask): void {
    if (task.priority !== "intent" || task === mostRecentIntentTask) return;

    if (mostRecentIntentTask !== null) {
      mostRecentIntentTask.priority = "default";
      previousIntentTask = mostRecentIntentTask;
    }
    mostRecentIntentTask = task;
  }

  function schedule(
    instance: LinkSegmentPrefetchInstance,
    priority: LinkSegmentPrefetchPriority,
    batchId = tasksByInstance.get(instance)?.batchId ?? createBatch(),
  ): void {
    let task = tasksByInstance.get(instance);
    if (task === undefined) {
      task = {
        batchId,
        forceSegmentCacheFetch: priority === "default" && hasRecentUserInteraction(),
        instance,
        isCanceled: false,
        isQueued: false,
        isRunning: false,
        phase: "route-tree",
        priority,
        sortId: sortIdCounter++,
      };
      tasksByInstance.set(instance, task);
    } else {
      task.batchId = batchId;
      task.isCanceled = false;
      task.priority = task === mostRecentIntentTask ? "intent" : priority;
      task.sortId = sortIdCounter++;

      if (!task.isRunning) {
        task.forceSegmentCacheFetch = priority === "default" && hasRecentUserInteraction();
        removeFromQueue(task);
        task.phase = "route-tree";
      }
    }

    trackIntentTask(task);
    enqueue(task);
    scheduleDrain();
  }

  function cancel(instance: LinkSegmentPrefetchInstance): void {
    const task = tasksByInstance.get(instance);
    if (task === undefined) return;

    task.isCanceled = true;
    removeFromQueue(task);
    if (task === mostRecentIntentTask) mostRecentIntentTask = null;
    if (task === previousIntentTask) previousIntentTask = null;
  }

  function createBatch(): number {
    return batchIdCounter++;
  }

  return { cancel, createBatch, registerUserInteractionListeners, schedule };
}
