/**
 * Per-request gate for SSR `useSearchParams()` in a cache-candidate render.
 *
 * A candidate render may be stored under a query-free key, so the query can
 * only reach its output once the render is known to be uncacheable. Each call
 * waits until the gate is decided, once per request:
 *
 * - `"real"`: the render used a dynamic API, so it won't be stored. Calls read
 *   the real query, as in a Next.js dynamic render.
 * - `"bailout"`: the render settled without one. Calls throw
 *   `BailoutToCSRError`, so React client-renders the nearest Suspense boundary,
 *   as in Next.js's static HTML.
 */
export type SearchParamsGateDecision = "real" | "bailout";

// React reads these fields to use() a settled promise without suspending.
type ReactThenableFields = { status?: string; value?: unknown };

export type SearchParamsGate = {
  decision: SearchParamsGateDecision | null;
  /**
   * Resolves once the gate is decided. It carries React's thenable status
   * fields, so `use()` reads a decided gate without suspending.
   */
  decided: Promise<void>;
};

export type SearchParamsGateController = {
  gate: SearchParamsGate;
  /** Decide `"real"` unless the gate is already decided. */
  open(): void;
  /** Decide `"bailout"` unless the gate is already decided. */
  settle(): void;
};

export function createSearchParamsGate(options: {
  /** Runs when the gate opens, so real values always mark the render dynamic. */
  onOpen: () => void;
}): SearchParamsGateController {
  let resolve!: () => void;
  const decided = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  const thenable = decided as Promise<void> & ReactThenableFields;
  thenable.status = "pending";
  const gate: SearchParamsGate = { decision: null, decided };

  const decide = (decision: SearchParamsGateDecision): boolean => {
    if (gate.decision !== null) return false;
    gate.decision = decision;
    thenable.status = "fulfilled";
    thenable.value = undefined;
    resolve();
    return true;
  };

  return {
    gate,
    open() {
      if (decide("real")) options.onOpen();
    },
    settle() {
      decide("bailout");
    },
  };
}
