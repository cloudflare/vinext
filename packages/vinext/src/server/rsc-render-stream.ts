import {
  createRenderStreamCancellation,
  type RenderStreamCancellation,
} from "./app-render-abort-error.js";
import { concatUint8Arrays } from "./app-rsc-embedded-chunks.js";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";

export type RscRawRenderer = (model: unknown, options?: unknown) => ReadableStream<Uint8Array>;

const noop = (): void => {};

export function createRscRenderer(render: RscRawRenderer): RscRawRenderer {
  return (model, options) => {
    const cancellation = createRenderStreamCancellation();
    // Records the reason before the cancellation reaches React, so the
    // render's onError can tell it apart from a render failure.
    return deferUntilStreamConsumed(
      coalesceQueuedChunks(render(model, ignoreCancellationErrors(options, cancellation))),
      noop,
      undefined,
      cancellation.record,
    );
  };
}

const NOT_QUEUED = Symbol("not queued");

// The microtask turns a read takes to return a chunk the stream has already
// queued: one in Node, two in workerd. A few more leave a margin.
const QUEUED_READ_TURNS = 4;

// A joined chunk stops taking chunks once it reaches this size, so a large
// flush goes out as a few chunks of about this size, not one buffer of the
// whole flush. It is far above what a page's collection usually takes.
const MAX_JOINED_BYTES = 1024 * 1024;

function afterQueuedReadTurns(): Promise<typeof NOT_QUEUED> {
  let turns: Promise<void> = Promise.resolve();
  for (let turn = 1; turn < QUEUED_READ_TURNS; turn++) turns = turns.then(noop);
  return turns.then(() => NOT_QUEUED);
}

/**
 * Passes on, as one chunk, every chunk React has already written.
 *
 * React's edge Flight server writes one flush as several chunks of a few KB,
 * all at once. Read one at a time, through the tees between the RSC render and
 * the SSR Flight client, each chunk reaches the client a few microtasks after
 * the one before it. In the task it starts in, Fizz retries a suspended task
 * in a microtask, so it renders a client component whose children are still
 * in the next chunk. A collection that registers its items from a hidden copy
 * of its children (react-aria-components' Table, ListBox) then renders only
 * part of them. Next.js on Node writes a flush to a Node stream, which hands
 * every chunk of it to the Flight client before React renders again.
 *
 * A chunk React has not written yet is not waited for: it goes out in the
 * next chunk, like a flush React writes later. A flush larger than
 * `MAX_JOINED_BYTES` goes out in chunks of about that size.
 */
function coalesceQueuedChunks(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  // A read that was not settled when the last chunk went out. The next pull
  // takes its chunk, end or error.
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const first = await (pendingRead ?? reader.read());
        pendingRead = null;
        if (cancelled) return;
        if (first.done) {
          controller.close();
          return;
        }
        const chunks = [first.value];
        let size = first.value.byteLength;
        while (size < MAX_JOINED_BYTES) {
          const read = reader.read();
          const next = await Promise.race([read, afterQueuedReadTurns()]).catch(
            (): typeof NOT_QUEUED => NOT_QUEUED,
          );
          if (next === NOT_QUEUED || next.done) {
            pendingRead = read;
            read.catch(noop);
            break;
          }
          chunks.push(next.value);
          size += next.value.byteLength;
        }
        if (cancelled) return;
        controller.enqueue(chunks.length === 1 ? chunks[0] : concatUint8Arrays(chunks));
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** A consumer cancelling the payload is not a render failure. */
function ignoreCancellationErrors(
  options: unknown,
  cancellation: RenderStreamCancellation,
): unknown {
  if (!options || typeof options !== "object") return options;
  const onError: unknown = Reflect.get(options, "onError");
  if (typeof onError !== "function") return options;
  return {
    ...options,
    onError(error: unknown, ...rest: unknown[]) {
      if (cancellation.isReason(error)) return undefined;
      return Reflect.apply(onError, options, [error, ...rest]);
    },
  };
}
