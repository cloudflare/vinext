import { describe, expect, it } from "vite-plus/test";
import { normalizeReactFlightPreloadHints } from "../packages/vinext/src/server/rsc-stream-hints.js";

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
});
