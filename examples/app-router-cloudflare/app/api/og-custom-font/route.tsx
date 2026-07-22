// Ported from Next.js: test/e2e/og-routes-custom-font/app/app/og/route.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/og-routes-custom-font/app/app/og/route.js
//
// Regression coverage for the vinext:og-inline-fetch-assets plugin handling of
// ../-relative font asset paths. The font lives at the example root
// (assets/noto-sans.ttf) — three directories up from this route file — and is
// loaded with `fetch(new URL("../../../assets/noto-sans.ttf", import.meta.url))`.
//
// On Cloudflare Workers import.meta.url is the string "worker", so the runtime
// new URL("../../../assets/...", "worker") throws "TypeError: Invalid URL".
// The plugin must therefore inline the asset as base64 at build time. Before the
// ../-relative fix the plugin only matched ./-relative paths, so this route
// threw at request time and returned a 500.
import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  const font = await fetch(new URL("../../../assets/noto-sans.ttf", import.meta.url)).then((res) =>
    res.arrayBuffer(),
  );

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 88,
        fontFamily: "Noto Sans",
        background: "#fff",
        color: "#000",
      }}
    >
      Custom font OG
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: "Noto Sans",
          data: font,
          style: "normal",
        },
      ],
    },
  );
}
