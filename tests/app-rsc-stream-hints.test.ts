import { describe, expect, it } from "vitest";
import { normalizeReactFlightPreloadHints } from "../packages/vinext/src/server/rsc-stream-hints.js";

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
      ':HL["/assets/app.css","style"]\n' +
        '2:HL["/assets/page.css","style",{"crossOrigin":""}]\n' +
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
        ':HL["/assets/a.css","style",{"crossOrigin":""}]\n' +
        '1:["$","link",null,{"rel":"stylesheet","href":"/assets/b.css"}]\n' +
        ':HL["/assets/c.css","style"]\n' +
        ':HL["/assets/d.css","style"]\n',
    );
  });

  it("buffers partial Flight lines across chunks before rewriting hints", async () => {
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks([':HL["/assets/app.css",', '"styles', 'heet"]\n0:D{"name":"page"}\n']),
    );

    await expect(readStream(stream)).resolves.toBe(
      ':HL["/assets/app.css","style"]\n0:D{"name":"page"}\n',
    );
  });

  it("rewrites a final unterminated Flight line during flush", async () => {
    const stream = normalizeReactFlightPreloadHints(
      streamFromChunks([':HL["/assets/app.css","stylesheet"]']),
    );

    await expect(readStream(stream)).resolves.toBe(':HL["/assets/app.css","style"]');
  });
});
