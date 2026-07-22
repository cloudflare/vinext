"use client";

const APP_PREFETCH_FETCH_SLOT_RELEASE_KEY = Symbol.for("vinext.appPrefetchFetchSlotRelease");

const MAX_DEFAULT_APP_PREFETCH_REQUESTS = 4;
const defaultAppPrefetchQueue: Array<() => void> = [];
let activeDefaultAppPrefetchRequests = 0;
let defaultAppPrefetchDrainScheduled = false;

function drainDefaultAppPrefetchQueue(): void {
  defaultAppPrefetchDrainScheduled = false;
  while (activeDefaultAppPrefetchRequests < MAX_DEFAULT_APP_PREFETCH_REQUESTS) {
    const run = defaultAppPrefetchQueue.shift();
    if (!run) return;
    activeDefaultAppPrefetchRequests += 1;
    run();
  }
}

function scheduleDefaultAppPrefetchDrain(): void {
  if (defaultAppPrefetchDrainScheduled) return;
  defaultAppPrefetchDrainScheduled = true;
  queueMicrotask(drainDefaultAppPrefetchQueue);
}

export function releaseAppPrefetchFetchSlot(response: Response): void {
  const release = (response as Response & Record<symbol, (() => void) | undefined>)[
    APP_PREFETCH_FETCH_SLOT_RELEASE_KEY
  ];
  if (release === undefined) return;

  (response as Response & Record<symbol, (() => void) | undefined>)[
    APP_PREFETCH_FETCH_SLOT_RELEASE_KEY
  ] = undefined;
  release();
}

/**
 * Low-priority App Router prefetches share a small request queue. The consumer
 * must either snapshot the returned Response with snapshotRscResponse() or call
 * releaseAppPrefetchFetchSlot() when it drops the response without consuming it.
 */
export function scheduleAppPrefetchFetch(
  fetcher: () => Promise<Response>,
  priority: "low" | "high",
): Promise<Response> {
  if (priority === "high") {
    return fetcher();
  }

  return new Promise<Response>((resolve, reject) => {
    defaultAppPrefetchQueue.push(() => {
      let didRelease = false;
      const release = () => {
        if (didRelease) return;
        didRelease = true;
        activeDefaultAppPrefetchRequests -= 1;
        drainDefaultAppPrefetchQueue();
      };

      try {
        fetcher().then(
          (response) => {
            (response as Response & Record<symbol, (() => void) | undefined>)[
              APP_PREFETCH_FETCH_SLOT_RELEASE_KEY
            ] = release;
            resolve(response);
          },
          (error: unknown) => {
            release();
            reject(error);
          },
        );
      } catch (error) {
        release();
        reject(error);
      }
    });
    scheduleDefaultAppPrefetchDrain();
  });
}
