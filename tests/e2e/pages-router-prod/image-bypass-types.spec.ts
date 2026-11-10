import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4175";

// Ported from Next.js: packages/next/src/server/image-optimizer.ts
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/image-optimizer.ts
// Next.js serves ICNS and JPEG XL sources as-is (`BYPASS_TYPES`). The Node
// server judges a source by its file extension, so it must know both. Each
// is cached for the larger of minimumCacheTTL and the max-age a direct request
// gets, here from a next.config.mjs `headers()` rule for the JPEG XL file
// (observed with `next start` on next@16.2.7).
test.describe("/_next/image ICNS and JPEG XL sources", () => {
  for (const [source, contentType, cacheControl] of [
    ["/vinext-icon.icns", "image/x-icns", "public, max-age=14400, must-revalidate"],
    ["/vinext-image.jxl", "image/jxl", "public, max-age=86400, must-revalidate"],
  ] as const) {
    test(`serves ${source} as-is`, async ({ request }) => {
      const original = Buffer.from(await (await request.get(`${BASE}${source}`)).body());
      const response = await request.get(
        `${BASE}/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`,
      );
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe(contentType);
      expect(Buffer.from(await response.body()).equals(original)).toBe(true);
      expect(response.headers()["cache-control"]).toBe(cacheControl);
    });
  }
});
