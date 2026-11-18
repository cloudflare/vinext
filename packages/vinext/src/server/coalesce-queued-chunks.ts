import { concatUint8Arrays } from "./app-rsc-embedded-chunks.js";

const noop = (): void => {};

const NOT_QUEUED = Symbol("not queued");

// The microtask turns a read may take to return a chunk already queued
// upstream. Through up to three tees it took at most four, in Node and in
// workerd. The rest is margin: a chunk that isn't queued only waits this long.
const QUEUED_READ_TURNS = 8;

// A joined chunk takes no chunk that would bring it past this size, so a
// large flush goes out as chunks of at most this size, not one buffer of the
// whole flush. A single larger chunk goes out on its own, uncopied.
const MAX_JOINED_BYTES = 1024 * 1024;

function afterQueuedReadTurns(): Promise<typeof NOT_QUEUED> {
  let turns: Promise<void> = Promise.resolve();
  for (let turn = 1; turn < QUEUED_READ_TURNS; turn++) turns = turns.then(noop);
  return turns.then(() => NOT_QUEUED);
}

/**
 * Passes on, as one chunk, every chunk of the stream that is already queued.
 *
 * For the SSR Flight client. React's edge Flight server writes one flush as
 * several chunks of a few KB, all at once. Read one at a time, through the tees
 * between the RSC render and SSR, each chunk reaches the Flight client a few
 * microtasks after the one before it. In the task it starts in, Fizz retries a
 * suspended task in a microtask, so it renders a client component whose
 * children are still in the next chunk. A collection that registers its items
 * from a hidden copy of its children (react-aria-components' Table, ListBox)
 * then renders only part of them. Next.js on Node decodes SSR Flight from a
 * Node stream, which hands every chunk of a flush to the Flight client before
 * React renders again.
 *
 * A chunk that is not queued yet is not waited for: it goes out in the next
 * chunk, like a flush React writes later.
 */
export function coalesceQueuedChunks(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  // A read the last chunk did not take: it was not settled yet, or its chunk
  // did not fit. The next pull takes its chunk, end or error.
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
          if (next === NOT_QUEUED || next.done || size + next.value.byteLength > MAX_JOINED_BYTES) {
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
