const noop = (): void => {};

const NOT_QUEUED = Symbol("not queued");

// The microtask turns a read may take to return a chunk already queued
// upstream. Through up to three tees it took at most four, in Node and in
// workerd. The rest is margin: a chunk that isn't queued only waits this long.
const QUEUED_READ_TURNS = 8;

function afterQueuedReadTurns(): Promise<typeof NOT_QUEUED> {
  let turns: Promise<void> = Promise.resolve();
  for (let turn = 1; turn < QUEUED_READ_TURNS; turn++) turns = turns.then(noop);
  return turns.then(() => NOT_QUEUED);
}

export type QueuedFlightRuns = {
  /** The stream, with its chunks unchanged. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Settles once the consumer has read past the last chunk of the current run
   * of queued chunks: it asked for the next chunk after taking that one. Also
   * settles when the stream ends, fails or is cancelled.
   */
  currentRunConsumed(): Promise<void>;
};

/**
 * Tracks the runs of chunks that are queued in the stream together.
 *
 * For the SSR Flight client. React's edge Flight server writes one flush as
 * many chunks of a few KB, all at once, and the Flight client decodes them one
 * read at a time, a few microtasks apart. In the task it starts in, Fizz
 * retries a suspended task in a microtask, so it renders a client component
 * whose children are still in a later chunk of the same flush. A collection
 * that registers its items from a hidden copy of its children
 * (react-aria-components' Table, ListBox) then renders only part of them.
 * Next.js on Node decodes SSR Flight from a Node stream, which hands every
 * chunk of a flush to the Flight client before React renders again.
 *
 * A run ends at a chunk the stream has not queued yet: that is not waited for.
 */
export function trackQueuedFlightRuns(stream: ReadableStream<Uint8Array>): QueuedFlightRuns {
  const reader = stream.getReader();
  // A read started to see whether the run goes on. The next pull takes its
  // chunk, end or error.
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let lastChunkEndedRun = false;
  let cancelled = false;

  let settleRun = noop;
  let run: Promise<void> | null = null;
  const openRun = (): Promise<void> =>
    (run ??= new Promise<void>((resolve) => {
      settleRun = () => {
        resolve();
        settleRun = noop;
      };
    }));
  // A run stays settled until its next chunk arrives, so a caller asking just
  // after it ended doesn't wait for a run that may never come.
  const startRun = (): void => {
    if (settleRun === noop) run = null;
    void openRun();
  };
  const endRun = (): void => {
    void openRun();
    settleRun();
  };

  const tracked = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // The consumer took the run's last chunk and asks for more.
        if (lastChunkEndedRun) {
          lastChunkEndedRun = false;
          endRun();
        }
        let first: ReadableStreamReadResult<Uint8Array>;
        try {
          first = await (pendingRead ?? reader.read());
        } catch (error) {
          endRun();
          throw error;
        } finally {
          pendingRead = null;
        }
        if (cancelled) return;
        if (first.done) {
          endRun();
          controller.close();
          return;
        }
        startRun();
        controller.enqueue(first.value);
        const read = reader.read();
        read.catch(noop);
        pendingRead = read;
        const next = await Promise.race([read, afterQueuedReadTurns()]).catch(
          (): typeof NOT_QUEUED => NOT_QUEUED,
        );
        if (next === NOT_QUEUED || next.done) lastChunkEndedRun = true;
      },
      cancel(reason) {
        cancelled = true;
        endRun();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

  return { stream: tracked, currentRunConsumed: openRun };
}
