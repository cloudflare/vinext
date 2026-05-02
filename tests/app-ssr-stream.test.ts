import { describe, it, expect } from "vite-plus/test";
import {
  createRscEmbedTransform,
  fixFlightHints,
  fixPreloadAs,
} from "../packages/vinext/src/server/app-ssr-stream.js";

describe("App SSR stream helpers", () => {
  describe("fixPreloadAs", () => {
    it('replaces as="stylesheet" with as="style" for preload links', () => {
      expect(
        fixPreloadAs('<link rel="preload" href="/assets/index-hG1v95Xi.css" as="stylesheet"/>'),
      ).toBe('<link rel="preload" href="/assets/index-hG1v95Xi.css" as="style"/>');

      expect(fixPreloadAs('<link as="stylesheet" rel="preload" href="/file.css"/>')).toBe(
        '<link as="style" rel="preload" href="/file.css"/>',
      );
    });

    it("leaves non-preload links and other preload types unchanged", () => {
      expect(fixPreloadAs('<link rel="stylesheet" href="/file.css" as="stylesheet"/>')).toBe(
        '<link rel="stylesheet" href="/file.css" as="stylesheet"/>',
      );

      expect(fixPreloadAs('<link rel="preload" href="/font.woff2" as="font"/>')).toBe(
        '<link rel="preload" href="/font.woff2" as="font"/>',
      );

      expect(fixPreloadAs('<link rel="preload" href="/a.css" as="style"/>')).toBe(
        '<link rel="preload" href="/a.css" as="style"/>',
      );
    });

    it("handles multiple preload links in a single chunk", () => {
      const html =
        '<link rel="preload" href="/a.css" as="stylesheet"/><link rel="preload" href="/b.css" as="stylesheet"/>';
      expect(fixPreloadAs(html)).toBe(
        '<link rel="preload" href="/a.css" as="style"/><link rel="preload" href="/b.css" as="style"/>',
      );
    });
  });

  describe("fixFlightHints", () => {
    it("rewrites stylesheet hints in Flight HL records", () => {
      expect(fixFlightHints(':HL["/assets/index.css","stylesheet"]')).toBe(
        ':HL["/assets/index.css","style"]',
      );

      expect(fixFlightHints('2:HL["/assets/index.css","stylesheet",{"crossOrigin":""}]')).toBe(
        '2:HL["/assets/index.css","style",{"crossOrigin":""}]',
      );
    });

    it("leaves unrelated content unchanged", () => {
      expect(
        fixFlightHints(
          '0:D{"name":"index"}\n1:["$","link",null,{"rel":"stylesheet","href":"/file.css"}]',
        ),
      ).toBe('0:D{"name":"index"}\n1:["$","link",null,{"rel":"stylesheet","href":"/file.css"}]');

      expect(fixFlightHints('2:HL["/font.woff2","font"]')).toBe('2:HL["/font.woff2","font"]');
      expect(fixFlightHints(':HL["/font.woff2","font"]')).toBe(':HL["/font.woff2","font"]');
    });

    it("handles multiple hints in a single chunk", () => {
      expect(fixFlightHints('2:HL["/a.css","stylesheet"]\n3:HL["/b.css","stylesheet"]')).toBe(
        '2:HL["/a.css","style"]\n3:HL["/b.css","style"]',
      );
      expect(fixFlightHints(':HL["/a.css","stylesheet"]\n:HL["/b.css","stylesheet"]')).toBe(
        ':HL["/a.css","style"]\n:HL["/b.css","style"]',
      );
    });
  });
});

function createTextStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

describe("createRscEmbedTransform raw buffer (#981)", () => {
  it("accumulates raw bytes while producing embed scripts", async () => {
    const sideStream = createTextStream(["chunk1", "chunk2"]);
    const transform = createRscEmbedTransform(sideStream);

    // Let the reader pump all chunks
    const rawBuffer = await transform.getRawBuffer();
    expect(rawBuffer).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(rawBuffer)).toBe("chunk1chunk2");

    // Embed scripts still work
    const finalScripts = await transform.finalize();
    expect(finalScripts).toContain("__VINEXT_RSC_DONE__");
    expect(finalScripts).toContain("__VINEXT_RSC_CHUNKS__");
  });

  it("rejects getRawBuffer when the stream errors (#1002)", async () => {
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream broke"));
      },
    });
    const transform = createRscEmbedTransform(errorStream);
    await expect(transform.getRawBuffer()).rejects.toThrow("stream broke");
  });

  it("preserves raw bytes before fixFlightHints transform", async () => {
    // Flight hints use as="stylesheet" which get fixed to as="style" in the
    // embed transform. Raw bytes must be the unmodified originals.
    const sideStream = createTextStream([':HL["/a.css","stylesheet"]']);
    const transform = createRscEmbedTransform(sideStream);

    const rawBuffer = await transform.getRawBuffer();
    const rawText = new TextDecoder().decode(rawBuffer);
    // Raw bytes: unmodified originals (not fixed)
    expect(rawText).toBe(':HL["/a.css","stylesheet"]');

    // finalize() returns the embed scripts with fixed hints
    const finalScripts = await transform.finalize();
    // The fixed text "as=\"style\"" appears in the embed script after JSON escaping.
    // fixFlightHints turns "stylesheet" → "style" before the chunk is script-wrapped.
    expect(finalScripts).not.toContain("stylesheet");
    expect(finalScripts).toContain("__VINEXT_RSC_DONE__");
  });
});
