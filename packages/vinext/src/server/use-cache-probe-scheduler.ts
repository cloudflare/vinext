/**
 * "use cache" deadlock probe scheduler (dev-only)
 *
 * Ported from Next.js: packages/next/src/server/use-cache/use-cache-probe-scheduler.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-probe-scheduler.ts
 *
 * Monitors a hanging "use cache" function execution in dev. If the Promise
 * has not settled for ~10s, spawns a probe worker that re-executes the same
 * function with a fresh module scope. If the probe completes while the main
 * execution is still hung, the hang is attributable to module-scope state
 * and we surface a UseCacheDeadlockError instead of waiting for the generic
 * timeout.
 *
 * Vinext adaptation: Next.js monitors a ReadableStream (cache-fill stream).
 * Vinext dev mode skips shared caching entirely, so there is no stream — we
 * monitor the Promise directly via idle-time tracking.
 */

import { getUseCacheProbe, type UseCacheProbeRequestSnapshot } from "./use-cache-probe-globals.js";

function getProbeThresholdMs(): number {
  const env =
    typeof process !== "undefined" ? Number(process.env.__VINEXT_PROBE_THRESHOLD_MS) : NaN;
  if (Number.isFinite(env) && env > 0) return env;
  return 10_000;
}

function getProbeMinBudgetMs(): number {
  const env =
    typeof process !== "undefined" ? Number(process.env.__VINEXT_PROBE_MIN_BUDGET_MS) : NaN;
  if (Number.isFinite(env) && env > 0) return env;
  return 3_000;
}

type SetupPromiseProbeOptions = {
  /** The function identifier (module path + export name). */
  id: string;
  /** Cache variant. */
  variant: string;
  /** Serialized arguments for the probe worker. */
  encodedArguments: string;
  /** Snapshot of the outer request store for private caches. */
  requestSnapshot: UseCacheProbeRequestSnapshot;
  /** Absolute monotonic deadline at which the outer fill will be aborted. */
  fillDeadlineAt: number;
  /** Aborts when the probe should stop watching (fill settled, timeout, etc.). */
  abortSignal: AbortSignal;
  /**
   * Called once if the probe ran the cache function to completion in isolation
   * while the main fill was still pending. The caller aborts the main fill
   * with UseCacheDeadlockError.
   */
  onProbeCompleted: () => void;
};

/**
 * Schedule an idle-deadline probe over a hanging "use cache" Promise (dev-only).
 *
 * Returns a cleanup function that clears any pending timers. The caller must
 * call it when the main Promise settles (success or error).
 */
export function setupPromiseProbe(options: SetupPromiseProbeOptions): () => void {
  const {
    fillDeadlineAt,
    abortSignal,
    onProbeCompleted,
    id,
    variant,
    encodedArguments,
    requestSnapshot,
  } = options;

  // Skip if there isn't enough time left for both the idle threshold and a
  // minimum probe budget.
  const probeThresholdMs = getProbeThresholdMs();
  const minBudgetMs = getProbeMinBudgetMs();
  if (fillDeadlineAt - performance.now() < probeThresholdMs + minBudgetMs) {
    return () => {};
  }

  const probe = getUseCacheProbe();
  if (!probe) {
    return () => {};
  }

  let lastProgressAt = performance.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const startProbe = () => {
    if (abortSignal.aborted) return;

    const probeStartedAtProgress = lastProgressAt;

    // Reserve a 1s buffer so the probe's internal timeout fires before the
    // outer render timeout.
    const probeInternalTimeoutMs = Math.max(1_000, fillDeadlineAt - performance.now() - 1_000);

    probe({
      modulePath: id.split(":")[0] ?? id,
      id,
      variant,
      encodedArguments,
      request: requestSnapshot,
      timeoutMs: probeInternalTimeoutMs,
    }).then(
      (completed) => {
        // Mid-probe recovery: if progress was made while the probe ran, discard
        // the result rather than reporting a stale deadlock.
        if (lastProgressAt > probeStartedAtProgress) return;
        if (completed && !abortSignal.aborted) {
          onProbeCompleted();
        }
      },
      () => {
        // Probe failures are inconclusive; fall back to regular timeout.
      },
    );
  };

  const scheduleAfterIdle = () => {
    if (idleTimer !== undefined || abortSignal.aborted) return;
    const now = performance.now();
    const idleFor = now - lastProgressAt;
    const wait = Math.max(0, probeThresholdMs - idleFor);

    if (fillDeadlineAt - now < wait + minBudgetMs) return;

    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (abortSignal.aborted) return;
      const idleNow = performance.now() - lastProgressAt;
      if (idleNow < probeThresholdMs) {
        // Progress arrived since we set this timer — reschedule.
        scheduleAfterIdle();
        return;
      }
      startProbe();
    }, wait);
  };

  abortSignal.addEventListener(
    "abort",
    () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    },
    { once: true },
  );

  scheduleAfterIdle();

  // Return a "report progress" function the caller calls whenever the main
  // Promise makes progress (e.g. a microtask completes, a chunk arrives, etc.).
  // In the simple Promise case, there is no granular progress, so we rely on
  // the mid-probe recovery check to avoid false positives when the Promise
  // settles during the probe.
  return () => {
    lastProgressAt = performance.now();
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    scheduleAfterIdle();
  };
}
