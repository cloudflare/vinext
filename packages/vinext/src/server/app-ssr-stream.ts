import { createInlineScriptTag, safeJsonStringify } from "./html.js";
import {
  bytesToBase64,
  concatUint8Arrays,
  RSC_EMBEDDED_BINARY_CHUNK,
  type RscEmbeddedChunk,
} from "./app-rsc-embedded-chunks.js";
import { NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION } from "../client/navigation-runtime.js";

type RscEmbedTransform = {
  flush(): string;
  finalize(): Promise<string>;
  /** Resolves when all raw bytes from the embed stream have been read. */
  getRawBuffer(): Promise<ArrayBuffer>;
};

type HtmlInsertion = string | (() => string);

const NAVIGATION_RUNTIME_REFERENCE = `self[Symbol.for(${safeJsonStringify(
  NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION,
)})]`;

export function navigationRuntimeRscBootstrapExpression(): string {
  return `((${NAVIGATION_RUNTIME_REFERENCE}??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]})`;
}

export function createNavigationRuntimeRscMetadataScript(
  params: Record<string, string | string[]>,
  nav: { pathname: string; searchParams: [string, string][] },
): string {
  return (
    "Object.assign(" +
    navigationRuntimeRscBootstrapExpression() +
    ",{params:" +
    safeJsonStringify(params) +
    ",nav:" +
    safeJsonStringify(nav) +
    "})"
  );
}

function createNavigationRuntimeRscChunkScript(chunk: RscEmbeddedChunk): string {
  return navigationRuntimeRscBootstrapExpression() + ".rsc.push(" + safeJsonStringify(chunk) + ")";
}

function createNavigationRuntimeRscDoneScript(): string {
  return navigationRuntimeRscBootstrapExpression() + ".done=true";
}

/**
 * Fix invalid preload "as" values in RSC Flight hint lines before they reach
 * the client. React Flight emits HL hints with as="stylesheet" for CSS, but
 * the HTML spec requires as="style" for <link rel="preload">.
 */
export function fixFlightHints(text: string): string {
  return text.replace(/(\d*:HL\[.*?),"stylesheet"(\]|,)/g, '$1,"style"$2');
}

/**
 * Create a helper that progressively embeds RSC chunks as inline <script> tags.
 * The browser entry turns the embedded chunks back into Uint8Array data.
 */
export function createRscEmbedTransform(
  embedStream: ReadableStream<Uint8Array>,
  scriptNonce?: string,
): RscEmbedTransform {
  const reader = embedStream.getReader();
  let pendingChunks: RscEmbeddedChunk[] = [];
  const rawChunks: Uint8Array[] = [];
  let reading = false;

  async function pumpReader(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        // Accumulate raw bytes BEFORE fixFlightHints so the cache stores
        // unmodified RSC data. The embed script path below applies fixes.
        rawChunks.push(result.value);
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const text = decoder.decode(result.value);
          // The RSC entry already fixes HL hints at the source. Keep this second
          // pass as defense in depth for any embed stream that bypasses that
          // wrapper; the rewrite is idempotent, so double-application is safe.
          pendingChunks.push(fixFlightHints(text));
        } catch {
          pendingChunks.push([RSC_EMBEDDED_BINARY_CHUNK, bytesToBase64(result.value)]);
        }
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[vinext] RSC embed stream read error:", error);
      }
      throw error;
    } finally {
      reading = false;
    }
  }

  const pumpPromise = pumpReader();

  return {
    flush(): string {
      if (pendingChunks.length === 0) return "";

      const chunks = pendingChunks;
      pendingChunks = [];

      let scripts = "";
      for (const chunk of chunks) {
        scripts += createInlineScriptTag(createNavigationRuntimeRscChunkScript(chunk), scriptNonce);
      }
      return scripts;
    },

    async finalize(): Promise<string> {
      await pumpPromise;
      let scripts = this.flush();
      scripts += createInlineScriptTag(createNavigationRuntimeRscDoneScript(), scriptNonce);
      return scripts;
    },

    async getRawBuffer(): Promise<ArrayBuffer> {
      await pumpPromise;
      const buffer = concatUint8Arrays(rawChunks);
      rawChunks.length = 0;
      return buffer.buffer;
    },
  };
}

/**
 * Fix invalid preload "as" values in server-rendered HTML.
 * React Fizz emits <link rel="preload" as="stylesheet"> for CSS, but the
 * HTML spec requires as="style" for <link rel="preload">.
 */
export function fixPreloadAs(html: string): string {
  return html.replace(/<link(?=[^>]*\srel="preload")[^>]*>/g, (tag) =>
    tag.replace(' as="stylesheet"', ' as="style"'),
  );
}

/**
 * Match the `<head ...>` opening tag in a chunk. Matches both bare `<head>`
 * and `<head class="foo">` shapes. Used to splice HTML immediately after the
 * opening tag so injected content runs before any React-emitted resource
 * hints (stylesheets, modulepreloads) that React Float hoists into `<head>`.
 */
const HEAD_OPEN_RE = /<head\b[^>]*>/;

/**
 * Create the tick-buffered HTML transform that injects RSC scripts between
 * React Fizz flush cycles without corrupting split HTML chunks.
 *
 * Two insertion points are supported in tandem:
 *
 *  - `injectHTML` is emitted immediately before `</head>`. This is where the
 *    bulk of vinext's head additions live (RSC navigation runtime metadata,
 *    bootstrap modulepreload, server-inserted HTML, font preloads, etc.).
 *  - `injectAfterHeadOpenHTML` is emitted immediately after the `<head ...>`
 *    opening tag so the content runs before any React-emitted resource
 *    hints. This is where inline `<Script strategy="beforeInteractive">`
 *    captures land so the no-flash dark-mode pattern works.
 *
 * Fallback behaviour differs by insertion point:
 *
 *  - `injectHTML` is emitted at end-of-stream by the `flush` handler when no
 *    chunk ever contained `</head>` — callers still see the payload on
 *    highly fragmented streams (just at the end of the body rather than in
 *    the head).
 *  - `injectAfterHeadOpenHTML` is silently dropped when `<head ...>` is not
 *    found in a discoverable chunk. Emitting it at end-of-stream would put
 *    it after the document body, defeating the point — the splice has to
 *    happen before resource hints to be useful, so the safer behaviour is
 *    to no-op and let the user-rendered Script (in its source-order
 *    position) ship as-is.
 */
export function createTickBufferedTransform(
  rscEmbed: RscEmbedTransform,
  injectHTML: HtmlInsertion = "",
  injectAfterHeadOpenHTML: HtmlInsertion = "",
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const insertsPerFlush = typeof injectHTML === "function";
  let injected = false;
  let preHeadInjected = false;
  let buffered: string[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const readInsertion = (): string =>
    typeof injectHTML === "function" ? injectHTML() : injectHTML;
  const readPreHeadInsertion = (): string =>
    typeof injectAfterHeadOpenHTML === "function"
      ? injectAfterHeadOpenHTML()
      : injectAfterHeadOpenHTML;
  const emitInsertion = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    const insertion = readInsertion();
    if (insertion) {
      controller.enqueue(encoder.encode(insertion));
    }
  };

  /**
   * Splice the pre-head insertion (typically captured beforeInteractive inline
   * scripts) immediately after the `<head ...>` opening tag. Returns the
   * rewritten chunk and a flag indicating whether the splice happened, so the
   * caller can mark `preHeadInjected` and stop scanning further chunks.
   *
   * NOTE: This is called only when `<head ...>` lies fully inside `chunk` —
   * we deliberately avoid stitching across chunk boundaries because doing so
   * would force the transform to hold output until it had seen `<head ...>`,
   * which both delays TTFB and complicates the existing `</head>` injection
   * path. In practice React Fizz emits the opening shell as a single chunk.
   */
  const spliceAfterHeadOpen = (chunk: string): { chunk: string; spliced: boolean } => {
    if (preHeadInjected) return { chunk, spliced: false };
    const insertion = readPreHeadInsertion();
    if (!insertion) return { chunk, spliced: false };
    const match = HEAD_OPEN_RE.exec(chunk);
    if (!match) return { chunk, spliced: false };
    const insertAt = match.index + match[0].length;
    return {
      chunk: chunk.slice(0, insertAt) + insertion + chunk.slice(insertAt),
      spliced: true,
    };
  };

  const flushBuffered = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (buffered.length === 0) return;

    if (injected && insertsPerFlush) {
      // Emit newly collected server-inserted HTML before the next Fizz HTML
      // batch so CSS-in-JS styles precede the elements they style.
      emitInsertion(controller);
    }

    for (const chunk of buffered) {
      let working = chunk;
      if (!preHeadInjected) {
        const result = spliceAfterHeadOpen(working);
        if (result.spliced) {
          working = result.chunk;
          preHeadInjected = true;
        }
      }
      if (!injected) {
        const headEnd = working.indexOf("</head>");
        if (headEnd !== -1) {
          const before = working.slice(0, headEnd);
          const after = working.slice(headEnd);
          controller.enqueue(encoder.encode(before + readInsertion() + after));
          injected = true;
          continue;
        }
      }
      controller.enqueue(encoder.encode(working));
    }
    buffered = [];
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered.push(fixPreloadAs(decoder.decode(chunk, { stream: true })));

      if (timeoutId !== null) return;

      timeoutId = setTimeout(() => {
        try {
          flushBuffered(controller);

          const rscScripts = rscEmbed.flush();
          if (rscScripts) {
            controller.enqueue(encoder.encode(rscScripts));
          }
        } catch {
          // Stream was cancelled between when the timeout was registered and
          // when it fired (e.g. client disconnected, health-check cancelled
          // the response body). Ignore — the stream is already closed.
        }

        timeoutId = null;
      }, 0);
    },

    async flush(controller) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      flushBuffered(controller);

      if (!injected) {
        emitInsertion(controller);
        injected = true;
      } else if (insertsPerFlush) {
        emitInsertion(controller);
      }

      const finalScripts = await rscEmbed.finalize();
      if (finalScripts) {
        controller.enqueue(encoder.encode(finalScripts));
      }
    },
  });
}
