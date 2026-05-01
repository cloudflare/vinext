import { createInlineScriptTag, safeJsonStringify } from "./html.js";

type RscEmbedTransform = {
  flush(): string;
  finalize(): Promise<string>;
  /** Resolves when all raw bytes from the embed stream have been read. */
  getRawBuffer(): Promise<ArrayBuffer>;
};

type HtmlInsertion = string | (() => string);

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
 * The browser entry turns the embedded text chunks back into Uint8Array data.
 */
export function createRscEmbedTransform(
  embedStream: ReadableStream<Uint8Array>,
  scriptNonce?: string,
): RscEmbedTransform {
  const reader = embedStream.getReader();
  const decoder = new TextDecoder();
  let pendingChunks: string[] = [];
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
        const text = decoder.decode(result.value, { stream: true });
        // The RSC entry already fixes HL hints at the source. Keep this second
        // pass as defense in depth for any embed stream that bypasses that
        // wrapper; the rewrite is idempotent, so double-application is safe.
        pendingChunks.push(fixFlightHints(text));
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
        scripts += createInlineScriptTag(
          "self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push(" +
            safeJsonStringify(chunk) +
            ")",
          scriptNonce,
        );
      }
      return scripts;
    },

    async finalize(): Promise<string> {
      await pumpPromise;
      let scripts = this.flush();
      scripts += createInlineScriptTag("self.__VINEXT_RSC_DONE__=true", scriptNonce);
      return scripts;
    },

    async getRawBuffer(): Promise<ArrayBuffer> {
      await pumpPromise;
      let totalLength = 0;
      for (const chunk of rawChunks) {
        totalLength += chunk.byteLength;
      }
      const buffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of rawChunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
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
 * Create the tick-buffered HTML transform that injects RSC scripts between
 * React Fizz flush cycles without corrupting split HTML chunks.
 */
export function createTickBufferedTransform(
  rscEmbed: RscEmbedTransform,
  injectHTML: HtmlInsertion = "",
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const insertsPerFlush = typeof injectHTML === "function";
  let injected = false;
  let buffered: string[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const readInsertion = (): string =>
    typeof injectHTML === "function" ? injectHTML() : injectHTML;
  const emitInsertion = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    const insertion = readInsertion();
    if (insertion) {
      controller.enqueue(encoder.encode(insertion));
    }
  };

  const flushBuffered = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (buffered.length === 0) return;

    if (injected && insertsPerFlush) {
      // Emit newly collected server-inserted HTML before the next Fizz HTML
      // batch so CSS-in-JS styles precede the elements they style.
      emitInsertion(controller);
    }

    for (const chunk of buffered) {
      if (!injected) {
        const headEnd = chunk.indexOf("</head>");
        if (headEnd !== -1) {
          const before = chunk.slice(0, headEnd);
          const after = chunk.slice(headEnd);
          controller.enqueue(encoder.encode(before + readInsertion() + after));
          injected = true;
          continue;
        }
      }
      controller.enqueue(encoder.encode(chunk));
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
