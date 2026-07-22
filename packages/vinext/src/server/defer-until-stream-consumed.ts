/**
 * Defers cleanup until the downstream consumer drains or cancels the stream.
 */
export function deferUntilStreamConsumed(
  stream: ReadableStream<Uint8Array>,
  onFlush: () => void,
): ReadableStream<Uint8Array> {
  let called = false;
  const once = () => {
    if (!called) {
      called = true;
      onFlush();
    }
  };

  const cleanup = new TransformStream<Uint8Array, Uint8Array>({
    flush() {
      once();
    },
  });

  const reader = stream.pipeThrough(cleanup).getReader();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(
        ({ done, value }) => {
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        (error) => {
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
