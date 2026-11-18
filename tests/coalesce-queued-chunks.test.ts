import { describe, expect, it } from "vite-plus/test";
import { coalesceQueuedChunks } from "../packages/vinext/src/server/coalesce-queued-chunks.js";

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return { controller, stream };
}

async function readSizes(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number[]> {
  const sizes: number[] = [];
  for (let result = await reader.read(); !result.done; result = await reader.read()) {
    sizes.push(result.value.byteLength);
  }
  return sizes;
}

const KiB = 1024;

describe("coalesceQueuedChunks", () => {
  it("passes on the chunks written at once as one chunk", async () => {
    // React's edge Flight server writes a large flush as several chunks in one
    // go. The SSR Flight client must get them together, or Fizz renders
    // between them (#4770).
    const encoder = new TextEncoder();
    const { controller, stream } = controlledStream();
    const reader = coalesceQueuedChunks(stream).getReader();

    const firstFlush = reader.read();
    for (const row of ["0:a\n", "1:b\n", "2:c\n"]) controller.enqueue(encoder.encode(row));
    expect(new TextDecoder().decode((await firstFlush).value)).toBe("0:a\n1:b\n2:c\n");

    // A chunk written later is not waited for, and goes out on its own.
    const secondFlush = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.enqueue(encoder.encode("3:d\n"));
    controller.close();
    expect(new TextDecoder().decode((await secondFlush).value)).toBe("3:d\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("joins chunks queued behind a tee", async () => {
    const { controller, stream } = controlledStream();
    const [joined, other] = stream.tee();
    const otherDrained = (async () => {
      for await (const _ of other);
    })();
    const reader = coalesceQueuedChunks(joined).getReader();

    const firstFlush = reader.read();
    for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(10));
    controller.close();
    expect((await firstFlush).value?.byteLength).toBe(60);
    expect(await readSizes(reader)).toEqual([]);
    await otherDrained;
  });

  it("joins a large flush into chunks of at most 1 MiB, in order", async () => {
    const { controller, stream } = controlledStream();
    const reader = coalesceQueuedChunks(stream).getReader();

    const firstRead = reader.read();
    for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(256 * KiB).fill(i));
    controller.close();
    const sizes: number[] = [];
    const bytes: number[] = [];
    for (let result = await firstRead; !result.done; result = await reader.read()) {
      sizes.push(result.value.byteLength);
      bytes.push(result.value[0], result.value[result.value.byteLength - 1]);
    }
    expect(sizes).toEqual([1024 * KiB, 1024 * KiB, 512 * KiB]);
    expect(bytes).toEqual([0, 3, 4, 7, 8, 9]);
  });

  it("keeps a chunk that would bring a joined chunk past 1 MiB for the next one", async () => {
    const { controller, stream } = controlledStream();
    const reader = coalesceQueuedChunks(stream).getReader();

    const firstRead = reader.read();
    const large = new Uint8Array(2048 * KiB);
    controller.enqueue(new Uint8Array(768 * KiB));
    controller.enqueue(new Uint8Array(512 * KiB));
    controller.enqueue(large);
    controller.enqueue(new Uint8Array(10));
    controller.close();
    expect((await firstRead).value?.byteLength).toBe(768 * KiB);
    expect((await reader.read()).value?.byteLength).toBe(512 * KiB);
    // A chunk larger than the cap goes out on its own, uncopied.
    expect((await reader.read()).value).toBe(large);
    expect(await readSizes(reader)).toEqual([10]);
  });

  it("passes on the chunks before an error, then the error", async () => {
    const failure = new Error("render failed");
    const { controller, stream } = controlledStream();
    const reader = coalesceQueuedChunks(stream).getReader();

    const firstRead = reader.read();
    controller.enqueue(new Uint8Array(10));
    controller.enqueue(new Uint8Array(20));
    expect((await firstRead).value?.byteLength).toBe(30);
    const failedRead = reader.read();
    controller.error(failure);
    await expect(failedRead).rejects.toBe(failure);
  });
});
