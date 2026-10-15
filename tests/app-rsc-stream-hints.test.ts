import { describe, expect, it } from "vite-plus/test";
import { createRscEmbedTransform } from "../packages/vinext/src/server/app-ssr-stream.js";
import {
  createRscRenderer,
  normalizeReactFlightPreloadHints,
} from "../packages/vinext/src/server/rsc-stream-hints.js";
import { loadCacheFlightCodec } from "./helpers/cache-flight-codec.js";

const STYLE_JSON_PADDING = " ".repeat("stylesheet".length - "style".length);

function normalizedStyleHint(hint: string): string {
  return hint.replace('"stylesheet"', `"style"${STYLE_JSON_PADDING}`);
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }

  return text + decoder.decode();
}

describe("RSC stream hint helpers", () => {
  it("rewrites React Flight stylesheet preload hints", async () => {
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks([
        ':HL["/assets/app.css","stylesheet"]\n',
        '2:HL["/assets/page.css","stylesheet",{"crossOrigin":""}]\n',
        '3:HL["/assets/font.woff2","font"]\n',
      ]),
    );

    await expect(readStream(stream)).resolves.toBe(
      normalizedStyleHint(':HL["/assets/app.css","stylesheet"]\n') +
        normalizedStyleHint('2:HL["/assets/page.css","stylesheet",{"crossOrigin":""}]\n') +
        '3:HL["/assets/font.woff2","font"]\n',
    );
  });

  it("only rewrites stylesheet preload hints in mixed Flight content", async () => {
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks([
        '0:D{"name":"page"}\n' +
          ':HL["/assets/a.css","stylesheet",{"crossOrigin":""}]\n' +
          '1:["$","link",null,{"rel":"stylesheet","href":"/assets/b.css"}]\n' +
          ':HL["/assets/c.css","style"]\n' +
          ':HL["/assets/d.css","stylesheet"]\n',
      ]),
    );

    await expect(readStream(stream)).resolves.toBe(
      '0:D{"name":"page"}\n' +
        normalizedStyleHint(':HL["/assets/a.css","stylesheet",{"crossOrigin":""}]\n') +
        '1:["$","link",null,{"rel":"stylesheet","href":"/assets/b.css"}]\n' +
        ':HL["/assets/c.css","style"]\n' +
        normalizedStyleHint(':HL["/assets/d.css","stylesheet"]\n'),
    );
  });

  it("buffers partial Flight lines across chunks before rewriting hints", async () => {
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks([':HL["/assets/app.css",', '"styles', 'heet"]\n0:D{"name":"page"}\n']),
    );

    await expect(readStream(stream)).resolves.toBe(
      normalizedStyleHint(':HL["/assets/app.css","stylesheet"]\n') + '0:D{"name":"page"}\n',
    );
  });

  it("rewrites a final unterminated Flight line during flush", async () => {
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks([':HL["/assets/app.css","stylesheet"]']),
    );

    await expect(readStream(stream)).resolves.toBe(
      normalizedStyleHint(':HL["/assets/app.css","stylesheet"]'),
    );
  });

  it("does not rewrite hint-like text inside a length-prefixed row", async () => {
    const body =
      'user text 0:HL["/user.css","stylesheet"]\n' +
      '2:HL["/also-user-controlled.css","stylesheet"]';
    const header = `a:T${new TextEncoder().encode(body).byteLength.toString(16)},`;
    const hint = ':HL["/assets/app.css","stylesheet"]\n';
    const payload = header + body + hint;
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks([
        payload.slice(0, 3),
        payload.slice(3, header.length + 10),
        payload.slice(header.length + 10, header.length + body.length - 4),
        payload.slice(header.length + body.length - 4),
      ]),
    );

    await expect(readStream(stream)).resolves.toBe(
      header + body + normalizedStyleHint(':HL["/assets/app.css","stylesheet"]\n'),
    );
  });

  it("keeps stylesheet hint rewrites byte-length preserving", async () => {
    const input = ':HL["/assets/app.css","stylesheet",{"crossOrigin":""}]\n';
    const output = await readStream(normalizeReactFlightPreloadHints(streamFromChunks([input])));

    expect(output).toBe(normalizedStyleHint(input));
    expect(new TextEncoder().encode(output)).toHaveLength(
      new TextEncoder().encode(input).byteLength,
    );
    expect(JSON.parse(output.slice(output.indexOf("[")).trim())).toEqual([
      "/assets/app.css",
      "style",
      { crossOrigin: "" },
    ]);
  });

  it("recognizes React canary byte-stream rows as length-prefixed", async () => {
    const body = 'binary text\n:HL["/user.css","stylesheet"]';
    const header = `a:b${new TextEncoder().encode(body).byteLength.toString(16)},`;
    const hint = ':HL["/assets/app.css","stylesheet"]\n';

    await expect(
      readStream(normalizeReactFlightPreloadHints(streamFromChunks([header, body, hint]))),
    ).resolves.toBe(header + body + normalizedStyleHint(hint));
  });

  it("passes through the rest of the stream after an unknown row tag", async () => {
    const body = 'opaque bytes\n:HL["/user.css","stylesheet"]';
    const header = `a:q${new TextEncoder().encode(body).byteLength.toString(16)},`;
    const laterHint = ':HL["/assets/app.css","stylesheet"]\n';
    const payload = header + body + laterHint;

    await expect(
      readStream(
        normalizeReactFlightPreloadHints(
          streamFromChunks([payload.slice(0, 3), payload.slice(3, 12), payload.slice(12)]),
        ),
      ),
    ).resolves.toBe(payload);
  });

  it("passes through the rest of the stream after a malformed length header", async () => {
    const payload =
      'a:Tnot-hex,opaque bytes\n:HL["/user.css","stylesheet"]\n' +
      ':HL["/assets/app.css","stylesheet"]\n';

    await expect(
      readStream(
        normalizeReactFlightPreloadHints(
          streamFromChunks([payload.slice(0, 5), payload.slice(5, 17), payload.slice(17)]),
        ),
      ),
    ).resolves.toBe(payload);
  });

  it("keeps upstream chunk boundaries instead of emitting one chunk per row", async () => {
    // Every downstream consumer pays a per-chunk cost, so complete rows in a
    // chunk must be forwarded together rather than split per Flight row.
    const encoder = new TextEncoder();
    const first = encoder.encode('0:D{"name":"page"}\n1:["$","div",null,{}]\n2:I["a",[],"b"]\n');
    const second = encoder.encode('3:["$","span",null,{}]\n4:"text"\n');
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });

    const reader = normalizeReactFlightPreloadHints(source).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }

    expect(chunks).toHaveLength(2);
    // Chunks without a stylesheet hint are forwarded without copying.
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(second);
  });

  it("rewrites a hint row split across chunks and forwards the complete prefix", async () => {
    const payload =
      '0:D{"name":"page"}\n:HL["/assets/app.css","stylesheet"]\n1:["$","div",null,{}]\n';
    const splitAt = payload.indexOf("stylesheet");
    const reader = normalizeReactFlightPreloadHints(
      streamFromChunks([payload.slice(0, splitAt), payload.slice(splitAt)]),
    ).getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(decoder.decode(result.value));
    }

    expect(chunks).toEqual([
      '0:D{"name":"page"}\n',
      normalizedStyleHint(':HL["/assets/app.css","stylesheet"]\n') + '1:["$","div",null,{}]\n',
    ]);
  });

  it("forwards a long non-hint row chunk by chunk instead of carrying it to its newline", async () => {
    // Carrying the row would concatenate and rescan it on every chunk:
    // quadratic in its length. A page's client props arrive as one such row.
    const encoder = new TextEncoder();
    const inputs = [
      encoder.encode('0:D{"name":"page"}\n1:{"items":["'),
      ...Array.from({ length: 2000 }, () => encoder.encode("x".repeat(1024))),
      encoder.encode('"]}\n2:"after"\n'),
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const input of inputs) controller.enqueue(input);
        controller.close();
      },
    });

    const reader = normalizeReactFlightPreloadHints(source).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }

    expect(chunks).toHaveLength(inputs.length);
    for (const [index, input] of inputs.entries()) expect(chunks[index]).toBe(input);
  });

  it("still carries a row that may be a stylesheet hint when a chunk ends at its tag", async () => {
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks(['0:D{"name":"page"}\n:H', 'L["/assets/app.css","stylesheet"]\n']),
    );

    await expect(readStream(stream)).resolves.toBe(
      '0:D{"name":"page"}\n' + normalizedStyleHint(':HL["/assets/app.css","stylesheet"]\n'),
    );
  });

  it("rewrites a hint that follows a forwarded row's newline in the same chunk", async () => {
    const inputs = [
      '0:D{"name":"page"}\n1:{"items":["',
      "x".repeat(64),
      '"]}\n:HL["/assets/app.css","stylesheet"]\n2:"after"\n',
    ];
    const reader = normalizeReactFlightPreloadHints(streamFromChunks(inputs)).getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(decoder.decode(result.value));
    }

    expect(chunks).toEqual([
      inputs[0],
      inputs[1],
      '"]}\n' + normalizedStyleHint(':HL["/assets/app.css","stylesheet"]\n') + '2:"after"\n',
    ]);
  });

  it("forwards a plain row only up to its last complete UTF-8 character", async () => {
    // The inline RSC embed decodes each chunk on its own, so a chunk ending
    // mid-character would be embedded as base64 instead of text.
    const encoder = new TextEncoder();
    const row = encoder.encode('0:D{"name":"page"}\n1:{"t":"あい😀"}\n');
    const hint = ':HL["/assets/app.css","stylesheet"]\n';
    const firstSplit = row.indexOf(0x81) + 1; // inside あ
    const secondSplit = row.indexOf(0x9f) + 1; // inside 😀
    const inputs = [
      row.slice(0, firstSplit),
      row.slice(firstSplit, secondSplit),
      new Uint8Array([...row.slice(secondSplit), ...encoder.encode(hint)]),
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const input of inputs) controller.enqueue(input);
        controller.close();
      },
    });

    const reader = normalizeReactFlightPreloadHints(source).getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(decoder.decode(result.value));
    }

    expect(chunks).toEqual([
      '0:D{"name":"page"}\n1:{"t":"',
      "あい",
      '😀"}\n' + normalizedStyleHint(hint),
    ]);
  });

  it("keeps binary Flight bodies separate from adjacent text when embedding", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`0:D{"data":"${"x".repeat(1024)}"}\n1:A1,`);
    const suffix = encoder.encode('2:["done"]\n');
    const payload = new Uint8Array(prefix.length + 1 + suffix.length);
    payload.set(prefix);
    payload[prefix.length] = 0xff;
    payload.set(suffix, prefix.length + 1);

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const embed = createRscEmbedTransform(normalizeReactFlightPreloadHints(source));
    const scripts = await embed.finalize();

    expect(scripts).toContain('.rsc.push([3,"/w=="])');
    expect(new Uint8Array(await embed.getRawBuffer())).toEqual(payload);
  });
});

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
