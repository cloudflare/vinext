import { describe, it, expect } from "vite-plus/test";
import { createElement, Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import {
  createNavigationRuntimeRscMetadataScript,
  createRscEmbedTransform,
  createTickBufferedTransform,
  fixFlightHints,
  fixPreloadAs,
  waitAtLeastOneReactRenderTask,
} from "../packages/vinext/src/server/app-ssr-stream.js";

it("serializes dynamic stale time into the hydration bootstrap", () => {
  expect(
    createNavigationRuntimeRscMetadataScript(
      { id: "1" },
      { pathname: "/posts/1", searchParams: [] },
      30,
    ),
  ).toContain("dynamicStaleTimeSeconds:30");
});

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

function createNoopRscEmbedTransform() {
  return {
    flush: () => "",
    finalize: async () => "",
    getRawBuffer: async () => new ArrayBuffer(0),
  };
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

  it("finalizes initial cache metadata after the RSC stream settles", async () => {
    let initialCacheKind: "dynamic" | "static" = "static";
    const transform = createRscEmbedTransform(createTextStream(["chunk"]), undefined, () => ({
      kind: initialCacheKind,
      ...(initialCacheKind === "dynamic" ? { dynamicStaleTimeSeconds: 30 } : {}),
    }));

    initialCacheKind = "dynamic";
    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('"initialCacheKind":"dynamic"');
    expect(finalScripts).toContain('"dynamicStaleTimeSeconds":30');
    expect(finalScripts.indexOf("initialCacheKind")).toBeLessThan(
      finalScripts.indexOf(".done=true"),
    );
  });

  it("omits dynamic stale time from finalized static payload metadata", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk"]), undefined, () => ({
      kind: "static",
    }));

    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('"initialCacheKind":"static"');
    expect(finalScripts).not.toContain("dynamicStaleTimeSeconds");
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
    inlineCss?: Record<string, string>;
    inlineCssPrependCss?: string;
    inlineCssPrependFallbackHTML?: string;
    inlineCssScriptNonce?: string;
  } = {},
): Promise<string> {
  const transform = createTickBufferedTransform(
    createNoopRscEmbedTransform(),
    options.injectHTML ?? "",
    options.injectAfterHeadOpenHTML ?? "",
    options.inlineCss,
    options.inlineCssPrependCss,
    options.inlineCssPrependFallbackHTML,
    options.inlineCssScriptNonce,
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

async function runDelayedTransform(
  chunks: string[],
  options: {
    injectHTML?: string;
    injectAfterHeadOpenHTML?: string;
    inlineCss?: Record<string, string>;
  } = {},
): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const enqueueNext = (): void => {
        const chunk = chunks[index++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
        setTimeout(enqueueNext, 5);
      };
      enqueueNext();
    },
  });

  return new Response(
    source.pipeThrough(
      createTickBufferedTransform(
        createNoopRscEmbedTransform(),
        options.injectHTML ?? "",
        options.injectAfterHeadOpenHTML ?? "",
        options.inlineCss,
      ),
    ),
  ).text();
}

async function readSingleTransformChunk(
  transform: TransformStream<Uint8Array, Uint8Array>,
  chunk: string,
): Promise<string> {
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const reader = source.readable.pipeThrough(transform).getReader();
  const writer = source.writable.getWriter();

  await writer.write(new TextEncoder().encode(chunk));
  const result = await reader.read();
  await writer.close();
  await reader.cancel();

  if (result.done) {
    throw new Error("Expected transform to emit a chunk");
  }

  return new TextDecoder().decode(result.value);
}

function createFastSuspenseDocument() {
  const ready = new Promise<void>((resolve) => queueMicrotask(resolve));

  function FastContent() {
    use(ready);
    return createElement("p", { id: "resolved-fast" }, "resolved-fast");
  }

  return createElement(
    "html",
    null,
    createElement("head"),
    createElement(
      "body",
      null,
      createElement(
        Suspense,
        { fallback: createElement("p", { id: "fallback-fast" }, "fallback-fast") },
        createElement(FastContent),
      ),
    ),
  );
}

async function renderFastSuspenseDocument(waitBeforePipe: boolean): Promise<string> {
  const stream = await renderToReadableStream(createFastSuspenseDocument());
  if (waitBeforePipe) {
    await waitAtLeastOneReactRenderTask();
  }
  return new Response(
    stream.pipeThrough(createTickBufferedTransform(createNoopRscEmbedTransform())),
  ).text();
}

describe("dynamic App SSR stream pull scheduling", () => {
  it("waits one React render task before pulling dynamic HTML streams", async () => {
    const immediateHtml = await renderFastSuspenseDocument(false);
    expect(immediateHtml).toContain("fallback-fast");
    expect(immediateHtml).toContain("resolved-fast");

    const delayedHtml = await renderFastSuspenseDocument(true);
    expect(delayedHtml).not.toContain("fallback-fast");
    expect(delayedHtml).toContain("resolved-fast");
  });
});

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

  it("does not treat </head> inside a beforeInteractive script as the insertion point", async () => {
    const script = '<script id="theme">self.theme = "</head><img data-payload src=x>";</script>';
    const out = await runDelayedTransform(["<html><head>", "</head><body></body></html>"], {
      injectHTML: '<meta data-end-of-head="true">',
      injectAfterHeadOpenHTML: script,
    });

    expect(out).toContain(`${script}<meta data-end-of-head="true"></head>`);
  });

  it("preserves document-close text inside a beforeInteractive script", async () => {
    const script = '<script id="theme">self.theme = "</body></html>";</script>';
    const transform = createTickBufferedTransform(
      createNoopRscEmbedTransform(),
      '<meta data-end-of-head="true">',
      script,
    );
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const reader = source.readable.pipeThrough(transform).getReader();
    const writer = source.writable.getWriter();
    const firstRead = reader.read();

    await writer.write(new TextEncoder().encode("<html><head>"));
    const first = await firstRead;
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain(script);

    const remainderPromise = (async () => {
      let remainder = "";
      while (true) {
        const result = await reader.read();
        if (result.done) return remainder;
        remainder += new TextDecoder().decode(result.value);
      }
    })();
    await writer.write(new TextEncoder().encode("</head><body></body></html>"));
    await writer.close();
    const remainder = await remainderPromise;

    expect(remainder).toContain('<meta data-end-of-head="true"></head>');
  });

  it.each([
    ["script data", '<script>self.value = "</head>";</script>'],
    ["style data", '<style>.x::after { content: "</head>"; }</style>'],
    ["title data", "<title>before </head> after</title>"],
    ["comment", "<!-- before </head> after -->"],
    ["attribute", '<meta content="before </head> after">'],
    ["template contents", "<template><div>before </head> after</div></template>"],
  ])("ignores closing-head text in %s", async (_label, context) => {
    const out = await runTransform([`<html><head>${context}</head><body></body></html>`], {
      injectHTML: '<meta data-end-of-head="true">',
    });

    expect(out).toContain(`${context}<meta data-end-of-head="true"></head>`);
  });

  it("tracks script double-escaped data before finding the real head close", async () => {
    const script = "<script><!--<script></head></script>--></script>";
    const out = await runTransform([`<html><head>${script}</head><body></body></html>`], {
      injectHTML: '<meta data-end-of-head="true">',
    });

    expect(out).toContain(`${script}<meta data-end-of-head="true"></head>`);
  });

  it("skips over large raw-text bodies without lowercasing each character", async () => {
    const toLowerCaseDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "toLowerCase");
    if (!toLowerCaseDescriptor) throw new Error("String.prototype.toLowerCase is unavailable");
    const originalToLowerCase = toLowerCaseDescriptor.value as (this: string) => string;
    let singleCharacterCalls = 0;
    Object.defineProperty(String.prototype, "toLowerCase", {
      ...toLowerCaseDescriptor,
      value: function (this: string): string {
        if (this.length === 1) singleCharacterCalls++;
        return Reflect.apply(originalToLowerCase, this, []);
      },
    });

    let out: string;
    try {
      const scriptBody = "a".repeat(5 * 1024 * 1024);
      out = await runTransform(
        [`<html><head><script>${scriptBody}</script></head><body></body></html>`],
        { injectHTML: '<meta data-end-of-head="true">' },
      );
    } finally {
      Object.defineProperty(String.prototype, "toLowerCase", toLowerCaseDescriptor);
    }

    expect(out).toContain('</script><meta data-end-of-head="true"></head>');
    // Tag parsing still lowercases a bounded number of individual characters.
    // Raw-text scanning must not make that count proportional to the script.
    expect(singleCharacterCalls).toBeGreaterThan(0);
    expect(singleCharacterCalls).toBeLessThan(1_000);
  });

  it.each([
    [
      "script data",
      [
        "<html><head><scr",
        'ipt>self.value = "</he',
        'ad>";</scr',
        "ipt></he",
        "ad><body></body></html>",
      ],
      '<script>self.value = "</head>";</script>',
    ],
    [
      "comment",
      ["<html><head><!-", "- before </he", "ad> after --", "></head><body></body></html>"],
      "<!-- before </head> after -->",
    ],
    [
      "abruptly closed comment",
      ["<html><head><!-", "--></he", "ad><body></body></html>"],
      "<!--->",
    ],
    [
      "comment ending in --!>",
      ["<html><head><!-- before --", "!></he", "ad><body></body></html>"],
      "<!-- before --!>",
    ],
    [
      "quoted attribute",
      ['<html><head><meta content="before </he', 'ad> after">', "</head><body></body></html>"],
      '<meta content="before </head> after">',
    ],
    [
      "template contents",
      [
        "<html><head><temp",
        "late><div>before </he",
        "ad> after</div></temp",
        "late></head><body></body></html>",
      ],
      "<template><div>before </head> after</div></template>",
    ],
    [
      "double-escaped script data",
      [
        "<html><head><script><!",
        "--<scr",
        "ipt></he",
        "ad></scr",
        "ipt>--></scr",
        "ipt></head><body></body></html>",
      ],
      "<script><!--<script></head></script>--></script>",
    ],
  ])("retains %s scanner state across flush ticks", async (_label, chunks, context) => {
    const out = await runDelayedTransform(chunks, {
      injectHTML: '<meta data-end-of-head="true">',
    });

    expect(out).toContain(`${context}<meta data-end-of-head="true"></head>`);
  });

  it("finds a real closing head tag split across flush ticks", async () => {
    const out = await runDelayedTransform(
      ["<html><head><title>x</title></he", "ad><body></body></html>"],
      { injectHTML: '<meta data-end-of-head="true">' },
    );

    expect(out).toContain('<title>x</title><meta data-end-of-head="true"></head>');
  });

  it.each([
    ["uppercase", "</HEAD>"],
    ["whitespace", "</head >"],
    ["end-tag attributes", '</head data-marker=">">'],
  ])("recognizes a browser-valid %s closing head tag", async (_label, closeTag) => {
    const out = await runTransform(
      [`<html><head><title>x</title>${closeTag}<body></body></html>`],
      {
        injectHTML: '<meta data-end-of-head="true">',
      },
    );

    expect(out).toContain(`<title>x</title><meta data-end-of-head="true">${closeTag}`);
  });

  it("recognizes a browser-valid closing head tag split inside its attributes", async () => {
    const out = await runDelayedTransform(
      ["<html><head><title>x</title></HE", 'AD data-marker=">', '"><body></body></html>'],
      { injectHTML: '<meta data-end-of-head="true">' },
    );

    expect(out).toContain('<title>x</title><meta data-end-of-head="true"></HEAD data-marker=">">');
  });

  it("continues streaming safe head content before later input arrives", async () => {
    const transform = createTickBufferedTransform(
      createNoopRscEmbedTransform(),
      '<meta data-end-of-head="true">',
    );
    const source = new TransformStream<Uint8Array, Uint8Array>();
    const reader = source.readable.pipeThrough(transform).getReader();
    const writer = source.writable.getWriter();
    const firstRead = reader.read();

    await writer.write(new TextEncoder().encode("<html><head><meta name=first>"));
    const first = await firstRead;
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("<html><head><meta name=first>");

    await writer.write(new TextEncoder().encode("</head><body></body></html>"));
    await writer.close();
    let remainder = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      remainder += new TextDecoder().decode(result.value);
    }
    expect(remainder).toContain('<meta data-end-of-head="true"></head>');
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

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  // (regression for #1532)
  describe("</body></html> suffix is the last thing in the stream", () => {
    it("preserves document-close text in body scripts across flush ticks", async () => {
      const transform = createTickBufferedTransform(createNoopRscEmbedTransform());
      const source = new TransformStream<Uint8Array, Uint8Array>();
      const reader = source.readable.pipeThrough(transform).getReader();
      const writer = source.writable.getWriter();
      let out = "";
      const readPromise = (async () => {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          out += new TextDecoder().decode(result.value);
        }
      })();

      await writer.write(new TextEncoder().encode("<html><head></head><body>"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writer.write(
        new TextEncoder().encode('<script>self.value = "</body></html>";</script>'),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writer.write(new TextEncoder().encode("</body></ht"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writer.write(new TextEncoder().encode("ml>"));
      await writer.close();
      await readPromise;

      expect(out).toContain('<script>self.value = "</body></html>";</script>');
      expect(out.endsWith("</body></html>")).toBe(true);
    });

    it("moves the </body></html> suffix to the end after trailing scripts and RSC chunks", async () => {
      // Simulate React Fizz emitting the closing tags BEFORE flush appends
      // trailing flight chunks / preinit scripts.
      const rsc = {
        flush: () => "",
        finalize: async () => '<script id="trailing-rsc">rsc()</script>',
        getRawBuffer: async () => new ArrayBuffer(0),
      };
      const transform = createTickBufferedTransform(rsc, "", "");
      const source = createTextStream([
        "<!DOCTYPE html><html><head></head><body><div>hi</div></body></html>",
      ]);
      const out = await new Response(source.pipeThrough(transform)).text();

      const suffix = "</body></html>";
      expect(out.endsWith(suffix)).toBe(true);
      // Only one occurrence — the suffix must not appear in the middle.
      expect(out.slice(0, -suffix.length)).not.toContain(suffix);
      // Trailing scripts land before the suffix, not after it.
      expect(out).toContain('<script id="trailing-rsc">rsc()</script></body></html>');
    });

    it.each([
      ["uppercase", "</BODY></HTML>"],
      ["whitespace", "</body >\n</html >"],
      ["end-tag attributes", '</body data-marker=">"></html data-marker=">">'],
    ])("moves a browser-valid %s document suffix", async (_label, suffix) => {
      const rsc = {
        flush: () => "",
        finalize: async () => '<script id="trailing-rsc">rsc()</script>',
        getRawBuffer: async () => new ArrayBuffer(0),
      };
      const transform = createTickBufferedTransform(rsc);
      const out = await new Response(
        createTextStream([`<html><head></head><body>content${suffix}`]).pipeThrough(transform),
      ).text();

      expect(out).not.toContain(suffix);
      expect(out).toContain('content<script id="trailing-rsc">rsc()</script></body></html>');
      expect(out.endsWith("</body></html>")).toBe(true);
    });

    it("ensures the suffix is at the end even when injectHTML fallback fires", async () => {
      // When `<head>` never appears, injectHTML falls back to end-of-stream
      // emission. The closing tags must still come last.
      const rsc = {
        flush: () => "",
        finalize: async () => "",
        getRawBuffer: async () => new ArrayBuffer(0),
      };
      const transform = createTickBufferedTransform(rsc, "<meta data-injected='1'/>", "");
      const source = createTextStream(["<!DOCTYPE html><html><body></body></html>"]);
      const out = await new Response(source.pipeThrough(transform)).text();

      const suffix = "</body></html>";
      expect(out.endsWith(suffix)).toBe(true);
      expect(out.slice(0, -suffix.length)).not.toContain(suffix);
      expect(out).toContain("<meta data-injected='1'/>");
    });

    it("adds the suffix at the end even when the source stream omits it", async () => {
      // Defense-in-depth: if React Fizz somehow ends without `</body></html>`,
      // we still emit a well-formed document close.
      const rsc = {
        flush: () => "",
        finalize: async () => "",
        getRawBuffer: async () => new ArrayBuffer(0),
      };
      const transform = createTickBufferedTransform(rsc, "", "");
      const source = createTextStream(["<!DOCTYPE html><html><head></head><body>oops"]);
      const out = await new Response(source.pipeThrough(transform)).text();

      expect(out.endsWith("</body></html>")).toBe(true);
    });
  });

  it("re-evaluates the insertion getter only when splice runs", async () => {
    // For the function-shaped getter we need to confirm we read it lazily —
    // once at splice time — so callers can pass a getter that snapshots state
    // (e.g. captured Script content) that may not be populated until the
    // tree has rendered.
    let calls = 0;
    const transform = createTickBufferedTransform(createNoopRscEmbedTransform(), "", () => {
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

describe("createTickBufferedTransform inline CSS", () => {
  it("replaces React stylesheet links with hoistable inline style tags", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="/_next/static/app.css" data-precedence="vite-rsc/importer-resources"/></head><body></body></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
        },
      },
    );

    expect(out).not.toContain('rel="stylesheet"');
    expect(out).toContain(
      '<style data-vinext-inline-css data-precedence="vite-rsc/importer-resources" data-href="/_next/static/app.css">p { color: yellow; }</style>',
    );
  });

  it("replaces stylesheet links when rel contains multiple tokens", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="preload stylesheet" as="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
        },
      },
    );

    expect(out).toContain("data-vinext-inline-css");
    expect(out).toContain("p { color: yellow; }");
    expect(out).not.toContain('rel="preload stylesheet"');
  });

  it("replaces stylesheet links split across stream chunks", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="style',
        'sheet" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
        },
      },
    );

    expect(out).toContain("data-vinext-inline-css");
    expect(out).toContain("p { color: yellow; }");
    expect(out).not.toContain('<link rel="stylesheet"');
  });

  it("does not buffer incomplete link-like text when inline CSS is disabled", async () => {
    const transform = createTickBufferedTransform(createNoopRscEmbedTransform());

    const out = await readSingleTransformChunk(
      transform,
      "<html><body><script>const marker = '<link'",
    );

    expect(out).toContain("const marker = '<link'");
  });

  it("leaves stylesheet links intact when the emitted CSS asset is not in the inline manifest", async () => {
    const html =
      '<html><head><link rel="stylesheet" href="/_next/static/missing.css" data-precedence="vite-rsc/importer-resources"/></head><body></body></html>';

    await expect(
      runTransform([html], {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
        },
      }),
    ).resolves.toContain('href="/_next/static/missing.css"');
  });

  it("does not rewrite preload or modulepreload links", async () => {
    const html =
      '<html><head><link rel="preload" href="/_next/static/app.css" as="stylesheet"/><link rel="modulepreload" href="/_next/static/app.js"/></head></html>';

    const out = await runTransform([html], {
      inlineCss: {
        "/_next/static/app.css": "p { color: yellow; }",
      },
    });

    expect(out).toContain('<link rel="preload" href="/_next/static/app.css" as="style"/>');
    expect(out).toContain('<link rel="modulepreload" href="/_next/static/app.js"/>');
    expect(out).not.toContain("data-vinext-inline-css");
  });

  it("escapes CSS closing style tags before embedding in HTML", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "body::before { content: '</style><script>x</script>'; }",
        },
      },
    );

    expect(out).toContain("<\\/style><script>x</script>");
    expect(out).not.toContain("</style><script>x</script>");
  });

  it("matches absolute assetPrefix stylesheet URLs by pathname fallback", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="https://cdn.example.com/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
        },
      },
    );

    expect(out).toContain('data-href="https://cdn.example.com/_next/static/app.css"');
    expect(out).toContain("p { color: yellow; }");
  });

  it("prepends SSR font CSS to the first inlined stylesheet", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/><link rel="stylesheet" href="/_next/static/route.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
          "/_next/static/route.css": ".page { font-size: 100px; }",
        },
        inlineCssPrependCss:
          "@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }",
        inlineCssPrependFallbackHTML:
          "<style data-vinext-fonts>@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }</style>",
      },
    );

    const firstStyleStart = out.indexOf("<style");
    const secondStyleStart = out.indexOf("<style", firstStyleStart + 1);
    expect(firstStyleStart).toBeGreaterThanOrEqual(0);
    expect(secondStyleStart).toBeGreaterThan(firstStyleStart);
    expect(out.slice(firstStyleStart, secondStyleStart)).toContain("@font-face");
    expect(out.slice(secondStyleStart)).not.toContain("@font-face");
    expect(out).not.toContain("data-vinext-fonts");
  });

  it("does not prepend SSR font CSS before stylesheet imports", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css": '@import url("/reset.css");\np { color: yellow; }',
        },
        inlineCssPrependCss:
          "@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }",
        inlineCssPrependFallbackHTML:
          "<style data-vinext-fonts>@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }</style>",
      },
    );

    const inlineStyleStart = out.indexOf("<style data-vinext-inline-css");
    const inlineStyleEnd = out.indexOf("</style>", inlineStyleStart);
    const inlineStyle = out.slice(inlineStyleStart, inlineStyleEnd);
    const fallbackStyleStart = out.indexOf("<style data-vinext-fonts>");

    expect(inlineStyle).toContain('>@import url("/reset.css");');
    expect(inlineStyle).not.toContain("@font-face");
    expect(fallbackStyleStart).toBeGreaterThan(inlineStyleEnd);
  });

  it("does not prepend SSR font CSS before stylesheet namespaces", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: {
          "/_next/static/app.css":
            '@namespace svg url("http://www.w3.org/2000/svg");\nsvg|a { color: red; }',
        },
        inlineCssPrependCss:
          "@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }",
        inlineCssPrependFallbackHTML:
          "<style data-vinext-fonts>@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }</style>",
      },
    );

    const inlineStyleStart = out.indexOf("<style data-vinext-inline-css");
    const inlineStyleEnd = out.indexOf("</style>", inlineStyleStart);
    const inlineStyle = out.slice(inlineStyleStart, inlineStyleEnd);
    const fallbackStyleStart = out.indexOf("<style data-vinext-fonts>");

    expect(inlineStyle).toContain('>@namespace svg url("http://www.w3.org/2000/svg");');
    expect(inlineStyle).not.toContain("@font-face");
    expect(fallbackStyleStart).toBeGreaterThan(inlineStyleEnd);
  });

  it("does not rewrite link-like text inside inline scripts", async () => {
    const fakeLink = '<link rel="stylesheet" href="/_next/static/app.css" data-precedence="next">';
    const out = await runTransform(
      [
        `<html><head><script>const linkMarkup = '${fakeLink}';</script><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>`,
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
        },
      },
    );

    const scriptStart = out.indexOf("<script>");
    const scriptEnd = out.indexOf("</script>", scriptStart);
    const scriptHtml = out.slice(scriptStart, scriptEnd);
    const afterScript = out.slice(scriptEnd);

    expect(scriptHtml).toContain(fakeLink);
    expect(scriptHtml).not.toContain("data-vinext-inline-css");
    expect(afterScript).toContain(
      '<style data-vinext-inline-css data-precedence="next" data-href="/_next/static/app.css">p { color: yellow; }</style>',
    );
  });

  it("does not rewrite link-like text inside inline scripts split across stream chunks", async () => {
    const fakeLink = '<link rel="stylesheet" href="/_next/static/app.css" data-precedence="next">';
    const out = await runDelayedTransform(
      [
        `<html><head><script>const linkMarkup = '${fakeLink.slice(0, 30)}`,
        `${fakeLink.slice(30)}';</script><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>`,
      ],
      {
        inlineCss: {
          "/_next/static/app.css": "p { color: yellow; }",
        },
      },
    );

    const scriptStart = out.indexOf("<script>");
    const scriptEnd = out.indexOf("</script>", scriptStart);
    const scriptHtml = out.slice(scriptStart, scriptEnd);
    const afterScript = out.slice(scriptEnd);

    expect(scriptHtml).toContain(fakeLink);
    expect(scriptHtml).not.toContain("data-vinext-inline-css");
    expect(afterScript).toContain(
      '<style data-vinext-inline-css data-precedence="next" data-href="/_next/static/app.css">p { color: yellow; }</style>',
    );
  });

  it("does not rewrite link-like text inside unterminated inline scripts", async () => {
    const fakeLink = '<link rel="stylesheet" href="/_next/static/app.css" data-precedence="next">';
    const out = await runTransform([`<html><head><script>const linkMarkup = '${fakeLink}';`], {
      inlineCss: {
        "/_next/static/app.css": "p { color: yellow; }",
      },
    });

    expect(out).toContain(fakeLink);
    expect(out).not.toContain("data-vinext-inline-css");
  });

  it("emits fallback SSR font CSS when no stylesheet link is inlined", async () => {
    const out = await runTransform(["<html><head></head><body>No CSS link</body></html>"], {
      inlineCss: {
        "/_next/static/app.css": "p { color: yellow; }",
      },
      inlineCssPrependCss:
        "@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }",
      inlineCssPrependFallbackHTML:
        "<style data-vinext-fonts>@font-face { font-family: '__local_font_0'; src: url('/_next/static/font.woff2'); }</style>",
    });

    expect(out).toContain("<style data-vinext-fonts>");
    expect(out).toContain("@font-face");
  });

  it("forwards the SSR script nonce onto inline style tags when the link has none", async () => {
    // Without this, sites running `Content-Security-Policy: style-src 'nonce-…'`
    // see the inlined `<style>` blocked at parse and render unstyled. React Fizz
    // typically doesn't emit a nonce on the `<link>` it rewrites, so the SSR
    // nonce is the only source for the inline style.
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: { "/_next/static/app.css": "p { color: yellow; }" },
        inlineCssScriptNonce: "abc123",
      },
    );

    expect(out).toContain('<style data-vinext-inline-css nonce="abc123"');
    expect(out).toContain("p { color: yellow; }");
  });

  it("prefers the link's own nonce over the SSR script nonce when both are present", async () => {
    // If Fizz ever does emit a nonce on the source `<link>`, that nonce was
    // chosen for this resource specifically and should win.
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" nonce="link-nonce" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: { "/_next/static/app.css": "p { color: yellow; }" },
        inlineCssScriptNonce: "ssr-nonce",
      },
    );

    expect(out).toContain('nonce="link-nonce"');
    expect(out).not.toContain('nonce="ssr-nonce"');
  });

  it("omits the nonce attribute when neither the link nor the SSR provides one", async () => {
    const out = await runTransform(
      [
        '<html><head><link rel="stylesheet" href="/_next/static/app.css" data-precedence="next"/></head></html>',
      ],
      {
        inlineCss: { "/_next/static/app.css": "p { color: yellow; }" },
      },
    );

    expect(out).toContain("<style data-vinext-inline-css");
    expect(out).not.toContain("nonce=");
  });
});
