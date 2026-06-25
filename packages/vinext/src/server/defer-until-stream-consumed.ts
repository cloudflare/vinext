/**
 * Defers cleanup until the downstream consumer drains or cancels the stream.
 */
export function deferUntilStreamConsumed(
  stream: ReadableStream<Uint8Array>,
  onFlush: () => void,
  onAbort?: (reason: unknown) => void,
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
          onAbort?.(error);
          once();
          controller.error(error);
        },
      );
    },
    cancel(reason) {
      onAbort?.(reason);
      once();
      return reader.cancel(reason);
    },
  });
}

export function trackStreamCompletion(
  stream: ReadableStream<Uint8Array>,
  onComplete: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    onComplete();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          complete();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        complete();
        controller.error(error);
      }
    },
    cancel(reason) {
      complete();
      return reader.cancel(reason);
    },
  });
}
