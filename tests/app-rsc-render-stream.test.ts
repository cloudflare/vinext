import { describe, expect, it } from "vite-plus/test";
import { createRscRenderer } from "../packages/vinext/src/server/rsc-render-stream.js";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";

describe("createRscRenderer", () => {
  const { renderToReadableStream } = loadCacheFlightCodec();

  // Renders a model with a promise that stays pending, so cancelling the
  // stream aborts the render.
  function renderPendingModel(settled?: Promise<unknown>) {
    const reported: unknown[] = [];
    let markCancelled = () => {};
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const render = createRscRenderer((model, options) => {
      // React's stream, passed through so tests can wait until React has seen
      // the cancellation.
      const reader = renderToReadableStream(model, options as object).getReader();
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          async cancel(reason) {
            await reader.cancel(reason);
            markCancelled();
          },
        },
        { highWaterMark: 0 },
      );
    });
    const stream = render(
      { pending: new Promise(() => {}), settled },
      {
        onError(error: unknown) {
          reported.push(error);
          return "digest";
        },
      },
    );
    return { cancelled, reported, stream };
  }

  // React reads `then` once to decide whether the reason is a thenable.
  function thenableOnFirstRead(later: "undefined" | "throw") {
    let reads = 0;
    return {
      // oxlint-disable-next-line unicorn/no-thenable
      get then() {
        if (reads++ === 0) return () => {};
        if (later === "throw") throw new Error("then read again");
        return undefined;
      },
    };
  }

  it("forwards React's chunks unchanged, without waiting for the next one", async () => {
    // A binary row's last byte can look like the start of a character. With
    // the stream still open, holding it back would stall the row's parser.
    const chunk = new Uint8Array([...new TextEncoder().encode("1:A2,"), 0x01, 0xe3]);
    const render = createRscRenderer(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
          },
        }),
    );

    const reader = render({}).getReader();
    expect((await reader.read()).value).toBe(chunk);
    await reader.cancel();
  });

  it("does not report a cancellation with a platform's own reason", async () => {
    const { cancelled, reported, stream } = renderPendingModel();
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel(new Error("Network connection lost."));
    await cancelled;
    expect(reported).toEqual([]);
  });

  it.each([
    ["without a reason", undefined],
    ["with a promise as its reason", Promise.resolve()],
    ["with NaN as its reason", NaN],
    ["with a thenable that stops being one when read again", thenableOnFirstRead("undefined")],
    ["with a thenable that throws when read again", thenableOnFirstRead("throw")],
  ])("does not report a cancellation %s", async (_name, reason) => {
    const { cancelled, reported, stream } = renderPendingModel();
    await stream.cancel(reason);
    await cancelled;
    expect(reported).toEqual([]);
  });

  it("does not report a cancellation through a tee", async () => {
    const { cancelled, reported, stream } = renderPendingModel();
    const [first, second] = stream.tee();
    await Promise.all([first.cancel(new Error("first")), second.cancel(new Error("second"))]);
    await cancelled;
    expect(reported).toEqual([]);
  });

  it("still reports an error thrown before the cancellation", async () => {
    const failure = new Error("render failed");
    const { cancelled, reported, stream } = renderPendingModel(Promise.reject(failure));
    await expect.poll(() => reported).toEqual([failure]);
    await stream.cancel(new Error("Network connection lost."));
    await cancelled;
    expect(reported).toEqual([failure]);
  });

  it("React reports a cancel reason to onError (control)", async () => {
    const reported: unknown[] = [];
    const reason = new Error("Network connection lost.");
    const stream = renderToReadableStream(
      { pending: new Promise(() => {}) },
      { onError: (error: unknown) => void reported.push(error) },
    );
    await stream.cancel(reason);
    expect(reported).toEqual([reason]);
  });
});
