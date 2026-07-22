export type HydrationCachePublication = {
  commit(): void;
  complete(): void;
  fail(): void;
  invalidate(): void;
  publish(publishCandidate: () => () => void): void;
};

export function createHydrationCachePublication(): HydrationCachePublication {
  let state: "pending" | "committed" | "complete" | "invalidated" = "pending";
  let pendingPublication: (() => () => void) | null = null;
  let invalidatePublishedCandidate: (() => void) | null = null;

  const publishPendingCandidate = () => {
    if ((state !== "committed" && state !== "complete") || pendingPublication === null) return;
    const publishCandidate = pendingPublication;
    pendingPublication = null;
    invalidatePublishedCandidate = publishCandidate();
  };

  return {
    commit() {
      if (state !== "pending") return;
      state = "committed";
      publishPendingCandidate();
    },
    complete() {
      if (state === "committed") {
        state = "complete";
      }
    },
    fail() {
      if (state === "complete" || state === "invalidated") return;
      state = "invalidated";
      pendingPublication = null;
      invalidatePublishedCandidate?.();
      invalidatePublishedCandidate = null;
    },
    invalidate() {
      if (state === "invalidated") return;
      state = "invalidated";
      pendingPublication = null;
      invalidatePublishedCandidate?.();
      invalidatePublishedCandidate = null;
    },
    publish(publishCandidate) {
      if (state === "invalidated") return;
      pendingPublication = publishCandidate;
      publishPendingCandidate();
    },
  };
}
