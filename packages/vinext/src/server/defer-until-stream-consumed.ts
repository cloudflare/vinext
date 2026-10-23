import { AsyncLocalStorage } from "node:async_hooks";

type DeferredStreamLayer = {
  onFlush: () => void;
  onError?: (error: unknown) => void;
  onCancel?: (reason: unknown) => void;
  runInCreationContext: <T>(callback: () => T) => T;
};

type Failure = { error: unknown };

// Wrappers this module returned that nothing has read or cancelled yet, keyed
// to the callbacks they run. Workers and Node keep a stream's identity through
// `new Response(stream).body`, so a wrapper often comes straight back in for
// another layer of cleanup. The RSC and SSR environments each load their own
// copy of this module and wrap the same HTML stream, so they share one map.
const UNREAD_WRAPPERS_KEY = Symbol.for("vinext.deferUntilStreamConsumed.unreadWrappers");
const unreadWrappers = ((globalThis as Record<PropertyKey, unknown>)[UNREAD_WRAPPERS_KEY] ??=
  new WeakMap()) as WeakMap<ReadableStream<Uint8Array>, DeferredStreamLayer[]>;

/**
 * Defers cleanup until the downstream consumer drains or cancels the stream.
 * `onCancel` runs before the cancellation reaches the source stream.
 *
 * The wrapper reads the source directly instead of piping it through an
 * identity `TransformStream`, and a wrapper that is wrapped again before
 * anything reads it takes on the new callbacks instead of adding a layer.
 * Every streamed response passes through several of these, and each layer
 * cost a pipe, two more streams and their promise hops per chunk. Nothing is
 * read ahead of the consumer, so an unread wrapper is still untouched.
 *
 * The callbacks run as separate layers would run them. Flush and error
 * callbacks run innermost first, and a layer sees the error an inner layer's
 * callback threw as its stream error. Cancel callbacks run outermost first.
 * As with the pipe, each layer's callbacks run in the async context that
 * added them, and the source is read and cancelled in the context of the
 * first layer. Cleanup reads and clears request-scoped state, and spans the
 * source starts while producing chunks need their request parent, but the
 * consumer (the runtime sending the body) reads from outside that scope.
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
  const unread = unreadWrappers.get(stream);
  if (unread) {
    unread.push(layer);
    return stream;
  }

  const layers = [layer];
  let settled = false;
  const finish = (sourceFailure: Failure | undefined): Failure | undefined => {
    let failure = sourceFailure;
    for (const current of layers) {
      current.runInCreationContext(() => {
        try {
          if (failure) current.onError?.(failure.error);
        } catch (error) {
          failure = { error };
        }
        try {
          current.onFlush();
        } catch (error) {
          failure = { error };
        }
      });
    }
    return failure;
  };

  const reader = stream.getReader();
  const wrapped = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        unreadWrappers.delete(wrapped);
        return layer
          .runInCreationContext(() => reader.read())
          .then(
            ({ done, value }) => {
              if (!done) {
                controller.enqueue(value);
                return;
              }
              if (settled) return;
              settled = true;
              const failure = finish(undefined);
              if (failure) controller.error(failure.error);
              else controller.close();
            },
            (error: unknown) => {
              if (settled) return;
              settled = true;
              controller.error(finish({ error })?.error);
            },
          );
      },
      cancel(reason) {
        unreadWrappers.delete(wrapped);
        let failure: Failure | undefined;
        if (!settled) {
          settled = true;
          for (const current of [...layers].reverse()) {
            current.runInCreationContext(() => {
              try {
                current.onCancel?.(reason);
              } catch (error) {
                failure ??= { error };
              }
              try {
                current.onFlush();
              } catch (error) {
                failure ??= { error };
              }
            });
          }
        }
        const cancelled = layer.runInCreationContext(() => reader.cancel(reason));
        if (!failure) return cancelled;
        const { error } = failure;
        return cancelled.then(() => {
          throw error;
        });
      },
    },
    { highWaterMark: 0 },
  );
  unreadWrappers.set(wrapped, layers);
  return wrapped;
}
