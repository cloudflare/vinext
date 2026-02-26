/**
 * Behavioral tests for tick-buffered RSC streaming.
 *
 * The tick-buffered TransformStream in app-dev-server.ts interleaves RSC
 * <script> tags into the HTML stream between React Fizz flush cycles. These
 * tests exercise the actual TransformStream algorithm (replicated from the
 * generated SSR entry) to verify:
 *
 * 1. RSC scripts are interleaved between HTML flush cycles
 * 2. No RSC scripts are injected mid-HTML-chunk (DOM corruption case)
 * 3. The __VINEXT_RSC_DONE__ signal appears after all content
 * 4. Head injection happens correctly
 * 5. Multiple HTML chunks in the same macrotask are batched correctly
 *
 * This complements the string-matching tests in app-router.test.ts which
 * verify the generated code contains the right constructs, but don't
 * exercise the actual streaming behavior.
 *
 * NOTE: The helpers below replicate the core algorithm from generateSsrEntry()
 * rather than importing it, because the production code is emitted as a
 * string literal inside a generated module — it's not importable as a
 * function. Two production behaviors are intentionally omitted here since
 * they are orthogonal to the streaming/interleaving logic being tested:
 *   - fixFlightHints(): rewrites as="stylesheet" → as="style" in RSC hints
 *   - fixPreloadAs(): rewrites as="stylesheet" → as="style" in HTML preloads
 */
import { describe, it, expect } from "vitest";
import { safeJsonStringify } from "../packages/vinext/src/server/html.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Replicate createRscEmbedTransform from the generated SSR entry.
 * This reads from an RSC embed stream in the background and provides
 * flush()/finalize() methods to emit <script> tags.
 */
function createRscEmbedTransform(embedStream: ReadableStream<Uint8Array>) {
  const reader = embedStream.getReader();
  const decoder = new TextDecoder();
  let _done = false;
  let pendingChunks: string[] = [];
  let reading = false;

  async function pumpReader() {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          _done = true;
          break;
        }
        pendingChunks.push(decoder.decode(result.value, { stream: true }));
      }
    } catch {
      _done = true;
    }
    reading = false;
  }

  const pumpPromise = pumpReader();

  return {
    flush() {
      if (pendingChunks.length === 0) return "";
      const chunks = pendingChunks;
      pendingChunks = [];
      let scripts = "";
      for (const chunk of chunks) {
        scripts +=
          "<script>self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push(" +
          safeJsonStringify(chunk) +
          ")</script>";
      }
      return scripts;
    },

    async finalize() {
      await pumpPromise;
      let scripts = this.flush();
      scripts += "<script>self.__VINEXT_RSC_DONE__=true</script>";
      return scripts;
    },
  };
}

/**
 * Create the tick-buffered TransformStream that interleaves RSC scripts
 * between HTML flush cycles. Replicated from the generated SSR entry
 * in app-dev-server.ts.
 */
function createTickBufferedTransform(
  rscEmbed: ReturnType<typeof createRscEmbedTransform>,
  injectHTML: string = "",
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let injected = false;
  let buffered: string[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      buffered.push(text);

      if (timeoutId !== null) return;

      timeoutId = setTimeout(() => {
        for (const buf of buffered) {
          if (!injected) {
            const headEnd = buf.indexOf("</head>");
            if (headEnd !== -1) {
              const before = buf.slice(0, headEnd);
              const after = buf.slice(headEnd);
              controller.enqueue(encoder.encode(before + injectHTML + after));
              injected = true;
              continue;
            }
          }
          controller.enqueue(encoder.encode(buf));
        }
        buffered = [];

        const rscScripts = rscEmbed.flush();
        if (rscScripts) {
          controller.enqueue(encoder.encode(rscScripts));
        }

        timeoutId = null;
      }, 0);
    },
    async flush(controller) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      for (const buf of buffered) {
        if (!injected) {
          const headEnd = buf.indexOf("</head>");
          if (headEnd !== -1) {
            const before = buf.slice(0, headEnd);
            const after = buf.slice(headEnd);
            controller.enqueue(encoder.encode(before + injectHTML + after));
            injected = true;
            continue;
          }
        }
        controller.enqueue(encoder.encode(buf));
      }
      buffered = [];

      if (!injected && injectHTML) {
        controller.enqueue(encoder.encode(injectHTML));
      }

      const finalScripts = await rscEmbed.finalize();
      if (finalScripts) {
        controller.enqueue(encoder.encode(finalScripts));
      }
    },
  });
}

/**
 * Create a ReadableStream from an array of string chunks, with optional
 * delay between groups to simulate React Fizz flush cycles.
 *
 * Each entry in `chunkGroups` is an array of strings that are written
 * synchronously (same macrotask), simulating how Fizz flushes multiple
 * chunks within one flushCompletedQueues call.
 *
 * Between groups, a macrotask boundary is inserted via setTimeout(0).
 */
function createMockHtmlStream(
  chunkGroups: string[][],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (let i = 0; i < chunkGroups.length; i++) {
        // Write all chunks in this group synchronously (same macrotask)
        for (const chunk of chunkGroups[i]) {
          controller.enqueue(encoder.encode(chunk));
        }
        // Wait for next macrotask between groups (simulates Fizz flush boundary)
        if (i < chunkGroups.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      controller.close();
    },
  });
}

/**
 * Create a mock RSC embed stream that emits chunks with controllable timing.
 * Returns the stream and a controller to push chunks / close.
 */
function createMockRscStream() {
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  return {
    stream,
    push(data: string) {
      streamController.enqueue(encoder.encode(data));
    },
    close() {
      streamController.close();
    },
  };
}

/**
 * Collect all output from a ReadableStream into a single string.
 */
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

/**
 * Collect output from a ReadableStream as individual string chunks,
 * preserving the chunk boundaries from the TransformStream output.
 */
async function collectStreamChunks(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Tick-buffered RSC streaming (behavioral)", () => {
  it("interleaves RSC scripts between HTML flush cycles", async () => {
    // Set up: RSC stream with two chunks pushed before HTML starts
    const rsc = createMockRscStream();
    rsc.push('0:D{"name":"page"}\n');
    rsc.push('1:["$","div",null,{"children":"Hello"}]\n');

    const rscEmbed = createRscEmbedTransform(rsc.stream);

    // Give the RSC reader time to consume the chunks
    await new Promise((resolve) => setTimeout(resolve, 10));

    // HTML stream: two flush cycles
    // Cycle 1: shell with head
    // Cycle 2: body content after Suspense resolves
    const htmlStream = createMockHtmlStream([
      ["<html><head></head><body><div id='root'>"],
      ["<div>Suspense resolved</div></div></body></html>"],
    ]);

    // Close RSC stream before second flush cycle completes
    setTimeout(() => rsc.close(), 5);

    const transform = createTickBufferedTransform(rscEmbed);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // RSC scripts should be present in output
    expect(output).toContain("__VINEXT_RSC_CHUNKS__");
    // Done signal should be present
    expect(output).toContain("__VINEXT_RSC_DONE__=true");
    // HTML content should be intact
    expect(output).toContain("<div id='root'>");
    expect(output).toContain("<div>Suspense resolved</div>");
  });

  it("does not inject scripts mid-HTML-chunk (DOM corruption prevention)", async () => {
    // This tests the core safety invariant: when React Fizz flushes multiple
    // chunks synchronously (same macrotask), scripts must NOT appear between them.
    // For example, Fizz might split an SVG element across chunks:
    //   chunk1: "<svg><linearGradi"
    //   chunk2: "ent></linearGradient></svg>"
    // Injecting a <script> between these would corrupt the DOM.

    const rsc = createMockRscStream();
    rsc.push('0:D{"name":"page"}\n');

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate Fizz splitting an element across chunks in the SAME macrotask
    const htmlStream = createMockHtmlStream([
      [
        "<html><head></head><body><svg><linearGradi",
        "ent id='g1'></linearGradient></svg>",
      ],
    ]);

    rsc.close();

    const transform = createTickBufferedTransform(rscEmbed);
    const chunks = await collectStreamChunks(htmlStream.pipeThrough(transform));

    // Reconstruct the full output
    const output = chunks.join("");

    // The split SVG element must be intact — no script between the two parts
    expect(output).toContain(
      "<svg><linearGradient id='g1'></linearGradient></svg>"
    );

    // RSC scripts should still be present (after the HTML, not mid-element)
    expect(output).toContain("__VINEXT_RSC_CHUNKS__");

    // Verify no <script> tag appears between the split HTML fragments
    // by checking that the linearGradient element is contiguous
    const svgStart = output.indexOf("<svg>");
    const svgEnd = output.indexOf("</svg>") + "</svg>".length;
    const svgContent = output.slice(svgStart, svgEnd);
    expect(svgContent).not.toContain("<script>");
  });

  it("batches multiple same-macrotask HTML chunks before injecting RSC scripts", async () => {
    const rsc = createMockRscStream();
    rsc.push('0:D{"name":"layout"}\n');

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Three HTML chunks in the same macrotask (simulates large Fizz flush)
    const htmlStream = createMockHtmlStream([
      [
        "<html><head></head><body>",
        "<div>chunk1</div>",
        "<div>chunk2</div>",
      ],
    ]);

    rsc.close();

    const transform = createTickBufferedTransform(rscEmbed);
    const chunks = await collectStreamChunks(htmlStream.pipeThrough(transform));
    const output = chunks.join("");

    // All three HTML chunks should appear contiguously (no script between them)
    expect(output).toContain(
      "<body><div>chunk1</div><div>chunk2</div>"
    );

    // RSC scripts should appear AFTER all the HTML chunks
    const htmlEnd = output.indexOf("<div>chunk2</div>") + "<div>chunk2</div>".length;
    const scriptStart = output.indexOf("__VINEXT_RSC_CHUNKS__");
    expect(scriptStart).toBeGreaterThan(htmlEnd);
  });

  it("delivers RSC chunks progressively across multiple flush cycles", async () => {
    const rsc = createMockRscStream();

    const rscEmbed = createRscEmbedTransform(rsc.stream);

    // Push RSC chunk before first HTML flush
    rsc.push('0:D{"name":"layout"}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // We need to manually orchestrate timing between HTML flushes and RSC pushes.
    const encoder = new TextEncoder();

    const htmlStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Flush cycle 1: HTML shell
        controller.enqueue(encoder.encode("<html><head></head><body>"));
        // Wait for macrotask boundary (so transform flushes cycle 1)
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Push second RSC chunk between flush cycles
        rsc.push('1:["$","div",null,{"children":"Resolved boundary 1"}]\n');
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Flush cycle 2: first Suspense boundary resolves
        controller.enqueue(encoder.encode("<div>Boundary 1</div>"));
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Push third RSC chunk
        rsc.push('2:["$","span",null,{"children":"Resolved boundary 2"}]\n');
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Flush cycle 3: second Suspense boundary resolves
        controller.enqueue(encoder.encode("<div>Boundary 2</div></body></html>"));
        rsc.close();
        controller.close();
      },
    });

    const transform = createTickBufferedTransform(rscEmbed);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // All HTML should be present
    expect(output).toContain("<html><head></head><body>");
    expect(output).toContain("<div>Boundary 1</div>");
    expect(output).toContain("<div>Boundary 2</div>");

    // RSC scripts should be present for all chunks
    expect(output).toContain("__VINEXT_RSC_CHUNKS__");

    // Done signal at the end
    expect(output).toContain("__VINEXT_RSC_DONE__=true");

    // The done signal should come AFTER all HTML content
    const lastHtmlPos = output.indexOf("</html>");
    const donePos = output.indexOf("__VINEXT_RSC_DONE__=true");
    expect(donePos).toBeGreaterThan(lastHtmlPos);
  });

  it("injects head content before </head>", async () => {
    const rsc = createMockRscStream();
    rsc.close(); // No RSC chunks needed for this test

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const injectHTML = '<script>self.__VINEXT_RSC_PARAMS__={"slug":"test"}</script>';

    const htmlStream = createMockHtmlStream([
      ["<html><head><title>Test</title></head><body>content</body></html>"],
    ]);

    const transform = createTickBufferedTransform(rscEmbed, injectHTML);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // Injected content should appear before </head>
    const injectPos = output.indexOf('__VINEXT_RSC_PARAMS__');
    const headEndPos = output.indexOf("</head>");
    expect(injectPos).toBeGreaterThan(-1);
    expect(injectPos).toBeLessThan(headEndPos);

    // Original head content should be preserved
    expect(output).toContain("<title>Test</title>");
  });

  it("handles head injection when </head> is in a later chunk", async () => {
    const rsc = createMockRscStream();
    rsc.close();

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const injectHTML = '<meta name="injected" content="true">';

    // </head> appears in the second flush cycle
    const htmlStream = createMockHtmlStream([
      ["<html><head><title>Test</title>"],
      ["</head><body>content</body></html>"],
    ]);

    const transform = createTickBufferedTransform(rscEmbed, injectHTML);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // Injected content should appear before </head>
    const injectPos = output.indexOf('name="injected"');
    const headEndPos = output.indexOf("</head>");
    expect(injectPos).toBeGreaterThan(-1);
    expect(injectPos).toBeLessThan(headEndPos);
  });

  it("still injects head content even without </head> in stream", async () => {
    const rsc = createMockRscStream();
    rsc.close();

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const injectHTML = '<meta name="fallback">';

    // No </head> in the HTML at all (edge case)
    const htmlStream = createMockHtmlStream([
      ["<body>content</body>"],
    ]);

    const transform = createTickBufferedTransform(rscEmbed, injectHTML);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // Should still inject the content (at the end, via flush handler fallback)
    expect(output).toContain('name="fallback"');
  });

  it("emits __VINEXT_RSC_DONE__ signal even with empty RSC stream", async () => {
    const rsc = createMockRscStream();
    rsc.close(); // Close immediately — no RSC chunks

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const htmlStream = createMockHtmlStream([
      ["<html><head></head><body>Hello</body></html>"],
    ]);

    const transform = createTickBufferedTransform(rscEmbed);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // Done signal must always be present so the browser knows streaming is complete
    expect(output).toContain("__VINEXT_RSC_DONE__=true");
    // No RSC chunks should be present
    expect(output).not.toContain("__VINEXT_RSC_CHUNKS__");
  });

  it("handles RSC chunks arriving after HTML stream closes", async () => {
    // Edge case: RSC stream outlives HTML stream (slow async server components)
    const rsc = createMockRscStream();
    rsc.push('0:D{"name":"page"}\n');

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const htmlStream = createMockHtmlStream([
      ["<html><head></head><body>Shell</body></html>"],
    ]);

    // Push more RSC data after a delay, then close
    setTimeout(() => {
      rsc.push('1:["$","div",null,{"children":"Late data"}]\n');
      rsc.close();
    }, 30);

    const transform = createTickBufferedTransform(rscEmbed);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // HTML should be present
    expect(output).toContain("Shell");
    // The late RSC chunk should still be emitted (finalize waits for RSC stream)
    expect(output).toContain("__VINEXT_RSC_CHUNKS__");
    // Done signal must be present
    expect(output).toContain("__VINEXT_RSC_DONE__=true");
  });

  it("preserves RSC chunk ordering", async () => {
    const rsc = createMockRscStream();

    const rscEmbed = createRscEmbedTransform(rsc.stream);

    // Push chunks in specific order
    rsc.push('0:D{"name":"layout"}\n');
    rsc.push('1:D{"name":"page"}\n');
    rsc.push('2:["$","div",null,{}]\n');
    rsc.close();

    await new Promise((resolve) => setTimeout(resolve, 10));

    const htmlStream = createMockHtmlStream([
      ["<html><head></head><body>content</body></html>"],
    ]);

    const transform = createTickBufferedTransform(rscEmbed);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // Extract RSC script contents to verify ordering
    const scriptRegex = /__VINEXT_RSC_CHUNKS__\.push\(([^)]+)\)/g;
    const matches: string[] = [];
    let match;
    while ((match = scriptRegex.exec(output)) !== null) {
      matches.push(match[1]);
    }

    // Should have 3 RSC chunks in order
    expect(matches.length).toBe(3);

    // Chunks are now text strings, so just parse the JSON strings directly
    const chunk0 = JSON.parse(matches[0]);
    const chunk1 = JSON.parse(matches[1]);
    const chunk2 = JSON.parse(matches[2]);

    expect(chunk0).toContain('0:D{"name":"layout"}');
    expect(chunk1).toContain('1:D{"name":"page"}');
    expect(chunk2).toContain('2:["$","div"');
  });

  it("handles large number of interleaved flush cycles correctly", async () => {
    const rsc = createMockRscStream();
    const rscEmbed = createRscEmbedTransform(rsc.stream);

    // Push initial RSC chunk
    rsc.push('0:D{"name":"root"}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Create an HTML stream with many flush cycles (simulates deeply nested Suspense)
    const encoder = new TextEncoder();
    const htmlStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("<html><head></head><body>"));

        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          // Push RSC chunk for this boundary
          rsc.push(`${i + 1}:["$","div",null,{"children":"Boundary ${i}"}]\n`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(
            encoder.encode(`<div data-boundary="${i}">Content ${i}</div>`)
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
        rsc.close();
        controller.enqueue(encoder.encode("</body></html>"));
        controller.close();
      },
    });

    const transform = createTickBufferedTransform(rscEmbed);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // All 5 boundaries should be in the HTML
    for (let i = 0; i < 5; i++) {
      expect(output).toContain(`data-boundary="${i}"`);
      expect(output).toContain(`Content ${i}`);
    }

    // All RSC chunks should be present (initial + 5 boundaries = 6 total)
    // Count .push() calls, not raw occurrences of __VINEXT_RSC_CHUNKS__
    // (each script tag contains __VINEXT_RSC_CHUNKS__ multiple times in the init pattern)
    const scriptCount = (output.match(/__VINEXT_RSC_CHUNKS__\.push\(/g) || []).length;
    expect(scriptCount).toBe(6);

    // Done signal at the end
    expect(output).toContain("__VINEXT_RSC_DONE__=true");

    // Done signal should be the last script
    const lastChunksPos = output.lastIndexOf("__VINEXT_RSC_CHUNKS__");
    const donePos = output.indexOf("__VINEXT_RSC_DONE__");
    expect(donePos).toBeGreaterThan(lastChunksPos);
  });

  it("XSS-safe: safeJsonStringify prevents </script> breakout in RSC data", async () => {
    const rsc = createMockRscStream();

    // Push RSC data that contains a </script> payload
    const malicious = '0:["$","div",null,{"dangerouslySetInnerHTML":{"__html":"</script><script>alert(1)</script>"}}]\n';
    rsc.push(malicious);
    rsc.close();

    const rscEmbed = createRscEmbedTransform(rsc.stream);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const htmlStream = createMockHtmlStream([
      ["<html><head></head><body>content</body></html>"],
    ]);

    const transform = createTickBufferedTransform(rscEmbed);
    const output = await collectStream(htmlStream.pipeThrough(transform));

    // The output should contain the RSC chunk
    expect(output).toContain("__VINEXT_RSC_CHUNKS__");

    // RSC data is now stored as a JSON text string. safeJsonStringify escapes
    // <, >, and & characters so that </script> in the RSC data cannot break
    // out of the enclosing <script> tag. The < and > characters are escaped
    // to \\u003c and \\u003e respectively.

    // The raw string "</script>" should NOT appear outside of the proper
    // script tags we control. Count actual <script> and </script> tags —
    // they should be balanced (our tags only, not the malicious payload).
    // lgtm[js/bad-tag-filter] — counting tags to verify XSS protection, not filtering HTML
    const openScripts = (output.match(/<script>/g) || []).length;
    const closeScripts = (output.match(/<\/script>/g) || []).length;
    expect(openScripts).toBe(closeScripts);

    // The malicious raw HTML should NOT appear as actual HTML in the output
    expect(output).not.toContain("alert(1)</script>");

    // Verify the </script> characters are escaped in the JSON string output.
    // safeJsonStringify escapes '<' to '\\u003c' and '>' to '\\u003e',
    // so the malicious payload is safely neutralized.
    expect(output).toContain("\\u003c/script\\u003e");
    expect(output).not.toContain(",60,47,115,99,114,105,112,116,62,");
  });
});
