/**
 * next/og shim
 *
 * Re-exports ImageResponse from @vercel/og which provides OG image generation
 * using Satori (SVG) + Resvg WASM (PNG).
 *
 * The vinext:og-font-patch Vite plugin (in packages/vinext/src/index.ts)
 * patches @vercel/og/dist/index.edge.js at transform time to inline the
 * fallback font as base64 instead of fetching it via import.meta.url.
 * This is required for Cloudflare Workers (cloudflare-dev and cloudflare-workers)
 * where workerd cannot fetch file:// URLs.
 *
 * Usage:
 *   import { ImageResponse } from "next/og";
 *   return new ImageResponse(<div>Hello</div>, { width: 1200, height: 630 });
 */
export { ImageResponse } from "@vercel/og";
export type { ImageResponseOptions } from "@vercel/og";
