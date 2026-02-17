/**
 * next/og shim
 *
 * Re-exports ImageResponse from @vercel/og which provides OG image generation
 * using Satori (SVG) + Resvg WASM (PNG).
 *
 * Usage:
 *   import { ImageResponse } from "next/og";
 *   return new ImageResponse(<div>Hello</div>, { width: 1200, height: 630 });
 */
export { ImageResponse } from "@vercel/og";
export type { ImageResponseOptions } from "@vercel/og";
