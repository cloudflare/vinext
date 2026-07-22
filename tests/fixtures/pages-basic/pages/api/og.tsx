// Ported from Next.js: test/e2e/og-api/app/pages/api/og.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/og-api/app/pages/api/og.js
//
// Pages Router OG image route — uses `next/og` ImageResponse from inside a
// Pages Router edge API route. Regression coverage for cloudflare/vinext#1338
// where this combination was reported as returning 404 in the Next.js deploy
// suite.
import { ImageResponse } from "next/og";

export const config = {
  runtime: "edge",
};

export default function handler() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 128,
        background: "lavender",
      }}
    >
      Hello!
    </div>,
  );
}
