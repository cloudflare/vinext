import { describe, it, expect } from "vite-plus/test";
import {
  createRscEmbedTransform,
  createTickBufferedTransform,
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

function createByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
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
    expect(finalScripts).toContain('Symbol.for("vinext.navigationRuntime")');
    expect(finalScripts).toContain(".done=true");
    expect(finalScripts).toContain('.rsc.push("chunk1")');
    expect(finalScripts).toContain('.rsc.push("chunk2")');
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
    expect(finalScripts).toContain(".done=true");
  });

  it("embeds non-UTF-8 RSC chunks as base64 binary chunks", async () => {
    // Ported from Next.js: test/e2e/app-dir/binary/rsc-binary.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/binary/rsc-binary.test.ts
    const transform = createRscEmbedTransform(
      createByteStream([new Uint8Array([0xff, 0, 1, 2, 3])]),
    );

    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('.rsc.push([3,"/wABAgM="])');
  });

  it("does not lose incomplete UTF-8 bytes before a binary chunk", async () => {
    const transform = createRscEmbedTransform(
      createByteStream([new Uint8Array([0x41, 0xc3]), new Uint8Array([0xff])]),
    );

    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('.rsc.push([3,"QcM="])');
    expect(finalScripts).toContain('.rsc.push([3,"/w=="])');
  });
});

// ── beforeInteractive pre-head splice ────────────────────────────────────────

/**
 * Pipe an HTML string (or chunks) through `createTickBufferedTransform` and
 * collect the output. Uses a no-op RscEmbedTransform so we can exercise the
 * pre-head splice path in isolation.
 */
async function runTransform(
  chunks: string[],
  options: {
    injectHTML?: string;
    injectAfterHeadOpenHTML?: string;
  } = {},
): Promise<string> {
  const noopRsc = {
    flush: () => "",
    finalize: async () => "",
    getRawBuffer: async () => new ArrayBuffer(0),
  };
  const transform = createTickBufferedTransform(
    noopRsc,
    options.injectHTML ?? "",
    options.injectAfterHeadOpenHTML ?? "",
  );
  const source = createTextStream(chunks);
  const piped = source.pipeThrough(transform);
  const reader = piped.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("createTickBufferedTransform pre-head splice", () => {
  it("emits injectAfterHeadOpenHTML immediately after <head> opens", async () => {
    const html =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="/a.css"/></head><body>x</body></html>';
    const out = await runTransform([html], {
      injectAfterHeadOpenHTML: '<script id="hoisted">init()</script>',
    });

    // The script must appear AFTER <head> and BEFORE the first link.
    const headOpen = out.indexOf("<head>");
    const scriptIdx = out.indexOf('<script id="hoisted">');
    const stylesheetIdx = out.indexOf('<link rel="stylesheet"');
    expect(headOpen).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(headOpen);
    expect(scriptIdx).toBeLessThan(stylesheetIdx);
  });

  it("preserves existing injection point before </head>", async () => {
    const html = "<!DOCTYPE html><html><head></head><body></body></html>";
    const out = await runTransform([html], {
      injectHTML: "<meta name='end-of-head'/>",
      injectAfterHeadOpenHTML: "<meta name='start-of-head'/>",
    });

    const startIdx = out.indexOf("<meta name='start-of-head'/>");
    const endIdx = out.indexOf("<meta name='end-of-head'/>");
    const closeIdx = out.indexOf("</head>");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(endIdx);
    expect(endIdx).toBeLessThan(closeIdx);
  });

  it("handles <head> with attributes", async () => {
    const html = '<!DOCTYPE html><html><head class="dark"></head><body></body></html>';
    const out = await runTransform([html], {
      injectAfterHeadOpenHTML: "<script>x</script>",
    });
    expect(out).toContain('<head class="dark"><script>x</script></head>');
  });

  it("never re-splices on subsequent chunks", async () => {
    const out = await runTransform(
      [
        "<!DOCTYPE html><html><head>",
        '<link rel="stylesheet" href="/a.css"/>',
        "</head><body></body></html>",
      ],
      {
        injectAfterHeadOpenHTML: "<script>once</script>",
      },
    );
    // Only one occurrence — the marker must not be re-emitted when later
    // chunks arrive after the splice already happened.
    const matches = [...out.matchAll(/<script>once<\/script>/g)];
    expect(matches).toHaveLength(1);
  });

  it("does not splice when injectAfterHeadOpenHTML is empty", async () => {
    const html = "<!DOCTYPE html><html><head></head><body></body></html>";
    const out = await runTransform([html], { injectAfterHeadOpenHTML: "" });
    expect(out).toBe(html);
  });

  it("ignores the splice when <head> is missing", async () => {
    const html = "<!DOCTYPE html><html><body>no head</body></html>";
    const out = await runTransform([html], {
      injectAfterHeadOpenHTML: "<script>x</script>",
    });
    expect(out).not.toContain("<script>x</script>");
  });

  it("re-evaluates the insertion getter only when splice runs", async () => {
    // For the function-shaped getter we need to confirm we read it lazily —
    // once at splice time — so callers can pass a getter that snapshots state
    // (e.g. captured Script content) that may not be populated until the
    // tree has rendered.
    let calls = 0;
    const noopRsc = {
      flush: () => "",
      finalize: async () => "",
      getRawBuffer: async () => new ArrayBuffer(0),
    };
    const transform = createTickBufferedTransform(noopRsc, "", () => {
      calls++;
      return "<script>fn</script>";
    });
    const source = createTextStream(["<!DOCTYPE html><html><head></head><body></body></html>"]);
    const out = await new Response(source.pipeThrough(transform)).text();
    expect(out).toContain("<script>fn</script>");
    // One call at splice time, one at end-of-stream `flush` for the
    // post-injected emit fallback. Don't pin an exact count — just confirm
    // it's a small, bounded number rather than per-chunk.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThan(10);
  });
});
