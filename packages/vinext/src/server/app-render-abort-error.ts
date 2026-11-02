export function isAppRenderAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = Reflect.get(error, "name");
  return name === "AbortError" || name === "ResponseAborted";
}

export type RenderStreamCancellation = {
  /** Records the reason the render's output stream ended early with. */
  record: (reason: unknown) => void;
  /** Whether React is reporting that recorded cancellation as an error. */
  isReason: (error: unknown) => boolean;
};

/**
 * Tracks the cancellation of a React render's output stream.
 *
 * React aborts the render with the cancel reason and passes it to `onError`
 * as though the render had failed. Next.js cancels with its own
 * `ResponseAborted`, which `isAppRenderAbortError` skips, but the reason is
 * whatever the consumer chose: Workers runtimes cancel a disconnected
 * response's body with their own (workerd's is `Error("Network connection
 * lost.")`) and a tee picks its own reason for its source (Node passes both
 * branches' reasons). So recognize the cancellation itself rather than the
 * reason's shape.
 */
export function createRenderStreamCancellation(): RenderStreamCancellation {
  let cancelled = false;
  let cancelReason: unknown;
  return {
    record: (reason) => {
      if (cancelled) return;
      cancelled = true;
      cancelReason = reason;
    },
    isReason: (error) => {
      if (!cancelled) return false;
      if (Object.is(error, cancelReason)) return true;
      if (!(error instanceof Error)) return false;
      // React substitutes its own error for a missing or thenable reason.
      if (cancelReason === undefined) {
        return error.message === "The render was aborted by the server without a reason.";
      }
      // React only substitutes for a thenable object. Its `then` is not read
      // again here: a getter may answer differently, or throw, a second time.
      // Any other object React passes on as is, matched above.
      return (
        typeof cancelReason === "object" &&
        cancelReason !== null &&
        error.message === "The render was aborted by the server with a promise."
      );
    },
  };
}
