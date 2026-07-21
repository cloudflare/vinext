const RESPONSE_ABORTED_NAME = "ResponseAborted";

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
  constructor() {
    super("The client closed the connection before the render completed.");
    this.name = RESPONSE_ABORTED_NAME;
  }
}

export function isResponseAbortedError(error: unknown): boolean {
  return error instanceof Error && error.name === RESPONSE_ABORTED_NAME;
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
        return reader.cancel(reason ?? new ResponseAbortedError());
      },
    },
    { highWaterMark: 0 },
  );
}
