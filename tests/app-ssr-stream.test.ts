import { describe, it, expect } from "vitest";
import { fixFlightHints, fixPreloadAs } from "../packages/vinext/src/server/app-ssr-stream.js";
import { createFlightHintFixTransform } from "../packages/vinext/src/server/flight-hints.js";

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

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

  describe("createFlightHintFixTransform", () => {
    it("rewrites stylesheet hints split across chunks", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(':HL["/assets/app.css"'));
          controller.enqueue(encoder.encode(',"styles'));
          controller.enqueue(encoder.encode('heet"]\n0:["$","div"]\n'));
          controller.close();
        },
      });

      await expect(collectStream(stream.pipeThrough(createFlightHintFixTransform()))).resolves.toBe(
        ':HL["/assets/app.css","style"]\n0:["$","div"]\n',
      );
    });

    it("does not rewrite non-delimited stylesheet substrings", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(':HL["/assets/app.css","stylesheetx"]\n'));
          controller.close();
        },
      });

      await expect(collectStream(stream.pipeThrough(createFlightHintFixTransform()))).resolves.toBe(
        ':HL["/assets/app.css","stylesheetx"]\n',
      );
    });

    it("streams non-hint partial rows before their trailing newline", async () => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const originalSetTimeout = globalThis.setTimeout;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('0:{"shell":"Loading..."'));
          await new Promise((resolve) => originalSetTimeout(resolve, 50));
          controller.enqueue(encoder.encode("}\n"));
          controller.close();
        },
      });

      const reader = stream.pipeThrough(createFlightHintFixTransform()).getReader();
      try {
        const first = await Promise.race([
          reader.read().then((result) => ({ result, type: "chunk" as const })),
          new Promise<{ type: "timeout" }>((resolve) =>
            originalSetTimeout(() => resolve({ type: "timeout" }), 20),
          ),
        ]);

        expect(first.type).toBe("chunk");
        if (first.type === "chunk") {
          expect(first.result.done).toBe(false);
          expect(decoder.decode(first.result.value)).toBe('0:{"shell":"Loading..."');
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    });
  });
});
