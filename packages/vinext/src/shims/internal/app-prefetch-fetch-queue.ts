"use client";

const APP_PREFETCH_FETCH_SLOT_RELEASE_KEY = Symbol.for("vinext.appPrefetchFetchSlotRelease");

const MAX_DEFAULT_APP_PREFETCH_REQUESTS = 4;
const defaultAppPrefetchQueue: Array<() => void> = [];
type AppPrefetchFetchControl = {
  cancel: () => void;
  runner?: () => void;
};
/** Lets a consumer promote or cancel the request behind a promise it already holds. */
const appPrefetchFetchControls = new WeakMap<Promise<Response>, AppPrefetchFetchControl>();
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
  fetcher: (signal: AbortSignal) => Promise<Response>,
  priority: "low" | "high",
): Promise<Response> {
  const controller = new AbortController();
  if (priority === "high") {
    const promise = fetcher(controller.signal);
    const control = { cancel: () => controller.abort() };
    appPrefetchFetchControls.set(promise, control);
    void promise.then(
      (response) => {
        // Keep cancellation live while the response body streams. The
        // consumer releases this after snapshotting (or when dropping a
        // non-success response), matching the low-priority lifecycle below.
        (response as Response & Record<symbol, (() => void) | undefined>)[
          APP_PREFETCH_FETCH_SLOT_RELEASE_KEY
        ] = () => appPrefetchFetchControls.delete(promise);
      },
      () => appPrefetchFetchControls.delete(promise),
    );
    return promise;
  }

  let runner!: () => void;
  let rejectPromise!: (reason?: unknown) => void;
  let started = false;
  const promise = new Promise<Response>((resolve, reject) => {
    rejectPromise = reject;
    runner = () => {
      started = true;
      let didRelease = false;
      const release = () => {
        if (didRelease) return;
        didRelease = true;
        appPrefetchFetchControls.delete(promise);
        activeDefaultAppPrefetchRequests -= 1;
        drainDefaultAppPrefetchQueue();
      };

      try {
        fetcher(controller.signal).then(
          (response) => {
            (response as Response & Record<symbol, (() => void) | undefined>)[
              APP_PREFETCH_FETCH_SLOT_RELEASE_KEY
            ] = release;
            resolve(response);
          },
          (error: unknown) => {
            appPrefetchFetchControls.delete(promise);
            release();
            reject(error);
          },
        );
      } catch (error) {
        appPrefetchFetchControls.delete(promise);
        release();
        reject(error);
      }
    };
  });

  defaultAppPrefetchQueue.push(runner);
  appPrefetchFetchControls.set(promise, {
    runner,
    cancel: () => {
      if (started) {
        controller.abort();
        return;
      }
      const index = defaultAppPrefetchQueue.indexOf(runner);
      if (index === -1) return;
      defaultAppPrefetchQueue.splice(index, 1);
      appPrefetchFetchControls.delete(promise);
      controller.abort();
      rejectPromise(controller.signal.reason);
    },
  });
  scheduleDefaultAppPrefetchDrain();
  return promise;
}

/** Cancel a queued or in-flight prefetch request. No-op once it has settled. */
export function cancelAppPrefetchFetch(promise: Promise<Response> | undefined): void {
  if (promise === undefined) return;
  appPrefetchFetchControls.get(promise)?.cancel();
}

/**
 * Start a still-queued prefetch request immediately.
 *
 * A navigation that reuses an in-flight prefetch awaits that prefetch's
 * promise. When the request is only queued, the navigation would otherwise wait
 * for unrelated prefetch response bodies to finish before its own request even
 * starts — indefinitely if one of those streams stalls. A promoted request is
 * no longer a prefetch, it is the navigation, so it bypasses the concurrency
 * cap instead of waiting for a slot.
 *
 * No-op when the request has already started or was never queued.
 */
export function promoteAppPrefetchFetch(promise: Promise<Response> | undefined): void {
  if (promise === undefined) return;
  const control = appPrefetchFetchControls.get(promise);
  const runner = control?.runner;
  if (runner === undefined) return;

  const index = defaultAppPrefetchQueue.indexOf(runner);
  if (index === -1) return;
  defaultAppPrefetchQueue.splice(index, 1);

  activeDefaultAppPrefetchRequests += 1;
  runner();
}
