const RESPONSE_ABORTED_NAME = "ResponseAborted";
const RESPONSE_ABORTED_BRAND = Symbol.for("vinext.responseAborted");

/**
 * Cancellation reason used when the response consumer goes away (client
 * disconnect, aborted navigation). Spec-compliant server runtimes cancel the
 * response body stream in that situation, usually with no reason; React then
 * aborts the in-flight render with "The render was aborted by the server
 * without a reason." and every aborted task reaches the render `onError`,
 * where it would be reported through `onRequestError` as if it were a real
 * failure.
 *
 * Tagging the cancellation at the response boundary lets the error handlers
 * classify these aborts as expected control flow instead. Mirrors Next.js's
 * `ResponseAborted` (`server/web/spec-extension/adapters/next-request.ts`) and
 * its `isAbortError` handling in `server/pipe-readable.ts`, which swallows
 * exactly this class of error.
 */
export class ResponseAbortedError extends Error {
  readonly [RESPONSE_ABORTED_BRAND] = true;

  constructor(cause?: unknown) {
    super(
      "The client closed the connection before the render completed.",
      ...(cause !== undefined ? [{ cause }] : []),
    );
    this.name = RESPONSE_ABORTED_NAME;
  }
}

export function isResponseAbortedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Partial<Record<typeof RESPONSE_ABORTED_BRAND, unknown>>)[RESPONSE_ABORTED_BRAND] ===
      true
  );
}

function isDomAbortError(reason: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    reason instanceof DOMException &&
    reason.name === "AbortError"
  );
}

/**
 * Wrap a render stream that is about to become a Response body so that a
 * consumer cancellation with no reason reaches the underlying render as a
 * tagged {@link ResponseAbortedError} instead of an anonymous abort.
 */
export function tagConsumerCancellation(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        return reader.read().then(
          ({ done, value }) => {
            if (cancelled) return;
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          },
          (error) => {
            if (cancelled) return;
            controller.error(error);
          },
        );
      },
      cancel(reason) {
        cancelled = true;
        if (reason == null) {
          return reader.cancel(new ResponseAbortedError());
        }
        // Runtimes that propagate a standard aborted signal cancel with a
        // DOMException named AbortError; that is still a consumer abort.
        if (isDomAbortError(reason)) {
          return reader.cancel(new ResponseAbortedError(reason));
        }
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
