// Ported from Next.js: test/e2e/og-routes-custom-font/app/app/og/route.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/og-routes-custom-font/app/app/og/route.js
//
// Regression coverage for the vinext:og-inline-fetch-assets plugin handling of
// ../-relative font asset paths. The font lives at the fixture root
// (assets/noto-sans.ttf) — three directories up from this route file — and is
// loaded with `fetch(new URL("../../../assets/noto-sans.ttf", import.meta.url))`.
//
// The plugin must inline that asset as base64 at build/transform time, because
// the runtime fetch fails everywhere this fixture is exercised:
//   - Cloudflare Workers: import.meta.url is the string "worker", so
//     new URL("../../../assets/...", "worker") throws "TypeError: Invalid URL".
//   - Node.js: the built-in fetch() does not support file:// URLs, so even after
//     import.meta.url is rewritten to a real file path the fetch rejects.
// Before the ../-relative fix the plugin only matched ./-relative paths, so this
// route returned a 500 in every environment.
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
