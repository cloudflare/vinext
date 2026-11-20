const noop = (): void => {};

const NOT_QUEUED = Symbol("not queued");

// The microtask turns a read may take to return a chunk already queued
// upstream. Through up to three tees it took at most four, in Node and in
// workerd, and three in Node with the search params gate after them. The rest
// is margin: a chunk that isn't queued only waits this long.
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
   * settles when the stream ends, fails or is cancelled, and when the consumer
   * stops reading without cancelling while this waits, which also cancels the
   * source.
   */
  currentRunConsumed(): Promise<void>;
  /**
   * Settles as `root` does, once the run it settled in has been consumed:
   * the Flight root, decoded from {@link stream}. A root that fails to decode
   * waits too, so a consumer that stopped reading releases the source.
   */
  afterCurrentRun<T>(root: PromiseLike<T>): Promise<T>;
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
 *
 * React's Flight client stops reading, without cancelling, when it fails to
 * decode a chunk. While a run is waited for, a consumer that hasn't asked for
 * the next chunk by the next task has stopped, so the run settles then, and
 * the source is cancelled. One that is still decoding asks within a few
 * microtasks, since the Flight client decodes a chunk synchronously and reads
 * the next one right after. So only a consumer that hasn't asked within that
 * many turns, while a run is waited for, is timed: each timer costs a request
 * in workerd about a millisecond.
 */
export function trackQueuedFlightRuns(stream: ReadableStream<Uint8Array>): QueuedFlightRuns {
  const reader = stream.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  // A read started to see whether the run goes on. The next pull takes its
  // chunk, end or error.
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let lastChunkEndedRun = false;
  let cancelled = false;
  // Whether the consumer has yet to ask for the chunk after the last one, and
  // how many chunks it was handed, so the stall timer can tell whether the
  // chunk it waits on came in after it started.
  let awaitingPull = false;
  let enqueues = 0;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  let settleRun = noop;
  let run: Promise<void> | null = null;
  let runWaitedFor = false;
  const openRun = (): Promise<void> =>
    (run ??= new Promise<void>((resolve) => {
      settleRun = () => {
        resolve();
        settleRun = noop;
        runWaitedFor = false;
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

  // Errors the stream once a chunk has waited a whole task, while a run is
  // waited for, without the consumer asking for the next one.
  const timeStall = (): void => {
    if (stallTimer !== null || !runWaitedFor || !awaitingPull) return;
    const enqueuesAtStart = enqueues;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (cancelled || !runWaitedFor || !awaitingPull) return;
      // The chunk came after this timer started: give it a task too.
      if (enqueues !== enqueuesAtStart) {
        timeStall();
        return;
      }
      // The consumer stopped reading. Release the source, so a tee in front
      // of it doesn't keep queuing the rest of the payload here.
      cancelled = true;
      endRun();
      const reason = new Error("The SSR Flight client stopped reading the RSC stream.");
      reader.cancel(reason).catch(noop);
      controller.error(reason);
    }, 0);
  };
  // A consumer still reading asks for the next chunk within a few turns, so
  // only one that hasn't is timed.
  const watchForStall = (): void => {
    if (!runWaitedFor || !awaitingPull) return;
    const enqueuesAtStart = enqueues;
    void afterQueuedReadTurns().then(() => {
      if (enqueues === enqueuesAtStart) timeStall();
    });
  };

  const tracked = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
      },
      async pull() {
        awaitingPull = false;
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
        awaitingPull = true;
        enqueues++;
        watchForStall();
      },
      cancel(reason) {
        cancelled = true;
        endRun();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

  const currentRunConsumed = (): Promise<void> => {
    const consumed = openRun();
    if (settleRun !== noop) {
      runWaitedFor = true;
      watchForStall();
    }
    return consumed;
  };

  return {
    stream: tracked,
    currentRunConsumed,
    afterCurrentRun(root) {
      return Promise.resolve(root).then(
        (value) => currentRunConsumed().then(() => value),
        (error: unknown) =>
          currentRunConsumed().then(() => {
            throw error;
          }),
      );
    },
  };
}
