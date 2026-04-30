/**
 * makeHangingPromise — returns a promise that never resolves during prerendering.
 *
 * When prerendering, `unstable_io()` must return a hanging promise to prevent
 * React from executing past the IO boundary. The promise never resolves—it only
 * rejects if the render signal is aborted (e.g., due to a dynamic error or
 * cache-fill completion).
 *
 * Ported from Next.js: packages/next/src/server/dynamic-rendering-utils.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/dynamic-rendering-utils.ts
 */

class HangingPromiseRejectionError extends Error {
  constructor(route: string, expression: string) {
    super(
      `Route ${route} used ${expression} during prerendering but the render was aborted. ` +
        `This is expected when prerendering is cut short (e.g. due to a dynamic access).`,
    );
    this.name = "HangingPromiseRejectionError";
  }
}

const abortListenersBySignal = new WeakMap<AbortSignal, (() => void)[]>();

function suppressUnhandledRejection(): void {
  // intentionally empty — suppresses "unhandled rejection" warnings
}

export function makeHangingPromise<T>(
  signal: AbortSignal,
  route: string,
  expression: string,
): Promise<T> {
  if (signal.aborted) {
    const rejected = Promise.reject(new HangingPromiseRejectionError(route, expression));
    rejected.catch(suppressUnhandledRejection);
    return rejected;
  }
  const hangingPromise = new Promise<T>((_, reject) => {
    const boundRejection = reject.bind(null, new HangingPromiseRejectionError(route, expression));
    const currentListeners = abortListenersBySignal.get(signal);
    if (currentListeners) {
      currentListeners.push(boundRejection);
    } else {
      const listeners = [boundRejection];
      abortListenersBySignal.set(signal, listeners);
      signal.addEventListener(
        "abort",
        () => {
          for (let i = 0; i < listeners.length; i++) {
            listeners[i]();
          }
          listeners.length = 0;
        },
        { once: true },
      );
    }
  });
  // Suppress unhandled rejection — the promise is expected to be used with
  // React's use() which handles rejections. If never awaited, the abort
  // rejection is a no-op cleanup.
  hangingPromise.catch(suppressUnhandledRejection);
  return hangingPromise;
}
