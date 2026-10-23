import { createContext, runInContext } from "node:vm";
import { describe, it, expect, vi } from "vite-plus/test";
import { createElement, type ReactNode, Suspense, use } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { renderToReadableStream as renderToReadableStreamNode } from "react-dom/server.node";
import {
  concatUint8Arrays,
  decodeRscEmbeddedChunk,
  escapeRscDataBlockText,
  type RscEmbeddedChunk,
  unescapeRscDataBlockText,
} from "../packages/vinext/src/server/app-rsc-embedded-chunks.js";
import {
  createNavigationRuntimeRscCompatibilityScript,
  createNavigationRuntimeRscMetadataScript,
  createRscEmbedTransform,
  createTickBufferedTransform,
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

it("serializes browser search-param ownership into the early hydration bootstrap", () => {
  expect(
    createNavigationRuntimeRscMetadataScript(
      {},
      { pathname: "/static", searchParams: [] },
      undefined,
      true,
    ),
  ).toContain("searchParamsFromBrowser:true");
});

it("sends the server's RSC compatibility ID with the page, except for static export", () => {
  vi.stubEnv("__VINEXT_RSC_COMPATIBILITY_ID", "compat-a");
  try {
    expect(createNavigationRuntimeRscCompatibilityScript()).toBe(
      'Object.assign(((self[Symbol.for("vinext.navigationRuntime")]??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]}),{compatibilityId:"compat-a"})',
    );
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__NEXT_CONFIG_OUTPUT", "export");
    expect(createNavigationRuntimeRscCompatibilityScript()).toBe("");
    vi.stubEnv("__NEXT_CONFIG_OUTPUT", "");
    vi.stubEnv("__VINEXT_RSC_COMPATIBILITY_ID", "");
    expect(createNavigationRuntimeRscCompatibilityScript()).toBe("");
  } finally {
    vi.unstubAllEnvs();
  }
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

class FakeScriptElement {
  constructor(readonly text: string) {}
}

/**
 * Run the scripts in `html` (a run of <script> elements) as a browser parses
 * them: CR and CRLF become LF, a script's content ends at the first "</script"
 * followed by a tag-name terminator, NUL becomes U+FFFD, and the previous
 * script element is the `previousSibling` of `document.currentScript`.
 */
function runEmbedScripts(html: string, globals: Record<string, unknown> = {}) {
  const document = { currentScript: null as { previousSibling: FakeScriptElement } | null };
  const context = createContext({ ...globals, document, HTMLScriptElement: FakeScriptElement });
  const input = html.replace(/\r\n?/g, "\n");
  const startTagRe = /<script(\s[^>]*)?>/iy;
  const endTagRe = /<\/script[\t\n\f />]/gi;
  let previous: FakeScriptElement | null = null;
  let index = 0;
  while (index < input.length) {
    startTagRe.lastIndex = index;
    const startTag = startTagRe.exec(input);
    expect(startTag).not.toBeNull();
    endTagRe.lastIndex = startTagRe.lastIndex;
    const endTag = endTagRe.exec(input);
    expect(endTag).not.toBeNull();
    const content = input.slice(startTagRe.lastIndex, endTag!.index);
    // "<!--" or "<script" would move the parser into an escaped state that
    // ends the element elsewhere.
    expect(content).not.toMatch(/<!--|<script/i);
    const text = content.replace(/\0/g, "\uFFFD");
    if (!startTag![1]?.includes(" type=")) {
      document.currentScript = { previousSibling: previous! };
      runInContext(text, context);
    }
    previous = new FakeScriptElement(text);
    index = input.indexOf(">", endTag!.index) + 1;
  }
}

function readEmbeddedRscBytes(self: Record<PropertyKey, unknown>): Uint8Array {
  const navigationRuntime = self[Symbol.for("vinext.navigationRuntime")] as {
    bootstrap: { rsc: { rsc: RscEmbeddedChunk[] } };
  };
  return concatUint8Arrays(navigationRuntime.bootstrap.rsc.rsc.map(decodeRscEmbeddedChunk));
}

describe("RSC data block escaping", () => {
  const samples = [
    "",
    "plain",
    "<p>a &amp; b</p>",
    "</script>",
    "</SCRIPT >",
    "<script>",
    "<ScRiPt src=x>",
    "<!-- comment -->",
    "a\r\nb",
    "a\rb",
    "\r",
    "\r\r\n",
    "\0",
    "a\0b",
    "\uE000",
    "\uE0000",
    "\uE000\uE0001\uE0003",
    "é ✓ 😀 \uFEFF",
    "1:T2c,</script><!--\r\n\0\uE000 😀 </sCrIpT\r",
  ];

  it("round-trips text exactly", () => {
    for (const sample of samples) {
      expect(unescapeRscDataBlockText(escapeRscDataBlockText(sample))).toBe(sample);
    }
  });

  it("leaves nothing that the HTML parser would end, re-mode or rewrite", () => {
    for (const sample of samples) {
      expect(escapeRscDataBlockText(sample)).not.toMatch(/<!--|<\/?script|[\r\0]/i);
    }
  });

  it("returns text that needs no escaping as is", () => {
    const text = '0:["$","p",null,{"children":"<b>a</b> -> b"}]\n';
    expect(escapeRscDataBlockText(text)).toBe(text);
  });
});

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
    expect(finalScripts).toContain('<script type="vinext/rsc">chunk1chunk2</script>');
  });

  it("coalesces adjacent text chunks into one Flight data block", async () => {
    const transform = createRscEmbedTransform(createTextStream(Array(1_000).fill("chunk")));

    const finalScripts = await transform.finalize();

    expect(finalScripts.match(/\.rsc\.push\(/g)).toHaveLength(1);
    expect(finalScripts.match(/<script/g)).toHaveLength(3);
    expect(finalScripts).toContain(`<script type="vinext/rsc">${"chunk".repeat(1_000)}</script>`);
  });

  it("embeds Flight text as raw data blocks that decode to the exact bytes", async () => {
    const flightChunks = [
      new TextEncoder().encode('0:["$","div",null,{"children":"$1"}]\n'),
      new TextEncoder().encode("1:T2c,</script><!--\r\n\0\uE000 😀 </sCrIpT\r"),
      new Uint8Array([0xff]),
      new TextEncoder().encode("2:T5,a\rb\r\n"),
    ];
    const transform = createRscEmbedTransform(createByteStream(flightChunks), {
      scriptNonce: "test-nonce",
    });

    const finalScripts = await transform.finalize();
    const self: Record<PropertyKey, unknown> = {};
    runEmbedScripts(finalScripts, { self });

    expect(readEmbeddedRscBytes(self)).toEqual(concatUint8Arrays(flightChunks));
    expect(finalScripts).not.toContain('.rsc.push("');
    expect(finalScripts.match(/<script type="vinext\/rsc"/g)).toHaveLength(2);
    for (const tag of finalScripts.match(/<script\b[^>]*>/gi)!) {
      expect(tag).toContain(' nonce="test-nonce"');
    }
  });

  it("does not push the text of page content when document.currentScript is clobbered", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk"]));
    const finalScripts = await transform.finalize();
    const self: Record<PropertyKey, unknown> = {};
    const context = createContext({
      self,
      HTMLScriptElement: FakeScriptElement,
      // As with <a>0:injected</a><img name="currentScript">.
      document: { currentScript: { previousSibling: { text: "0:injected\n" } } },
    });

    const pushScript = finalScripts.slice(finalScripts.indexOf("<script>") + "<script>".length);
    runInContext(pushScript.slice(0, pushScript.indexOf("</script>")), context);

    expect(self[Symbol.for("vinext.navigationRuntime")]).toBeUndefined();
  });

  it("optionally mirrors text chunks into the Next.js inline Flight transport", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk1", "chunk2"]), {
      mirrorNextFlight: true,
      scriptNonce: "test-nonce",
    });

    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain(
      '<script nonce="test-nonce">(self.__next_f=self.__next_f||[]).push([0])</script>',
    );
    expect(finalScripts).toContain(
      '<script nonce="test-nonce">self.__next_f.push([1,"chunk1chunk2"])</script>',
    );
    expect(finalScripts).toContain(
      '<script nonce="test-nonce">self.addEventListener("DOMContentLoaded",()=>{if(self.__next_f?.push===Array.prototype.push)self.__next_f.length=0},{once:true})</script>',
    );
    expect(finalScripts.match(/self\.__next_f=self\.__next_f\|\|\[\]/g)).toHaveLength(1);
  });

  it("replays the stream from its start to a render that replaces one that read it", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("first"));
      },
    });
    const transform = createRscEmbedTransform(stream, { mirrorNextFlight: () => false });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const replayed = transform.replay();
    streamController.enqueue(new TextEncoder().encode("second"));
    streamController.close();

    expect(await new Response(replayed).text()).toBe("firstsecond");
    expect(await new Response(transform.replay()).text()).toBe("firstsecond");
    expect(transform.flush()).toContain('<script type="vinext/rsc">firstsecond</script>');
  });

  it("keeps a replay open after the last byte when asked", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk"]), {
      mirrorNextFlight: () => false,
    });
    await transform.finalize();

    const reader = transform.replay({ keepOpen: true })!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("chunk");
    const next = await Promise.race([
      reader.read().then(() => "read"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);
    expect(next).toBe("pending");
    await reader.cancel();
  });

  it("can't replay once the raw bytes are released", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk"]));
    await transform.getRawBuffer();

    expect(transform.replay()).toBeNull();
  });

  it("starts mirroring mid-stream once asked, replaying the chunks already embedded", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("first"));
      },
    });
    let mirror = false;
    const transform = createRscEmbedTransform(stream, { mirrorNextFlight: () => mirror });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstScripts = transform.flush();
    expect(firstScripts).not.toContain("self.__next_f");

    mirror = true;
    streamController.enqueue(new TextEncoder().encode("second"));
    streamController.close();
    const finalScripts = await transform.finalize();

    expect(finalScripts.match(/self\.__next_f=self\.__next_f\|\|\[\]/g)).toHaveLength(1);
    expect(finalScripts).toContain('self.addEventListener("DOMContentLoaded"');
    const firstIndex = finalScripts.indexOf('self.__next_f.push([1,"first"])');
    const secondIndex = finalScripts.indexOf('self.__next_f.push([1,"second"])');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("replays the embedded chunks into a late mirror after the raw buffer was captured", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("first"));
      },
    });
    let mirror = false;
    const transform = createRscEmbedTransform(stream, { mirrorNextFlight: () => mirror });
    // Cache capture claims the raw buffer as the SSR entry does, which clears
    // the raw chunks once the stream completes.
    const rawBuffer = transform.getRawBuffer();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transform.flush()).not.toContain("self.__next_f");
    streamController.enqueue(new TextEncoder().encode("second"));
    streamController.close();
    expect(new TextDecoder().decode(await rawBuffer)).toBe("firstsecond");

    mirror = true;
    const finalScripts = await transform.finalize();

    const firstIndex = finalScripts.indexOf('self.__next_f.push([1,"first"])');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(finalScripts.indexOf('self.__next_f.push([1,"second"])')).toBeGreaterThan(firstIndex);
  });

  it("does not mirror when its predicate stays false", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk"]), {
      mirrorNextFlight: () => false,
    });

    const finalScripts = await transform.finalize();

    expect(finalScripts).not.toContain("self.__next_f");
  });

  it("does not mirror Next.js inline Flight chunks by default", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk"]));

    const finalScripts = await transform.finalize();

    expect(finalScripts).not.toContain("self.__next_f");
  });

  it("schedules cleanup for an unclaimed progressive buffer before a later stream error", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    const transform = createRscEmbedTransform(stream, { mirrorNextFlight: true });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const progressiveScripts = transform.flush();
    expect(progressiveScripts).toContain('self.__next_f.push([1,"partial"])');
    expect(progressiveScripts).toContain('self.addEventListener("DOMContentLoaded"');

    streamController.error(new Error("stream broke"));
    await expect(transform.finalize()).rejects.toThrow("stream broke");
  });

  it("preserves progressive chunks until a deferred Next.js consumer claims the buffer", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("first"));
      },
    });
    const transform = createRscEmbedTransform(stream, { mirrorNextFlight: true });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstScripts = transform.flush();
    streamController.enqueue(new TextEncoder().encode("second"));
    streamController.close();
    const finalScripts = await transform.finalize();

    const listeners = new Map<string, () => void>();
    const self = {
      __next_f: undefined as undefined | Array<unknown>,
      addEventListener(name: string, listener: () => void) {
        listeners.set(name, listener);
      },
    };
    const runScripts = (html: string) => runEmbedScripts(html, { self });

    runScripts(firstScripts);
    const received = [...self.__next_f!];
    self.__next_f!.length = 0;
    self.__next_f!.push = (segment) => {
      received.push(segment);
      return received.length;
    };
    runScripts(finalScripts);
    listeners.get("DOMContentLoaded")!();

    expect(received).toEqual([[0], [1, "first"], [1, "second"]]);
    expect(self.__next_f).toHaveLength(0);
    expect(self.__next_f!.push).not.toBe(Array.prototype.push);
  });

  it("finalizes initial cache metadata after the RSC stream settles", async () => {
    let initialCacheKind: "dynamic" | "static" = "static";
    const transform = createRscEmbedTransform(createTextStream(["chunk"]), {
      getInitialNavigationCacheMetadata: () => ({
        kind: initialCacheKind,
        ...(initialCacheKind === "dynamic" ? { dynamicStaleTimeSeconds: 30 } : {}),
      }),
    });

    initialCacheKind = "dynamic";
    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('"initialCacheKind":"dynamic"');
    expect(finalScripts).toContain('"dynamicStaleTimeSeconds":30');
    expect(finalScripts.indexOf("initialCacheKind")).toBeLessThan(
      finalScripts.indexOf(".done=true"),
    );
  });

  it("omits dynamic stale time from finalized static payload metadata", async () => {
    const transform = createRscEmbedTransform(createTextStream(["chunk"]), {
      getInitialNavigationCacheMetadata: () => ({
        kind: "static",
      }),
    });

    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('"initialCacheKind":"static"');
    expect(finalScripts).not.toContain("dynamicStaleTimeSeconds");
    expect(finalScripts).not.toContain("staleTimeSeconds");
  });

  it("emits the completed render's cacheLife stale time in the done script", async () => {
    // The getter runs at finalize() time — after the RSC stream drains — so a
    // cacheLife claim registered mid-stream still reaches the done script.
    let staleTimeSeconds: number | undefined;
    const transform = createRscEmbedTransform(createTextStream(["chunk"]), {
      getInitialNavigationCacheMetadata: () => ({
        kind: "static",
        ...(staleTimeSeconds === undefined ? {} : { staleTimeSeconds }),
      }),
    });

    staleTimeSeconds = 30;
    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('"staleTimeSeconds":30');
    expect(finalScripts.indexOf("staleTimeSeconds")).toBeLessThan(
      finalScripts.indexOf(".done=true"),
    );
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

  it("preserves Flight bytes in both embedded and captured RSC data", async () => {
    const sideStream = createTextStream([':HL["/a.css","stylesheet"]']);
    const transform = createRscEmbedTransform(sideStream);

    const rawBuffer = await transform.getRawBuffer();
    const rawText = new TextDecoder().decode(rawBuffer);
    expect(rawText).toBe(':HL["/a.css","stylesheet"]');

    const finalScripts = await transform.finalize();
    expect(finalScripts).toContain("stylesheet");
    expect(finalScripts).toContain(".done=true");
  });

  it("preserves a UTF-8 BOM at an embedded Flight chunk boundary", async () => {
    const flightChunks = [
      new TextEncoder().encode("1:T4,"),
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
      new TextEncoder().encode("2:T1,b"),
    ];
    const expectedBytes = concatUint8Arrays(flightChunks);

    const transform = createRscEmbedTransform(createByteStream(flightChunks));
    const finalScripts = await transform.finalize();
    const self: Record<PropertyKey, unknown> = {};
    runEmbedScripts(finalScripts, { self });

    expect(readEmbeddedRscBytes(self)).toEqual(expectedBytes);
  });

  it("preserves binary boundaries while coalescing adjacent text chunks", async () => {
    const transform = createRscEmbedTransform(
      createByteStream([
        new TextEncoder().encode("first"),
        new Uint8Array([0xff]),
        new TextEncoder().encode("second"),
        new TextEncoder().encode("third"),
      ]),
    );

    const finalScripts = await transform.finalize();
    const firstIndex = finalScripts.indexOf('<script type="vinext/rsc">first</script>');
    const binaryIndex = finalScripts.indexOf('.rsc.push([3,"/w=="])');
    const remainingTextIndex = finalScripts.indexOf(
      '<script type="vinext/rsc">secondthird</script>',
    );

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(binaryIndex).toBeGreaterThan(firstIndex);
    expect(remainingTextIndex).toBeGreaterThan(binaryIndex);
  });

  it("embeds non-UTF-8 RSC chunks as base64 binary chunks", async () => {
    // Ported from Next.js: test/e2e/app-dir/binary/rsc-binary.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/binary/rsc-binary.test.ts
    const transform = createRscEmbedTransform(
      createByteStream([new Uint8Array([0xff, 0, 1, 2, 3])]),
      { mirrorNextFlight: true },
    );

    const finalScripts = await transform.finalize();

    expect(finalScripts).toContain('.rsc.push([3,"/wABAgM="])');
    expect(finalScripts).toContain('self.__next_f.push([3,"/wABAgM="])');
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
      createTickBufferedTransform(createNoopRscEmbedTransform(), "", "", options.inlineCss),
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
  const close = writer.close();
  while (!(await reader.read()).done) {
    // Drain the transform so its asynchronous flush can finish before the
    // helper releases the reader. Cancelling here races flush() under Node
    // 24.20 and can close the controller before it emits the document suffix.
  }
  await close;

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

function createForeignContentSuspenseDocument() {
  const delays = new Map<number, Promise<void>>();
  function Delayed({ ms, children }: { ms: number; children?: ReactNode }) {
    if (!delays.has(ms)) delays.set(ms, new Promise((resolve) => setTimeout(resolve, ms)));
    use(delays.get(ms)!);
    return children;
  }
  // Long enough that React writes the shell and each segment as several chunks.
  const filler = "x".repeat(3000);
  const boundaries = (tag: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      createElement(
        Suspense,
        { key: index, fallback: createElement(tag, null, "…") },
        createElement(
          Delayed,
          { ms: 2 + index * 3 },
          createElement(tag, null, `${index}${filler}`),
        ),
      ),
    );
  return createElement(
    "html",
    null,
    createElement("head"),
    createElement(
      "body",
      null,
      createElement(
        "svg",
        null,
        createElement("text", null, filler),
        createElement("g", null, boundaries("text", 8)),
      ),
      createElement("math", null, createElement("mi", null, filler), boundaries("mi", 8)),
    ),
  );
}

function createDelayedFlightStream(rows: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (let index = 0; index < rows; index++) {
        controller.enqueue(
          new TextEncoder().encode(`${index}:["$","p",null,{"children":"<b>a</b> &amp; b"}]\n`),
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });
}

/** Script start tags that open while an <svg> or <math> element is open. */
function countScriptsInForeignContent(html: string): { scripts: number; inForeignContent: number } {
  const tagRe = /<(\/?)(svg|math|script)\b[^>]*>/gi;
  let depth = 0;
  let scripts = 0;
  let inForeignContent = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    if (match[2].toLowerCase() !== "script") {
      depth += match[1] ? -1 : 1;
      continue;
    }
    scripts++;
    if (depth > 0) inForeignContent++;
    tagRe.lastIndex = html.toLowerCase().indexOf("</script", tagRe.lastIndex) + 1;
  }
  expect(depth).toBe(0);
  return { scripts, inForeignContent };
}

describe("RSC data blocks and foreign content", () => {
  it("detects scripts inside foreign content", () => {
    expect(
      countScriptsInForeignContent(
        '<svg><g><script type="vinext/rsc"><svg></script><script>x</script></g></svg><script></script>',
      ),
    ).toEqual({ scripts: 3, inForeignContent: 2 });
  });

  for (const [build, render] of [
    ["edge", renderToReadableStream],
    ["node", renderToReadableStreamNode],
  ] as const) {
    it(`are emitted outside <svg> and <math> while boundaries inside them stream (${build} Fizz)`, async () => {
      const html = await render(createForeignContentSuspenseDocument());
      const output = await new Response(
        html.pipeThrough(
          createTickBufferedTransform(createRscEmbedTransform(createDelayedFlightStream(30))),
        ),
      ).text();

      // React sends boundaries completed inside foreign content as closed,
      // hidden <svg> and <math> segments.
      expect(output).toContain('<svg aria-hidden="true" style="display:none" id="S:');
      expect(output).toContain('<math aria-hidden="true" style="display:none" id="S:');
      expect(output.match(/<script type="vinext\/rsc">/g)!.length).toBeGreaterThan(1);
      expect(countScriptsInForeignContent(output).inForeignContent).toBe(0);
    });
  }
});

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

/**
 * Pipe chunks through `createTickBufferedTransform`, one source tick per entry
 * of `ticks`, with an RSC embed that emits a numbered script at every flush.
 */
async function runTickedTransform(
  ticks: (string | Uint8Array)[][],
  options: {
    injectHTML?: string | (() => string);
    injectAfterHeadOpenHTML?: string;
    inlineCss?: Record<string, string>;
  } = {},
): Promise<Uint8Array[]> {
  let flushes = 0;
  const rscEmbed = {
    flush: () => `<script>rsc(${++flushes})</script>`,
    finalize: async () => "<script>done()</script>",
    getRawBuffer: async () => new ArrayBuffer(0),
  };
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;
      const enqueueNext = (): void => {
        const tick = ticks[index++];
        if (tick === undefined) {
          controller.close();
          return;
        }
        for (const chunk of tick) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
        setTimeout(enqueueNext, 5);
      };
      enqueueNext();
    },
  });
  const reader = source
    .pipeThrough(
      createTickBufferedTransform(
        rscEmbed,
        options.injectHTML,
        options.injectAfterHeadOpenHTML,
        options.inlineCss,
      ),
    )
    .getReader();
  const out: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

/**
 * Run `ticks` through the transform and through its text path, which an
 * inline CSS manifest forces, and expect the same bytes from both.
 */
async function runTickedTransformMatchingTextPath(
  ticks: (string | Uint8Array)[][],
  options: { insertPerFlush?: boolean; injectAfterHeadOpenHTML?: string } = {},
): Promise<string> {
  const makeOptions = () => {
    // Server-inserted HTML numbered per call, restarting for each run.
    let insertions = 0;
    return {
      injectHTML: options.insertPerFlush ? () => `<style>s${++insertions}</style>` : undefined,
      injectAfterHeadOpenHTML: options.injectAfterHeadOpenHTML,
    };
  };
  const bytes = concatUint8Arrays(await runTickedTransform(ticks, makeOptions()));
  const textPathBytes = concatUint8Arrays(
    await runTickedTransform(ticks, {
      ...makeOptions(),
      inlineCss: { "/never-linked.css": "a{}" },
    }),
  );
  expect(bytes).toEqual(textPathBytes);
  return new TextDecoder().decode(bytes);
}

describe("createTickBufferedTransform byte pass-through", () => {
  it("forwards Fizz's bytes after the head instead of re-encoding them", async () => {
    const body = new TextEncoder().encode("<p>body</p>");
    const out = await runTickedTransform([
      ["<!DOCTYPE html><html><head></head><body>"],
      [body],
      ["</body></html>"],
    ]);

    // The body batch is emitted as a view of the source chunk's buffer.
    expect(out.some((chunk) => chunk.buffer === body.buffer)).toBe(true);
    expect(new TextDecoder().decode(concatUint8Arrays(out))).toBe(
      "<!DOCTYPE html><html><head></head><body><script>rsc(1)</script><p>body</p>" +
        "<script>rsc(2)</script><script>rsc(3)</script><script>done()</script></body></html>",
    );
  });

  it("keeps multi-byte characters split across chunks and ticks whole", async () => {
    // "<p>caf" é " " ✓ " " 😀 "</p>": é is bytes 6-7, ✓ 9-11, 😀 13-16.
    const bytes = new TextEncoder().encode("<p>café ✓ 😀</p>");
    const out = await runTickedTransformMatchingTextPath([
      ["<!DOCTYPE html><html><head></head><body>"],
      [bytes.subarray(0, 7), bytes.subarray(7, 9)],
      [bytes.subarray(9, 15)],
      [bytes.subarray(15), "</body></html>"],
    ]);

    expect(out).toBe(
      "<!DOCTYPE html><html><head></head><body><script>rsc(1)</script><p>café " +
        "<script>rsc(2)</script>✓ <script>rsc(3)</script>😀</p><script>rsc(4)</script>" +
        "<script>done()</script></body></html>",
    );
  });

  it("splices the head of a single-batch document whose text and byte offsets differ", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const html = new TextEncoder().encode(
      "<!DOCTYPE html><html><head><title>Café ✓ 😀</title></head><body><p>ü</p></body></html>",
    );
    const out = await runTickedTransformMatchingTextPath([[concatUint8Arrays([bom, html])]], {
      insertPerFlush: true,
      injectAfterHeadOpenHTML: "<script>pre()</script>",
    });

    // The decoder drops the byte order mark, and so does the output.
    expect(out).toBe(
      "<!DOCTYPE html><html><head><script>pre()</script><title>Café ✓ 😀</title>" +
        "<style>s1</style></head><body><p>ü</p><script>rsc(1)</script><style>s2</style>" +
        "<script>done()</script></body></html>",
    );
  });

  it("emits server-inserted HTML before each forwarded batch", async () => {
    const out = await runTickedTransformMatchingTextPath(
      [
        ["<!DOCTYPE html><html><head><title>Café</title></head><body>"],
        ["<p>ünïcødé</p>"],
        ["</body></html>"],
      ],
      { insertPerFlush: true },
    );

    expect(out).toBe(
      "<!DOCTYPE html><html><head><title>Café</title><style>s1</style></head><body>" +
        "<script>rsc(1)</script><style>s2</style><p>ünïcødé</p><script>rsc(2)</script>" +
        "<style>s3</style><script>rsc(3)</script><style>s4</style><script>done()</script>" +
        "</body></html>",
    );
  });

  it("moves a document close suffix split across chunks of one batch to the end", async () => {
    const out = await runTickedTransformMatchingTextPath([
      ["<!DOCTYPE html><html><head></head><body>"],
      ["<p>ü</p></bo", "dy></html>"],
    ]);

    expect(out).toBe(
      "<!DOCTYPE html><html><head></head><body><script>rsc(1)</script><p>ü</p>" +
        "<script>rsc(2)</script><script>done()</script></body></html>",
    );
  });

  it("matches the text path for a document close suffix split across batches", async () => {
    await runTickedTransformMatchingTextPath([
      ["<!DOCTYPE html><html><head></head><body>"],
      ["<p>ü</p></bo"],
      ["dy></html>"],
    ]);
  });

  it('still rewrites a late preload with as="stylesheet"', async () => {
    const out = await runTickedTransformMatchingTextPath([
      ["<!DOCTYPE html><html><head></head><body>"],
      ['<link rel="preload" href="/late.css" as="stylesheet"/><p>ü</p>'],
      ["</body></html>"],
    ]);

    expect(out).toContain('<link rel="preload" href="/late.css" as="style"/><p>ü</p>');
  });

  it("replaces invalid UTF-8 with U+FFFD like the text path", async () => {
    const out = await runTickedTransformMatchingTextPath([
      ["<!DOCTYPE html><html><head></head><body>"],
      [new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0x3c, 0x2f, 0x70, 0x3e])],
      ["</body></html>"],
    ]);

    expect(out).toContain("<p>\uFFFD</p>");
  });

  it("inlines a late stylesheet link when an inline CSS manifest is present", async () => {
    const out = new TextDecoder().decode(
      concatUint8Arrays(
        await runTickedTransform(
          [
            ["<!DOCTYPE html><html><head></head><body>"],
            ['<link rel="stylesheet" href="/late.css" data-precedence="default"/><p>ü</p>'],
            ["</body></html>"],
          ],
          { inlineCss: { "/late.css": "p{color:red}" } },
        ),
      ),
    );

    expect(out).toContain(
      '<style data-vinext-inline-css data-precedence="default" data-href="/late.css">' +
        "p{color:red}</style><p>ü</p>",
    );
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
