/**
 * Defers cleanup until the downstream consumer drains or cancels the stream.
 */
export function deferUntilStreamConsumed(
  stream: ReadableStream<Uint8Array>,
  onFlush: () => void,
  onError?: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  let called = false;
  const once = () => {
    if (!called) {
      called = true;
      onFlush();
    }
  };

  // Read the source directly instead of piping through an intermediate
  // TransformStream: one stream hop per chunk instead of two. `done` is only
  // observed after the consumer has pulled every chunk, so cleanup still runs
  // once the downstream consumer drains the stream.
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(
        ({ done, value }) => {
          if (done) {
            once();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        (error) => {
          onError?.(error);
          once();
          controller.error(error);
        },
      );
    },
    cancel(reason) {
      once();
      return reader.cancel(reason);
    },
  });
}
