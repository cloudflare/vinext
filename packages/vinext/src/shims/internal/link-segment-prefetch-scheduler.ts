"use client";

type LinkSegmentPrefetchPhase = "route-tree" | "segment";
type LinkSegmentPrefetchPriority = "low" | "high";

export type LinkSegmentPrefetchPhaseRequest = {
  href: string;
  phase: LinkSegmentPrefetchPhase;
  priority: LinkSegmentPrefetchPriority;
  pagesRouteHref?: string;
  forceSegmentCacheFetch: boolean;
};

export type LinkSegmentPrefetchInstance = {
  href: string;
  isVisible: boolean;
  pagesRouteHref?: string;
};

export type LinkSegmentPrefetchScheduler = {
  cancel(instance: LinkSegmentPrefetchInstance): void;
  createBatch(): number;
  registerUserInteractionListeners(): void;
  schedule(
    instance: LinkSegmentPrefetchInstance,
    priority: LinkSegmentPrefetchPriority,
    batchId?: number,
    options?: { force?: boolean },
  ): void;
};

type LinkSegmentPrefetchTaskStatus =
  | "idle"
  | "queued"
  | "running"
  | "running-canceled"
  | "running-canceled-dirty"
  | "running-dirty"
  | "completed";

type LinkSegmentPrefetchTask = {
  instance: LinkSegmentPrefetchInstance;
  batchId: number;
  forceSegmentCacheFetch: boolean;
  phase: LinkSegmentPrefetchPhase;
  priority: LinkSegmentPrefetchPriority;
  sortId: number;
  status: LinkSegmentPrefetchTaskStatus;
};

type LinkSegmentPrefetchSchedulerOptions = {
  runPhase(request: LinkSegmentPrefetchPhaseRequest): Promise<void>;
};

export function createLinkSegmentPrefetchScheduler(
  options: LinkSegmentPrefetchSchedulerOptions,
): LinkSegmentPrefetchScheduler {
  const tasksByInstance = new WeakMap<LinkSegmentPrefetchInstance, LinkSegmentPrefetchTask>();
  const queuedTasks: LinkSegmentPrefetchTask[] = [];
  let batchIdCounter = 0;
  let sortIdCounter = 0;
  let inProgress = 0;
  let pendingMicrotask = false;
  let mostRecentIntentTask: LinkSegmentPrefetchTask | null = null;
  let userInteractionListenersRegistered = false;
  let lastUserInteractionAt = 0;

  function createBatch(): number {
    return batchIdCounter++;
  }

  function scheduleMicrotask(fn: () => void): void {
    if (typeof queueMicrotask === "function") {
      queueMicrotask(fn);
    } else {
      Promise.resolve()
        .then(fn)
        .catch((error) => {
          setTimeout(() => {
            throw error;
          });
        });
    }
  }

  function enqueueTask(task: LinkSegmentPrefetchTask): void {
    if (task.status !== "idle") return;
    task.status = "queued";
    queuedTasks.push(task);
  }

  function removeQueuedTask(task: LinkSegmentPrefetchTask): void {
    if (task.status !== "queued") return;
    task.status = "idle";
    const index = queuedTasks.indexOf(task);
    if (index !== -1) queuedTasks.splice(index, 1);
  }

  function scheduleQueue(delayUntilNextTask = false): void {
    if (pendingMicrotask) return;
    pendingMicrotask = true;
    if (delayUntilNextTask) {
      setTimeout(processQueue, 0);
      return;
    }
    scheduleMicrotask(processQueue);
  }

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

  function compareTasks(a: LinkSegmentPrefetchTask, b: LinkSegmentPrefetchTask): number {
    const priorityDelta = (a.priority === "high" ? 1 : 0) - (b.priority === "high" ? 1 : 0);
    if (priorityDelta !== 0) return priorityDelta;
    const phaseDelta = (a.phase === "route-tree" ? 1 : 0) - (b.phase === "route-tree" ? 1 : 0);
    if (phaseDelta !== 0) return phaseDelta;
    return a.sortId - b.sortId;
  }

  function hasBandwidth(task: LinkSegmentPrefetchTask): boolean {
    if (task.phase === "route-tree" && task.priority !== "high") {
      for (const queuedTask of queuedTasks) {
        if (
          queuedTask !== task &&
          queuedTask.priority !== "high" &&
          queuedTask.phase === "route-tree" &&
          queuedTask.batchId < task.batchId
        ) {
          return false;
        }
      }
    }
    return inProgress < (task.priority === "high" ? 12 : 4);
  }

  function peekNextRunnableTask(): LinkSegmentPrefetchTask | null {
    let bestTask: LinkSegmentPrefetchTask | null = null;
    for (const task of queuedTasks) {
      if (!hasBandwidth(task)) continue;
      if (bestTask === null || compareTasks(task, bestTask) > 0) {
        bestTask = task;
      }
    }
    return bestTask;
  }

  function trackIntentTask(task: LinkSegmentPrefetchTask): void {
    if (task.priority !== "high" || task === mostRecentIntentTask) return;
    if (mostRecentIntentTask !== null) {
      mostRecentIntentTask.priority = "low";
    }
    mostRecentIntentTask = task;
  }

  function schedule(
    instance: LinkSegmentPrefetchInstance,
    priority: LinkSegmentPrefetchPriority,
    batchId = tasksByInstance.get(instance)?.batchId ?? createBatch(),
    options: { force?: boolean } = {},
  ): void {
    let task = tasksByInstance.get(instance) ?? null;
    if (task === null) {
      task = {
        instance,
        batchId,
        forceSegmentCacheFetch: priority === "low" && hasRecentUserInteraction(),
        phase: "route-tree",
        priority,
        sortId: sortIdCounter++,
        status: "idle",
      };
      tasksByInstance.set(instance, task);
    } else {
      if (
        task.status === "running" ||
        task.status === "running-canceled" ||
        task.status === "running-canceled-dirty" ||
        task.status === "running-dirty"
      ) {
        if (options.force === true) {
          task.status =
            task.status === "running-canceled" || task.status === "running-canceled-dirty"
              ? "running-canceled-dirty"
              : "running-dirty";
          task.batchId = batchId;
          task.forceSegmentCacheFetch = priority === "low" && hasRecentUserInteraction();
          task.phase = "route-tree";
          task.sortId = sortIdCounter++;
        } else if (task.status === "running-canceled-dirty") {
          task.status = "running-dirty";
        } else if (task.status !== "running-dirty") {
          task.status = "running";
        }
        task.priority = task === mostRecentIntentTask && priority === "low" ? "high" : priority;
        trackIntentTask(task);
        return;
      }
      if (task.status === "completed" && options.force !== true) {
        return;
      }

      removeQueuedTask(task);
      task.batchId = batchId;
      task.forceSegmentCacheFetch = priority === "low" && hasRecentUserInteraction();
      task.phase = "route-tree";
      task.priority = task === mostRecentIntentTask && priority === "low" ? "high" : priority;
      task.sortId = sortIdCounter++;
      task.status = "idle";
    }

    trackIntentTask(task);
    enqueueTask(task);
    scheduleQueue(priority === "high");
  }

  function cancel(instance: LinkSegmentPrefetchInstance): void {
    const task = tasksByInstance.get(instance);
    if (task === undefined) return;
    if (task.status === "queued") {
      removeQueuedTask(task);
    } else if (task.status === "running" || task.status === "running-dirty") {
      task.status = task.status === "running-dirty" ? "running-canceled-dirty" : "running-canceled";
    }
    if (mostRecentIntentTask === task) {
      mostRecentIntentTask = null;
    }
  }

  function processQueue(): void {
    pendingMicrotask = false;

    let task = peekNextRunnableTask();
    while (task !== null) {
      removeQueuedTask(task);
      if (task.status !== "idle" || !task.instance.isVisible) {
        task = peekNextRunnableTask();
        continue;
      }

      const currentTask = task;
      inProgress++;
      currentTask.status = "running";
      const phase = currentTask.phase;

      Promise.resolve(
        options.runPhase({
          href: currentTask.instance.href,
          phase,
          priority: currentTask.priority,
          pagesRouteHref: currentTask.instance.pagesRouteHref,
          forceSegmentCacheFetch: currentTask.forceSegmentCacheFetch,
        }),
      )
        .catch(() => {})
        .finally(() => {
          const shouldContinue = currentTask.status === "running" && currentTask.instance.isVisible;
          const shouldRestart =
            (currentTask.status === "running-dirty" ||
              currentTask.status === "running-canceled-dirty") &&
            currentTask.instance.isVisible;
          currentTask.status = "idle";
          inProgress--;

          if (shouldRestart) {
            currentTask.phase = "route-tree";
            enqueueTask(currentTask);
          } else if (shouldContinue && phase === "route-tree") {
            currentTask.phase = "segment";
            enqueueTask(currentTask);
          } else if (shouldContinue && phase === "segment") {
            currentTask.status = "completed";
            if (mostRecentIntentTask === currentTask) {
              mostRecentIntentTask = null;
            }
          }
          scheduleQueue();
        });

      task = peekNextRunnableTask();
    }
  }

  return {
    cancel,
    createBatch,
    registerUserInteractionListeners,
    schedule,
  };
}
