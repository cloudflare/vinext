"use client";

type LinkSegmentPrefetchPhase = "route-tree" | "segment";
type LinkSegmentPrefetchPriority = "default" | "intent";
export type LinkSegmentPrefetchFetchStrategy = "auto" | "full" | "full-after-shell";
export type LinkSegmentPrefetchPhaseOutcome = "fulfilled" | "rejected";

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
  cancelAll(): void;
  createBatch(): number;
  registerUserInteractionListeners(): void;
  schedule(
    instance: LinkSegmentPrefetchInstance,
    priority: LinkSegmentPrefetchPriority,
    batchId?: number,
    restartCompleted?: boolean,
  ): void;
};

type SchedulerOptions = {
  runPhase(request: LinkSegmentPrefetchPhaseRequest): Promise<LinkSegmentPrefetchPhaseOutcome>;
};

type PrefetchTask = {
  batchId: number;
  completedFetchStrategy: LinkSegmentPrefetchFetchStrategy | null;
  forceSegmentCacheFetch: boolean;
  heapIndex: number;
  instance: LinkSegmentPrefetchInstance;
  isCanceled: boolean;
  isQueued: boolean;
  isRunning: boolean;
  phase: LinkSegmentPrefetchPhase;
  priority: LinkSegmentPrefetchPriority;
  restartAfterRunning: boolean;
  runningCacheIdentity: string | null;
  runningFetchStrategy: LinkSegmentPrefetchFetchStrategy | null;
  sortId: number;
};

const DEFAULT_REQUEST_LIMIT = 4;
const INTENT_REQUEST_LIMIT = 12;

/**
 * Coordinates the two observable phases of a Cache Components Link prefetch.
 *
 * This mirrors the task lifecycle in Next.js's Segment Cache scheduler: route
 * trees are requested before segment data, viewport work is capped at four
 * open connections, the most recently hovered Link can use intent bandwidth,
 * and canceled task objects can be rescheduled when their Link becomes visible
 * again.
 */
export function createLinkSegmentPrefetchScheduler(
  options: SchedulerOptions,
): LinkSegmentPrefetchScheduler {
  const tasksByInstance = new WeakMap<LinkSegmentPrefetchInstance, PrefetchTask>();
  const queue: PrefetchTask[] = [];
  const unfinishedTasks = new Set<PrefetchTask>();

  let activeRequests = 0;
  let batchIdCounter = 0;
  let didScheduleDrain = false;
  let lastUserInteractionAt = 0;
  let mostRecentIntentTask: PrefetchTask | null = null;
  let sortIdCounter = 0;
  let userInteractionListenersRegistered = false;

  function markUserInteraction(): void {
    lastUserInteractionAt = Date.now();
  }

  function hasRecentUserInteraction(): boolean {
    return Date.now() - lastUserInteractionAt < 1_000;
  }

  function canonicalizeCacheHref(href: string | undefined): string {
    if (href === undefined) return "";
    try {
      const url = new URL(href, "https://vinext.local");
      url.hash = "";
      return url.href;
    } catch {
      return href.split("#", 1)[0] ?? href;
    }
  }

  function getCacheIdentity(instance: LinkSegmentPrefetchInstance): string {
    return `${canonicalizeCacheHref(instance.href)}\0${instance.locale ?? ""}\0${canonicalizeCacheHref(instance.pagesRouteHref)}\0${instance.fetchStrategy}`;
  }

  function shouldForceSegmentCacheFetch(
    instance: LinkSegmentPrefetchInstance,
    priority: LinkSegmentPrefetchPriority,
    batchId: number,
  ): boolean {
    // This workaround is only for a later automatic viewport batch revealed
    // by an interaction while an older batch is still pending (the scheduling
    // fixture's "Show more links" path). Applying it to the first batch after
    // every interaction bypasses normal cache deduplication for accordions and
    // other reveal controls, issuing the same segment request twice.
    //
    // An explicit full prefetch may intentionally reuse an equivalent rewrite
    // target, so it must never take this path either.
    if (
      instance.fetchStrategy !== "auto" ||
      priority !== "default" ||
      !hasRecentUserInteraction()
    ) {
      return false;
    }
    const cacheIdentity = getCacheIdentity(instance);
    const unfinished = Array.from(unfinishedTasks);
    if (
      unfinished.some(
        (task) =>
          (task.isRunning && task.runningCacheIdentity === cacheIdentity) ||
          (!task.isCanceled && getCacheIdentity(task.instance) === cacheIdentity),
      )
    ) {
      return false;
    }
    const pendingTasks = unfinished.filter((task) => !task.isCanceled);
    return pendingTasks.some(
      (task) => !task.isCanceled && task.instance !== instance && task.batchId < batchId,
    );
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
    return (
      activeRequests < (task.priority === "intent" ? INTENT_REQUEST_LIMIT : DEFAULT_REQUEST_LIMIT)
    );
  }

  function swapHeapEntries(leftIndex: number, rightIndex: number): void {
    const left = queue[leftIndex];
    const right = queue[rightIndex];
    if (left === undefined || right === undefined) return;
    queue[leftIndex] = right;
    queue[rightIndex] = left;
    right.heapIndex = leftIndex;
    left.heapIndex = rightIndex;
  }

  function siftUp(startIndex: number): number {
    let index = startIndex;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const task = queue[index];
      const parent = queue[parentIndex];
      if (task === undefined || parent === undefined || compareTasks(task, parent) <= 0) break;
      swapHeapEntries(index, parentIndex);
      index = parentIndex;
    }
    return index;
  }

  function siftDown(startIndex: number): void {
    let index = startIndex;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let bestIndex = index;
      const best = queue[bestIndex];
      const left = queue[leftIndex];
      const right = queue[rightIndex];
      if (left !== undefined && best !== undefined && compareTasks(left, best) > 0) {
        bestIndex = leftIndex;
      }
      const nextBest = queue[bestIndex];
      if (right !== undefined && nextBest !== undefined && compareTasks(right, nextBest) > 0) {
        bestIndex = rightIndex;
      }
      if (bestIndex === index) return;
      swapHeapEntries(index, bestIndex);
      index = bestIndex;
    }
  }

  function resiftQueuedTask(task: PrefetchTask): void {
    if (!task.isQueued || task.heapIndex < 0) return;
    siftDown(siftUp(task.heapIndex));
  }

  function removeFromQueue(task: PrefetchTask): void {
    const index = task.heapIndex;
    if (!task.isQueued || index < 0) return;
    task.isQueued = false;
    task.heapIndex = -1;
    const last = queue.pop();
    if (last === undefined || last === task) return;
    queue[index] = last;
    last.heapIndex = index;
    siftDown(siftUp(index));
  }

  function enqueue(task: PrefetchTask): void {
    if (task.isQueued || task.isRunning || task.isCanceled) return;
    task.isQueued = true;
    task.heapIndex = queue.length;
    queue.push(task);
    siftUp(task.heapIndex);
  }

  function findNextTask(): PrefetchTask | null {
    const task = queue[0];
    return task !== undefined && hasBandwidth(task) ? task : null;
  }

  function scheduleDrain(): void {
    if (didScheduleDrain) return;
    didScheduleDrain = true;
    queueMicrotask(drain);
  }

  function finishTaskPhase(
    task: PrefetchTask,
    phase: LinkSegmentPrefetchPhase,
    fetchedStrategy: LinkSegmentPrefetchFetchStrategy,
    outcome: LinkSegmentPrefetchPhaseOutcome,
  ): void {
    task.isRunning = false;
    task.runningCacheIdentity = null;
    task.runningFetchStrategy = null;
    activeRequests -= 1;

    let didRestart = false;
    if (!task.isCanceled && task.instance.isVisible) {
      if (task.restartAfterRunning) {
        // Match Next's reschedulePrefetchTask lifecycle: a strategy upgrade or
        // cache invalidation that arrives while a phase is in flight replaces
        // the task from RouteTree once that immutable request settles.
        task.restartAfterRunning = false;
        task.completedFetchStrategy = null;
        task.phase = "route-tree";
        enqueue(task);
        didRestart = true;
      } else if (phase === "route-tree" && outcome === "fulfilled") {
        task.phase = "segment";
        enqueue(task);
      } else {
        task.completedFetchStrategy = fetchedStrategy;
      }
    }
    if (
      !didRestart &&
      (phase === "segment" || outcome === "rejected" || task.isCanceled || !task.instance.isVisible)
    ) {
      unfinishedTasks.delete(task);
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
      const fetchStrategy = currentTask.instance.fetchStrategy;
      currentTask.isRunning = true;
      currentTask.runningCacheIdentity = getCacheIdentity(currentTask.instance);
      currentTask.runningFetchStrategy = fetchStrategy;
      activeRequests += 1;

      void Promise.resolve(
        options.runPhase({
          fetchStrategy,
          forceSegmentCacheFetch: currentTask.forceSegmentCacheFetch,
          href: currentTask.instance.href,
          locale: currentTask.instance.locale,
          pagesRouteHref: currentTask.instance.pagesRouteHref,
          phase,
          priority: currentTask.priority,
        }),
      )
        .catch((): LinkSegmentPrefetchPhaseOutcome => "rejected")
        .then((outcome) => finishTaskPhase(currentTask, phase, fetchStrategy, outcome));

      task = findNextTask();
    }
  }

  function trackIntentTask(task: PrefetchTask): void {
    if (task.priority !== "intent" || task === mostRecentIntentTask) return;

    if (mostRecentIntentTask !== null) {
      mostRecentIntentTask.priority = "default";
      resiftQueuedTask(mostRecentIntentTask);
    }
    mostRecentIntentTask = task;
  }

  function schedule(
    instance: LinkSegmentPrefetchInstance,
    priority: LinkSegmentPrefetchPriority,
    batchId = tasksByInstance.get(instance)?.batchId ?? createBatch(),
    restartCompleted = false,
  ): void {
    let task = tasksByInstance.get(instance);
    if (task === undefined) {
      task = {
        batchId,
        completedFetchStrategy: null,
        forceSegmentCacheFetch: shouldForceSegmentCacheFetch(instance, priority, batchId),
        heapIndex: -1,
        instance,
        isCanceled: false,
        isQueued: false,
        isRunning: false,
        phase: "route-tree",
        priority,
        restartAfterRunning: false,
        runningCacheIdentity: null,
        runningFetchStrategy: null,
        sortId: sortIdCounter++,
      };
      tasksByInstance.set(instance, task);
    } else {
      const wasCanceled = task.isCanceled;
      task.batchId = batchId;
      task.isCanceled = false;
      task.priority = task === mostRecentIntentTask ? "intent" : priority;
      task.sortId = sortIdCounter++;
      trackIntentTask(task);

      // A Link can become hovered immediately after an interaction mounts it.
      // If its viewport task already completed, the intent event should reuse
      // that result instead of restarting both phases. A strategy upgrade such
      // as unstable_dynamicOnHover still needs a fresh task.
      if (
        !wasCanceled &&
        !restartCompleted &&
        task.completedFetchStrategy === instance.fetchStrategy
      ) {
        scheduleDrain();
        return;
      }

      if (task.isRunning) {
        if (
          wasCanceled ||
          restartCompleted ||
          task.runningFetchStrategy !== instance.fetchStrategy
        ) {
          task.restartAfterRunning = true;
          task.completedFetchStrategy = null;
          task.forceSegmentCacheFetch = shouldForceSegmentCacheFetch(instance, priority, batchId);
          unfinishedTasks.add(task);
        }
        scheduleDrain();
        return;
      } else {
        task.completedFetchStrategy = null;
        task.forceSegmentCacheFetch = shouldForceSegmentCacheFetch(instance, priority, batchId);
        removeFromQueue(task);
        task.phase = "route-tree";
      }
    }

    unfinishedTasks.add(task);
    trackIntentTask(task);
    enqueue(task);
    scheduleDrain();
  }

  function cancel(instance: LinkSegmentPrefetchInstance): void {
    const task = tasksByInstance.get(instance);
    if (task === undefined) return;

    task.isCanceled = true;
    task.restartAfterRunning = false;
    removeFromQueue(task);
    if (!task.isRunning) unfinishedTasks.delete(task);
  }

  function cancelAll(): void {
    for (const task of unfinishedTasks) {
      task.isCanceled = true;
      task.restartAfterRunning = false;
      removeFromQueue(task);
      if (!task.isRunning) unfinishedTasks.delete(task);
    }
    mostRecentIntentTask = null;
  }

  function createBatch(): number {
    return batchIdCounter++;
  }

  return { cancel, cancelAll, createBatch, registerUserInteractionListeners, schedule };
}
