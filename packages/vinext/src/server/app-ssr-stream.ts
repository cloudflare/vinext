import { fixFlightHints } from "./flight-hints.js";
import { createInlineScriptTag, safeJsonStringify } from "./html.js";

export type RscEmbedTransform = {
  flush(): string;
  finalize(): Promise<string>;
};

export { fixFlightHints };

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
  let reading = false;

  async function pumpReader(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
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

function queueTask(callback: () => void): void {
  if (typeof MessageChannel === "undefined") {
    queueMicrotask(callback);
    return;
  }

  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();
    callback();
  };
  channel.port2.postMessage(undefined);
}

/**
 * Create the tick-buffered HTML transform that injects RSC scripts between
 * React Fizz flush cycles without corrupting split HTML chunks.
 */
export function createTickBufferedTransform(
  rscEmbed: RscEmbedTransform,
  injectHTML = "",
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let injected = false;
  let buffered: string[] = [];
  let flushScheduled = false;

  const flushBuffered = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    for (const chunk of buffered) {
      if (!injected) {
        const headEnd = chunk.indexOf("</head>");
        if (headEnd !== -1) {
          const before = chunk.slice(0, headEnd);
          const after = chunk.slice(headEnd);
          controller.enqueue(encoder.encode(before + injectHTML + after));
          injected = true;
          continue;
        }
      }
      controller.enqueue(encoder.encode(chunk));
    }
    buffered = [];
  };

  const flushHtmlAndRsc = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    flushBuffered(controller);

    const rscScripts = rscEmbed.flush();
    if (rscScripts) {
      controller.enqueue(encoder.encode(rscScripts));
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered.push(fixPreloadAs(decoder.decode(chunk, { stream: true })));

      if (flushScheduled) return;

      flushScheduled = true;
      queueTask(() => {
        if (!flushScheduled) return;
        flushScheduled = false;
        try {
          flushHtmlAndRsc(controller);
        } catch {
          // Stream was cancelled between when the flush was queued and when it
          // ran (e.g. client disconnected, health-check cancelled the response
          // body). Ignore — the stream is already closed.
        }
      });
    },

    async flush(controller) {
      if (flushScheduled) {
        flushScheduled = false;
      }

      flushHtmlAndRsc(controller);

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
