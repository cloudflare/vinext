import type { ImageResponseOptions } from "@vercel/og";
import type { ReactElement } from "react";
import { shareIsolatePromise } from "../server/isolate-shared-promise.js";

let vercelOg: Promise<typeof import("@vercel/og")> | undefined;

const CACHE_HEADERS = {
  noCache: "no-cache, no-store",
  revalidate: "public, max-age=0, must-revalidate",
} as const;

/**
 * next/og shim.
 *
 * The vinext:og-inline-fetch-assets Vite plugin patches @vercel/og's runtime
 * asset fetches so this wrapper can delegate image generation while preserving
 * Next.js's public ImageResponse headers and option merging semantics.
 */
export class ImageResponse extends Response {
  static displayName = "ImageResponse";

  constructor(element: ReactElement, options?: ImageResponseOptions) {
    let startRendering!: () => void;
    const constructed = new Promise<void>((resolve) => {
      startRendering = resolve;
    });
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        // @vercel/og validates the same response init only after its own
        // render has started, so wait until it is known to be valid here.
        await constructed;
        // @vercel/og defaults only `undefined` options, so `null` makes its
        // constructor throw. Fail the same way before its initialization starts.
        if (options === null)
          throw new TypeError("Cannot read properties of null (reading 'headers')");
        // @vercel/og starts loading its WASM and fallback font when it is
        // evaluated and memoizes them for the isolate. workerd drops a
        // canceled request's pending I/O, so the request that imports it stays
        // alive until its own render, which awaits them, produces output.
        let settleInitialization: (() => void) | undefined;
        if (!vercelOg) {
          // Lazily import @vercel/og so its ~800 KB runtime (satori + resvg +
          // embedded wasm/fonts) is code-split into its own chunk instead of
          // being inlined into the main worker entry, regardless of whether the
          // app imports next/og statically or dynamically.
          vercelOg = import("@vercel/og");
          void shareIsolatePromise(
            new Promise<void>((resolve) => {
              settleInitialization = resolve;
            }),
          );
        }
        try {
          const { ImageResponse: VercelImageResponse } = await vercelOg;
          const imageResponse = new VercelImageResponse(element, options);
          if (!imageResponse.body) {
            controller.close();
            return;
          }

          const reader = imageResponse.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            settleInitialization?.();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } finally {
          settleInitialization?.();
        }
      },
    });

    const headers = new Headers({
      "content-type": "image/png",
      "cache-control":
        process.env.NODE_ENV === "development" ? CACHE_HEADERS.noCache : CACHE_HEADERS.revalidate,
    });
    if (options?.headers) {
      new Headers(options.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    super(readable, {
      headers,
      status: options?.status,
      statusText: options?.statusText,
    });
    startRendering();
  }
}

export type { ImageResponseOptions } from "@vercel/og";
