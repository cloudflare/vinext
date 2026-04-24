type NavigationSnapshot = {
  pathname: string;
  searchParams: [string, string][];
};

type LegacyRscEmbedData = {
  rsc: string[];
  params?: Record<string, string | string[]>;
  nav?: NavigationSnapshot;
};

type VinextBrowserGlobals = {
  __VINEXT_RSC__?: LegacyRscEmbedData;
  __VINEXT_RSC_CHUNKS__?: string[];
  __VINEXT_RSC_DONE__?: boolean;
  __VINEXT_RSC_PARAMS__?: Record<string, string | string[]>;
  __VINEXT_RSC_NAV__?: NavigationSnapshot;
};

export function getVinextBrowserGlobal(): typeof globalThis & VinextBrowserGlobals {
  return globalThis as typeof globalThis & VinextBrowserGlobals;
}

/**
 * Convert embedded text chunks back to a ReadableStream of Uint8Array chunks.
 */
export function chunksToReadableStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/**
 * Create a ReadableStream from progressively-embedded RSC chunks.
 *
 * The server pushes chunks into `__VINEXT_RSC_CHUNKS__` via inline <script>
 * tags. We monkey-patch `push()` so new chunks stream to React immediately
 * instead of polling with setTimeout.
 */
export function createProgressiveRscStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const vinext = getVinextBrowserGlobal();
      const initialChunks = vinext.__VINEXT_RSC_CHUNKS__ ?? [];

      for (const chunk of initialChunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      if (vinext.__VINEXT_RSC_DONE__) {
        controller.close();
        return;
      }

      let closed = false;
      const closeOnce = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      const arr = (vinext.__VINEXT_RSC_CHUNKS__ ??= []);
      arr.push = function (...chunks: string[]): number {
        const length = Array.prototype.push.apply(this, chunks);

        if (closed) return length;

        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }

        if (vinext.__VINEXT_RSC_DONE__) {
          closeOnce();
        }

        return length;
      };

      if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", closeOnce);
        } else {
          closeOnce();
        }
      }
    },
  });
}
