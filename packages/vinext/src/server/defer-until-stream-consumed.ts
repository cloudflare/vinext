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

  // A manual passthrough instead of pipeThrough(new TransformStream(...)):
  // the transform's only job was firing `onFlush` on clean drain, which the
  // `done` branch below covers. It also avoids the internal pipeTo promise,
  // which rejects unhandled when the consumer cancels the stream with a
  // reason.
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
