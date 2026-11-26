/**
 * Offline detection, state and retry for `experimental.useOffline`.
 *
 * Ported from Next.js (packages/next/src/client/components/offline.ts). A
 * navigation fetch, a Server Action fetch or a prefetch that rejects with a
 * network error enters the offline state. While offline, a HEAD request to the
 * current URL polls for connectivity with a short backoff; navigations and
 * Server Actions wait on the state's promise and then retry, and prefetches
 * are held until the state resolves. `useOffline()` (next/offline) reflects the
 * state in React.
 *
 * Everything here is inert unless `process.env.__NEXT_USE_OFFLINE` is set:
 * callers guard on it, so a build without the flag tree-shakes this module.
 */

// Backoff delays for the polling loop: 500ms -> 1s -> 2s -> 3s (cap).
const BACKOFF_DELAYS_MS = [500, 1000, 2000, 3000] as const;

// Timeout for the HEAD connectivity check. A truly offline request fails almost
// instantly; one still waiting after this long reached the network.
const CONNECTIVITY_CHECK_TIMEOUT_MS = 200;

export type OfflineState = {
  promise: Promise<void>;
  resolve: () => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  backoffStep: number;
};

let offlineState: OfflineState | null = null;
let offlineChangeListener: ((isOffline: boolean) => void) | null = null;
const onlineListeners = new Set<() => void>();

/**
 * Whether `err` is a network error (and if so, enter the offline state).
 * Intentional aborts and timeouts are not network errors.
 */
export function checkOfflineError(err: unknown): boolean {
  if (err instanceof DOMException) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return false;
    }
  }
  notifyOffline();
  return true;
}

export function getOffline(): OfflineState | null {
  return offlineState;
}

export function waitForConnection(state: OfflineState): Promise<void> {
  return state.promise;
}

/** The OfflineProvider registers here to mirror the state into React. */
export function setOfflineChangeListener(listener: ((isOffline: boolean) => void) | null): void {
  offlineChangeListener = listener;
}

/** Called each time the offline state resolves (the prefetch queue resumes). */
export function subscribeToOnline(listener: () => void): () => void {
  onlineListeners.add(listener);
  return () => {
    onlineListeners.delete(listener);
  };
}

/**
 * Enter the offline state if not already in it, and start the connectivity
 * polling loop.
 */
export function notifyOffline(): OfflineState {
  if (offlineState !== null) {
    return offlineState;
  }
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  offlineState = { promise, resolve, timeoutHandle: null, backoffStep: 0 };
  offlineChangeListener?.(true);
  void checkConnectivity(offlineState);
  return offlineState;
}

/** Leave the offline state. A no-op when online. */
export function notifyOnline(): void {
  if (offlineState === null) {
    return;
  }
  if (offlineState.timeoutHandle !== null) {
    clearTimeout(offlineState.timeoutHandle);
  }
  const resolve = offlineState.resolve;
  offlineState = null;
  resolve();
  offlineChangeListener?.(false);
  for (const listener of onlineListeners) listener();
}

/**
 * HEAD request to confirm connectivity, then either resolve the offline state
 * or schedule the next check with backoff.
 */
async function checkConnectivity(state: OfflineState): Promise<void> {
  // Cancel any previously scheduled check so polling loops never run in parallel.
  if (state.timeoutHandle !== null) {
    clearTimeout(state.timeoutHandle);
    state.timeoutHandle = null;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONNECTIVITY_CHECK_TIMEOUT_MS);
  try {
    // To the current page with the RSC header: the same endpoint navigations use.
    await fetch(location.href, {
      method: "HEAD",
      headers: { RSC: "1" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    notifyOnline();
  } catch (err) {
    // Our own timeout abort means the request went out and is waiting for a
    // response: back online.
    if (err instanceof DOMException && err.name === "AbortError") {
      clearTimeout(timeoutId);
      notifyOnline();
      return;
    }
    if (offlineState !== state) return;
    const delay = BACKOFF_DELAYS_MS[Math.min(state.backoffStep, BACKOFF_DELAYS_MS.length - 1)];
    state.backoffStep++;
    state.timeoutHandle = setTimeout(() => void checkConnectivity(state), delay);
  }
}

function pingOfflineState(): void {
  if (offlineState !== null) {
    void checkConnectivity(offlineState);
  }
}

let listenersInstalled = false;

/** Browser `offline`/`online` events. Called once by the App Router browser entry. */
export function installOfflineListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  window.addEventListener("offline", notifyOffline);
  window.addEventListener("online", pingOfflineState);
}

/**
 * Run `doFetch`, and while it rejects with a network error, wait for the
 * connection to return and run it again. Any other rejection (an abort, or a
 * network error during unload) is thrown. A success leaves the offline state.
 *
 * Only for requests that are safe to repeat after a rejection: a rejected
 * fetch never reached the server, so nothing ran twice.
 */
export async function fetchRetryingWhenOffline(
  doFetch: () => Promise<Response>,
  shouldRetry: () => boolean = () => true,
): Promise<Response> {
  while (true) {
    try {
      const response = await doFetch();
      notifyOnline();
      return response;
    } catch (err) {
      if (!shouldRetry() || !checkOfflineError(err)) throw err;
      const offline = getOffline();
      if (offline !== null) {
        await waitForConnection(offline);
      }
    }
  }
}

/** Reset module state. Tests only. */
export function _resetOfflineStateForTests(): void {
  if (offlineState?.timeoutHandle != null) clearTimeout(offlineState.timeoutHandle);
  offlineState = null;
  offlineChangeListener = null;
  onlineListeners.clear();
  if (listenersInstalled && typeof window !== "undefined") {
    window.removeEventListener("offline", notifyOffline);
    window.removeEventListener("online", pingOfflineState);
  }
  listenersInstalled = false;
}
