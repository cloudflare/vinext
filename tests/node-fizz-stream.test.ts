import { PassThrough, Readable } from "node:stream";
import type { PipeableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createNodeTickBufferedTransform,
  pipeWithCancellationPropagation,
} from "../packages/vinext/src/server/app-ssr-stream-node.js";
import type { RscEmbedTransform } from "../packages/vinext/src/server/app-ssr-stream.js";
import { abortReactWorkWhenConsumerCloses } from "../packages/vinext/src/server/node-fizz-stream.js";

function createNoopRscEmbedTransform(): RscEmbedTransform {
  return {
    flush: () => "",
    finalize: async () => "",
    getRawBuffer: async () => new ArrayBuffer(0),
  };
}

function createTransformedWebStream(destination: PassThrough): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    pipeWithCancellationPropagation(
      destination,
      createNodeTickBufferedTransform({ rscEmbed: createNoopRscEmbedTransform() }),
    ),
  ) as ReadableStream<Uint8Array>;
}

describe("abortReactWorkWhenConsumerCloses", () => {
  it("aborts React work when the consumer destroys the Node stream", async () => {
    const destination = new PassThrough();
    const pipeable = { abort: vi.fn() } as unknown as PipeableStream;

    abortReactWorkWhenConsumerCloses(destination, () => pipeable);
    destination.destroy();

    await new Promise<void>((resolve) => {
      destination.once("close", () => resolve());
    });

    expect(pipeable.abort).toHaveBeenCalledTimes(1);
  });

  it("aborts React work when the transformed Web stream is canceled", async () => {
    const destination = new PassThrough();
    const pipeable = { abort: vi.fn() } as unknown as PipeableStream;

    abortReactWorkWhenConsumerCloses(destination, () => pipeable);
    const webStream = createTransformedWebStream(destination);

    destination.write("<html><head></head><body>");
    await webStream.cancel();

    await vi.waitFor(() => expect(pipeable.abort).toHaveBeenCalledTimes(1));
  });

  it("does not abort React work after the transformed Web stream completes", async () => {
    const destination = new PassThrough();
    const pipeable = { abort: vi.fn() } as unknown as PipeableStream;

    abortReactWorkWhenConsumerCloses(destination, () => pipeable);
    const responseText = new Response(createTransformedWebStream(destination)).text();

    destination.end("<html><head></head><body>ok</body></html>");

    await expect(responseText).resolves.toContain("ok");
    expect(pipeable.abort).not.toHaveBeenCalled();
  });

  it("does not abort React work after the Node stream completes", async () => {
    const destination = new PassThrough();
    const pipeable = { abort: vi.fn() } as unknown as PipeableStream;

    abortReactWorkWhenConsumerCloses(destination, () => pipeable);
    destination.end("ok");
    destination.resume();

    await new Promise<void>((resolve) => {
      destination.once("close", () => resolve());
    });

    expect(pipeable.abort).not.toHaveBeenCalled();
  });
});
