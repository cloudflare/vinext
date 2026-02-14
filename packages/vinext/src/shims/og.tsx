/**
 * next/og shim
 *
 * Provides `ImageResponse` — generates OG images from JSX using Satori + Resvg.
 *
 * Pipeline: JSX element → Satori (SVG) → Resvg (PNG) → Response
 *
 * Usage:
 *   import { ImageResponse } from "next/og";
 *   return new ImageResponse(<div>Hello</div>, { width: 1200, height: 630 });
 */
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { ReactElement } from "react";

export interface ImageResponseOptions {
  /** Image width in pixels (default: 1200) */
  width?: number;
  /** Image height in pixels (default: 630) */
  height?: number;
  /** Emoji style for rendering emoji characters */
  emoji?: "twemoji" | "blobmoji" | "noto" | "openmoji";
  /** Custom fonts to use for text rendering */
  fonts?: Array<{
    name: string;
    data: ArrayBuffer;
    weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
    style?: "normal" | "italic";
  }>;
  /** Show bounding boxes for debugging layout */
  debug?: boolean;
  /** HTTP status code (default: 200) */
  status?: number;
  /** HTTP status text */
  statusText?: string;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
}

/**
 * Generate an OG image from a JSX element.
 *
 * Returns a standard Web `Response` with `content-type: image/png`.
 * The JSX is rendered using Satori (flexbox layout engine) and Resvg (SVG → PNG).
 *
 * Note: Satori supports a subset of CSS — primarily flexbox layout, text styling,
 * borders, backgrounds, and basic transforms. No CSS Grid, no `calc()`.
 * At least one font must be provided via the `fonts` option.
 */
export class ImageResponse extends Response {
  constructor(element: ReactElement, options: ImageResponseOptions = {}) {
    const {
      width = 1200,
      height = 630,
      fonts = [],
      debug = false,
      status = 200,
      statusText,
      headers: customHeaders,
      ...rest
    } = options;

    // Build the response body as a ReadableStream.
    // The actual rendering is deferred until the stream is consumed,
    // so the heavy Satori/Resvg work only runs when needed.
    const body = new ReadableStream({
      async start(controller) {
        try {
          // Satori: JSX → SVG
          const svg = await satori(element as React.ReactNode, {
            width,
            height,
            fonts: fonts.map((f) => ({
              name: f.name,
              data: f.data,
              weight: f.weight ?? 400,
              style: f.style ?? "normal",
            })),
            debug,
            ...rest,
          });

          // Resvg: SVG → PNG
          const resvg = new Resvg(svg, {
            fitTo: { mode: "width" as const, value: width },
          });
          const rendered = resvg.render();
          const pngBuffer = rendered.asPng();

          controller.enqueue(new Uint8Array(pngBuffer));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    // Build response headers
    const responseHeaders = new Headers({
      "content-type": "image/png",
      "cache-control": "public, immutable, no-transform, max-age=31536000",
    });
    if (customHeaders) {
      for (const [key, value] of Object.entries(customHeaders)) {
        responseHeaders.set(key, value);
      }
    }

    super(body, {
      status,
      statusText,
      headers: responseHeaders,
    });
  }
}
