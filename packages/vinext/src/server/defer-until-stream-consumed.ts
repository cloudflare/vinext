import { AsyncLocalStorage } from "node:async_hooks";

type DeferredStreamLayer = {
  onFlush: () => void;
  onError?: (error: unknown) => void;
  onCancel?: (reason: unknown) => void;
  runInCreationContext: <T>(callback: () => T) => T;
};

// Wrappers this module returned, keyed to the callbacks they run. Workers and
// Node keep a stream's identity through `new Response(stream).body`, so a
// wrapper often comes straight back in for another layer of cleanup.
const deferredStreams = new WeakMap<ReadableStream<Uint8Array>, DeferredStreamLayer[]>();

/**
 * Defers cleanup until the downstream consumer drains or cancels the stream.
 * `onCancel` runs before the cancellation reaches the source stream.
 *
 * The wrapper reads the source directly instead of piping it through an
 * identity `TransformStream`, and a wrapper that is wrapped again before
 * anything reads it takes on the new callbacks instead of adding a layer.
 * Every streamed response passes through several of these, and each layer
 * cost a pipe, two more streams and their promise hops per chunk.
 *
 * The callbacks run in the order separate layers would run them: flush and
 * error callbacks innermost first, cancel callbacks outermost first. As with
 * the pipe, each layer's callbacks run in the async context that added them:
 * cleanup reads and clears request-scoped state, while the consumer (the
 * runtime sending the body) reads from outside that scope.
 */
export function deferUntilStreamConsumed(
  stream: ReadableStream<Uint8Array>,
  onFlush: () => void,
  onError?: (error: unknown) => void,
  onCancel?: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const layer: DeferredStreamLayer = {
    onFlush,
    onError,
    onCancel,
    runInCreationContext: AsyncLocalStorage.snapshot(),
  };
  const existing = deferredStreams.get(stream);
  if (existing && !stream.locked) {
    existing.push(layer);
    return stream;
  }

  const layers = [layer];
  let settled = false;
  const settle = (run: (layer: DeferredStreamLayer) => void, outermostFirst = false) => {
    if (settled) return;
    settled = true;
    const ordered = outermostFirst ? [...layers].reverse() : layers;
    // A throwing callback must not skip the cleanup of the other layers.
    let failure: { error: unknown } | undefined;
    for (const current of ordered) {
      try {
        current.runInCreationContext(() => run(current));
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  };

  const reader = stream.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(
        ({ done, value }) => {
          if (done) {
            settle((current) => current.onFlush());
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        (error) => {
          settle((current) => {
            current.onError?.(error);
            current.onFlush();
          });
          controller.error(error);
        },
      );
    },
    cancel(reason) {
      settle((current) => {
        current.onCancel?.(reason);
        current.onFlush();
      }, true);
      return layer.runInCreationContext(() => reader.cancel(reason));
    },
  });
  deferredStreams.set(wrapped, layers);
  return wrapped;
}
