/**
 * next/og shim
 *
 * Re-exports ImageResponse from @vercel/og which provides OG image generation
 * using Satori (SVG) + Resvg WASM (PNG).
 *
 * The vinext:og-inline-fetch-assets Vite plugin (in packages/vinext/src/index.ts)
 * patches @vercel/og/dist/index.edge.js at transform time: any
 * `fetch(new URL("./asset", import.meta.url)).then(res => res.arrayBuffer())`
 * expression is replaced with an inline base64 IIFE so no runtime fetch is needed.
 * This is required for Cloudflare Workers where import.meta.url is "worker" (not
 * a real URL) and new URL(..., import.meta.url) would throw at module load time.
 *
 * Usage:
 *   import { ImageResponse } from "next/og";
 *   return new ImageResponse(<div>Hello</div>, { width: 1200, height: 630 });
 */
export { ImageResponse } from "@vercel/og";
export type { ImageResponseOptions } from "@vercel/og";
