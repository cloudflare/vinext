import { expect, test } from "@playwright/test";

const imagePath = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;

// Ported from Next.js: test/integration/image-optimizer/test/util.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/integration/image-optimizer/test/util.ts
// Next.js serves formats it does not optimize (`BYPASS_TYPES` in
// packages/next/src/server/image-optimizer.ts) as-is, SVG included under
// `images.dangerouslyAllowSVG`, which this example sets. Observed with
// `next start` on next@16.2.7.
test.describe("/_next/image formats Next.js does not optimize", () => {
  for (const [source, contentType] of [
    ["/vinext-logo.svg", "image/svg+xml"],
    ["/vinext-icon.ico", "image/x-icon"],
  ] as const) {
    test(`serves ${source} as-is with the image endpoint's headers`, async ({ request }) => {
      const original = Buffer.from(await (await request.get(source)).body());
      const response = await request.get(imagePath(source), {
        headers: { Accept: "image/avif,image/webp,*/*" },
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe(contentType);
      expect(Buffer.from(await response.body()).equals(original)).toBe(true);
      // Next.js's image policy at the default `images.minimumCacheTTL`.
      expect(response.headers()["cache-control"]).toBe("public, max-age=14400, must-revalidate");
      expect(response.headers()["vary"]).toBe("Accept");
      expect(response.headers()["content-security-policy"]).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
      expect(response.headers()["x-content-type-options"]).toBe("nosniff");
      expect(response.headers()["x-nextjs-cache"]).toBe("MISS");
    });
  }
});
