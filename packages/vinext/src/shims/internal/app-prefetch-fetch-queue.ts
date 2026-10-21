"use client";

const APP_PREFETCH_FETCH_SLOT_RELEASE_KEY = Symbol.for("vinext.appPrefetchFetchSlotRelease");

const MAX_DEFAULT_APP_PREFETCH_REQUESTS = 4;
const defaultAppPrefetchQueue: Array<() => void> = [];
type AppPrefetchFetchControl = {
  cancel: () => void;
  cancelQueued?: () => void;
  runner?: (promoted?: boolean) => void;
};
/** Lets a consumer promote or cancel the request behind a promise it already holds. */
const appPrefetchFetchControls = new WeakMap<Promise<Response>, AppPrefetchFetchControl>();
/**
 * Navigations waiting on a promise, each live while it is current, with the
 * sequence number it was claimed at.
 */
const appPrefetchFetchClaims = new WeakMap<Promise<Response>, Map<() => boolean, number>>();
let appPrefetchFetchClaimSequence = 0;
let activeDefaultAppPrefetchRequests = 0;
let defaultAppPrefetchDrainScheduled = false;

// Next.js holds every prefetch request for 300ms after a revalidating Server
// Action so the revalidation can propagate through CDN caches
// (REVALIDATION_COOLDOWN_MS in client/components/segment-cache/scheduler.ts).
const REVALIDATION_COOLDOWN_MS = 300;
let revalidationCooldownTimer: ReturnType<typeof setTimeout> | null = null;
/** High-priority requests held by the cooldown, which skip the queue's cap. */
const cooldownHighPriorityQueue: Array<() => void> = [];
const cooldownWaiters: Array<() => void> = [];
const cooldownStartListeners = new Set<() => void>();

/**
 * Hold prefetch requests for the revalidation cooldown. A later call restarts
 * the window. Navigations are never held: one that finds its prefetch held
 * fetches its own response instead.
 */
export function startAppPrefetchRevalidationCooldown(): void {
  if (revalidationCooldownTimer !== null) clearTimeout(revalidationCooldownTimer);
  for (const listener of cooldownStartListeners) listener();
  revalidationCooldownTimer = setTimeout(() => {
    revalidationCooldownTimer = null;
    for (const run of cooldownHighPriorityQueue.splice(0)) run();
    for (const resume of cooldownWaiters.splice(0)) resume();
    drainDefaultAppPrefetchQueue();
  }, REVALIDATION_COOLDOWN_MS);
}

/**
 * Prefetches that send their payload request only after another request, e.g.
 * a route tree or loading shell. Promoting the outer promise can't start the
 * request the cooldown holds, so a navigation shouldn't wait on one.
 */
const gatedAppPrefetchFetches = new WeakSet<Promise<Response>>();

export function markGatedAppPrefetchFetch(promise: Promise<Response>): Promise<Response> {
  gatedAppPrefetchFetches.add(promise);
  return promise;
}

/**
 * Whether the revalidation cooldown holds the request behind `promise`: it is
 * still queued, or it is a gated prefetch whose payload request is yet to come.
 */
export function isAppPrefetchFetchHeldByRevalidationCooldown(
  promise: Promise<Response> | undefined,
): boolean {
  if (promise === undefined || revalidationCooldownTimer === null) return false;
  if (gatedAppPrefetchFetches.has(promise)) return true;
  const runner = appPrefetchFetchControls.get(promise)?.runner;
  return (
    runner !== undefined &&
    (cooldownHighPriorityQueue.includes(runner) || defaultAppPrefetchQueue.includes(runner))
  );
}

/**
 * Wait for `pending`, the settled state of the prefetch request behind
 * `promise`, unless the revalidation cooldown starts during the wait and holds
 * it: a gated prefetch sends its payload request only later. Next.js
 * navigations never wait on a held prefetch, so this resolves false and the
 * navigation fetches its own response.
 */
export async function waitForAppPrefetchUnlessHeldByRevalidationCooldown(
  promise: Promise<Response> | undefined,
  pending: Promise<unknown>,
): Promise<boolean> {
  const settled = pending.then(
    () => true,
    () => true,
  );
  if (promise === undefined || !gatedAppPrefetchFetches.has(promise)) return settled;
  if (isAppPrefetchFetchHeldByRevalidationCooldown(promise)) return false;
  let unsubscribe = () => {};
  const held = new Promise<boolean>((resolve) => {
    const listener = () => resolve(false);
    cooldownStartListeners.add(listener);
    unsubscribe = () => cooldownStartListeners.delete(listener);
  });
  try {
    return await Promise.race([settled, held]);
  } finally {
    unsubscribe();
  }
}

/** Resolves once no revalidation cooldown holds prefetch requests. */
export function waitForAppPrefetchRevalidationCooldown(): Promise<void> {
  if (revalidationCooldownTimer === null) return Promise.resolve();
  return new Promise((resolve) => cooldownWaiters.push(resolve));
}

function drainDefaultAppPrefetchQueue(): void {
  defaultAppPrefetchDrainScheduled = false;
  while (
    revalidationCooldownTimer === null &&
    activeDefaultAppPrefetchRequests < MAX_DEFAULT_APP_PREFETCH_REQUESTS
  ) {
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
 *
 * `isWanted` is checked when a queued request reaches a free slot. Returning
 * false drops it without fetching, like a cancelled Next.js prefetch task. A
 * navigation that promotes the request skips the check.
 */
export function scheduleAppPrefetchFetch(
  fetcher: (signal: AbortSignal) => Promise<Response>,
  priority: "low" | "high",
  isWanted?: () => boolean,
): Promise<Response> {
  const controller = new AbortController();
  if (priority === "high" && revalidationCooldownTimer !== null) {
    return scheduleCooldownHighPriorityFetch(fetcher, controller, isWanted);
  }
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

  let runner!: (promoted?: boolean) => void;
  let rejectPromise!: (reason?: unknown) => void;
  let started = false;
  const promise = new Promise<Response>((resolve, reject) => {
    rejectPromise = reject;
    runner = (promoted = false) => {
      if (!promoted && isWanted?.() === false) {
        // Only the drain loop reaches here; it moves on to the next request.
        appPrefetchFetchControls.delete(promise);
        activeDefaultAppPrefetchRequests -= 1;
        reject(new DOMException("Prefetch is no longer wanted", "AbortError"));
        return;
      }
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

  const cancelQueued = () => {
    if (started) return;
    const index = defaultAppPrefetchQueue.indexOf(runner);
    if (index === -1) return;
    defaultAppPrefetchQueue.splice(index, 1);
    appPrefetchFetchControls.delete(promise);
    controller.abort();
    rejectPromise(controller.signal.reason);
  };
  defaultAppPrefetchQueue.push(runner);
  appPrefetchFetchControls.set(promise, {
    runner,
    cancelQueued,
    cancel: () => {
      if (started) controller.abort();
      else cancelQueued();
    },
  });
  scheduleDefaultAppPrefetchDrain();
  return promise;
}

function scheduleCooldownHighPriorityFetch(
  fetcher: (signal: AbortSignal) => Promise<Response>,
  controller: AbortController,
  isWanted: (() => boolean) | undefined,
): Promise<Response> {
  let runner!: () => void;
  let rejectPromise!: (reason?: unknown) => void;
  let started = false;
  const promise = new Promise<Response>((resolve, reject) => {
    rejectPromise = reject;
    runner = () => {
      if (isWanted?.() === false) {
        appPrefetchFetchControls.delete(promise);
        reject(new DOMException("Prefetch is no longer wanted", "AbortError"));
        return;
      }
      started = true;
      try {
        fetcher(controller.signal).then(
          (response) => {
            (response as Response & Record<symbol, (() => void) | undefined>)[
              APP_PREFETCH_FETCH_SLOT_RELEASE_KEY
            ] = () => appPrefetchFetchControls.delete(promise);
            resolve(response);
          },
          (error: unknown) => {
            appPrefetchFetchControls.delete(promise);
            reject(error);
          },
        );
      } catch (error) {
        appPrefetchFetchControls.delete(promise);
        reject(error);
      }
    };
  });

  const cancelQueued = () => {
    if (started) return;
    const index = cooldownHighPriorityQueue.indexOf(runner);
    if (index === -1) return;
    cooldownHighPriorityQueue.splice(index, 1);
    appPrefetchFetchControls.delete(promise);
    controller.abort();
    rejectPromise(controller.signal.reason);
  };
  cooldownHighPriorityQueue.push(runner);
  appPrefetchFetchControls.set(promise, {
    runner,
    cancelQueued,
    cancel: () => {
      if (started) controller.abort();
      else cancelQueued();
    },
  });
  return promise;
}

/** Cancel a prefetch request that is still waiting for a slot; never aborts one in flight. */
export function cancelQueuedAppPrefetchFetch(promise: Promise<Response>): void {
  appPrefetchFetchControls.get(promise)?.cancelQueued?.();
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
 * No-op when the request has already started, was never queued, or is held by
 * the revalidation cooldown (see isAppPrefetchFetchHeldByRevalidationCooldown).
 *
 * Also records a claim, live while `isCurrent` returns true, until the returned
 * function releases it; see `isAppPrefetchFetchClaimed`.
 */
export function promoteAppPrefetchFetch(
  promise: Promise<Response> | undefined,
  isCurrent: () => boolean = () => true,
): () => void {
  if (promise === undefined) return () => {};
  let claims = appPrefetchFetchClaims.get(promise);
  if (claims === undefined) {
    claims = new Map();
    appPrefetchFetchClaims.set(promise, claims);
  }
  claims.set(isCurrent, ++appPrefetchFetchClaimSequence);
  const release = () => {
    claims.delete(isCurrent);
  };

  if (revalidationCooldownTimer !== null) return release;
  const control = appPrefetchFetchControls.get(promise);
  const runner = control?.runner;
  if (runner === undefined) return release;

  const index = defaultAppPrefetchQueue.indexOf(runner);
  if (index === -1) return release;
  defaultAppPrefetchQueue.splice(index, 1);

  activeDefaultAppPrefetchRequests += 1;
  runner(true);
  return release;
}

/**
 * Whether a current navigation is waiting on this prefetch. A staged prefetch
 * (route tree, then payload) hands navigation a promise that wraps its queued
 * requests, so promotion cannot reach them; they check this instead before
 * dropping themselves.
 *
 * `claimedBy` limits this to claims made up to that `getAppPrefetchFetchClaimSequence()`.
 */
export function isAppPrefetchFetchClaimed(
  promise: Promise<Response> | undefined,
  claimedBy = Infinity,
): boolean {
  const claims = promise && appPrefetchFetchClaims.get(promise);
  if (!claims) return false;
  for (const [isCurrent, sequence] of claims) {
    if (sequence <= claimedBy && isCurrent()) return true;
  }
  return false;
}

/** The sequence number of the latest claim on any prefetch. */
export function getAppPrefetchFetchClaimSequence(): number {
  return appPrefetchFetchClaimSequence;
}
