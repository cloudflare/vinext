import { describe, expect, it, vi } from "vite-plus/test";
import { trackQueuedFlightRuns } from "../packages/vinext/src/server/queued-flight-runs.js";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return { controller, stream };
}

// A stream whose `cancelled` settles with the reason it is cancelled with.
function cancellableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let markCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<unknown>((resolve) => {
    markCancelled = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel(reason) {
      markCancelled(reason);
    },
  });
  return { cancelled, controller, stream };
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

// Reads like the Flight client: one chunk per read, the next read after it.
function consume(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const finished = (async () => {
    for (let result = await reader.read(); !result.done; result = await reader.read()) {
      chunks.push(result.value);
    }
  })();
  return { chunks, finished };
}

describe("trackQueuedFlightRuns", () => {
  it("settles a run once every chunk queued with it has been read, and passes them on unchanged", async () => {
    const { controller, stream } = controlledStream();
    const flight = trackQueuedFlightRuns(stream);
    const { chunks, finished } = consume(flight.stream);

    const written = Array.from({ length: 300 }, (_, i) => new Uint8Array(4096).fill(i % 256));
    for (const chunk of written) controller.enqueue(chunk);
    await Promise.resolve();
    // Asked while the run is still being read: it waits for all of it.
    await flight.currentRunConsumed();
    expect(chunks).toEqual(written);
    expect(chunks[299]).toBe(written[299]);

    controller.close();
    await finished;
  });

  it("does not wait for a chunk that is not queued yet", async () => {
    const { controller, stream } = controlledStream();
    const flight = trackQueuedFlightRuns(stream);
    const { chunks, finished } = consume(flight.stream);

    controller.enqueue(new Uint8Array([1]));
    controller.enqueue(new Uint8Array([2]));
    await flight.currentRunConsumed();
    expect(chunks.map((chunk) => chunk[0])).toEqual([1, 2]);
    // A run that has ended stays settled until the next chunk arrives.
    await flight.currentRunConsumed();

    await nextTask();
    controller.enqueue(new Uint8Array([3]));
    await nextTask();
    await flight.currentRunConsumed();
    expect(chunks.map((chunk) => chunk[0])).toEqual([1, 2, 3]);

    controller.close();
    await finished;
  });

  it("settles a run when the stream fails, and passes the error on", async () => {
    const failure = new Error("render failed");
    const { controller, stream } = controlledStream();
    const flight = trackQueuedFlightRuns(stream);
    const reader = flight.stream.getReader();

    controller.enqueue(new Uint8Array([1]));
    expect((await reader.read()).value?.[0]).toBe(1);
    const failedRead = reader.read();
    controller.error(failure);
    await expect(failedRead).rejects.toBe(failure);
    await flight.currentRunConsumed();
  });

  it("settles a run and cancels the source when the consumer stops reading partway", async () => {
    // React's Flight client stops reading, without cancelling, when it fails
    // to decode a chunk.
    const { cancelled, controller, stream } = cancellableStream();
    const flight = trackQueuedFlightRuns(stream);
    const reader = flight.stream.getReader();

    for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array([i]));
    expect((await reader.read()).value?.[0]).toBe(0);
    expect((await reader.read()).value?.[0]).toBe(1);
    // Never reads again.
    await flight.currentRunConsumed();
    expect(await cancelled).toBeInstanceOf(Error);
    // The abandoned side is closed off too.
    await expect(reader.read()).rejects.toBeInstanceOf(Error);
  });

  it("settles when the Flight root resolves before a later chunk fails to decode", async () => {
    const { createFromReadableStream } = loadCacheFlightCodec();
    const encoder = new TextEncoder();
    const { cancelled, controller, stream } = cancellableStream();
    const flight = trackQueuedFlightRuns(stream);
    const root = createFromReadableStream(flight.stream) as Promise<unknown>;

    // The root row, then an error row the client fails to parse (it parses
    // those as it reads them), in the same run.
    controller.enqueue(encoder.encode('0:{"ok":true}\n'));
    controller.enqueue(encoder.encode("1:E{not json\n"));
    controller.enqueue(encoder.encode('2:"after"\n'));
    await expect(root).resolves.toEqual({ ok: true });
    await flight.currentRunConsumed();
    expect(await cancelled).toBeInstanceOf(Error);
  });

  it("does not cancel the source of a consumer that keeps reading", async () => {
    let cancelledWith: unknown = "not cancelled";
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const flight = trackQueuedFlightRuns(stream);
    const { chunks, finished } = consume(flight.stream);

    // Chunks a few tasks apart, as React writes later flushes.
    for (let i = 0; i < 5; i++) {
      controller.enqueue(new Uint8Array([i]));
      await nextTask();
      await nextTask();
    }
    controller.close();
    await finished;
    expect(chunks.map((chunk) => chunk[0])).toEqual([0, 1, 2, 3, 4]);
    expect(cancelledWith).toBe("not cancelled");
  });

  it("starts no timer for a consumer that keeps reading a run", async () => {
    // Each timer costs a request in workerd about a millisecond.
    const { controller, stream } = controlledStream();
    const flight = trackQueuedFlightRuns(stream);
    const { chunks, finished } = consume(flight.stream);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      for (let i = 0; i < 100; i++) controller.enqueue(new Uint8Array([i]));
      await flight.currentRunConsumed();
      expect(chunks).toHaveLength(100);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
    controller.close();
    await finished;
  });

  it("settles a run when the consumer cancels, and cancels the source", async () => {
    let cancelledWith: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const flight = trackQueuedFlightRuns(stream);
    const reader = flight.stream.getReader();
    await reader.read();
    await reader.cancel("gone");
    await flight.currentRunConsumed();
    expect(cancelledWith).toBe("gone");
  });
});
