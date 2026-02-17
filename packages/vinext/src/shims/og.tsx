/**
 * next/og shim
 *
 * Re-exports ImageResponse from @vercel/og which provides OG image generation
 * using Satori (SVG) + Resvg WASM (PNG).
 *
 * IMPORTANT: @vercel/og eagerly fetches a fallback font at module initialization
 * time using `import.meta.url`. In Cloudflare Workers, `import.meta.url` may not
 * be a valid fetchable URL, which can cause crashes at module load time.
 * 
 * If you encounter "Invalid URL string" errors, ensure your OG route uses
 * dynamic imports: `const { ImageResponse } = await import("next/og")`
 *
 * Usage:
 *   import { ImageResponse } from "next/og";
 *   return new ImageResponse(<div>Hello</div>, { width: 1200, height: 630 });
 */
export { ImageResponse } from "@vercel/og";
export type { ImageResponseOptions } from "@vercel/og";
