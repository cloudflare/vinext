import { expect, test } from "@playwright/test";

const imagePath = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;

// Ported from Next.js: test/integration/image-optimizer/test/util.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/integration/image-optimizer/test/util.ts
// Next.js serves formats it does not optimize (`BYPASS_TYPES` in
// packages/next/src/server/image-optimizer.ts) as-is, SVG included under
// `images.dangerouslyAllowSVG`, which this example sets. Each is cached for
// the larger of minimumCacheTTL and the max-age a direct request gets, here
// from a `headers()` rule for the ICO. Observed with `next start` on
// next@16.2.7.
test.describe("/_next/image formats Next.js does not optimize", () => {
  for (const [source, contentType, cacheControl] of [
    ["/vinext-logo.svg", "image/svg+xml", "public, max-age=14400, must-revalidate"],
    ["/vinext-icon.ico", "image/x-icon", "public, max-age=86400, must-revalidate"],
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
      expect(response.headers()["cache-control"]).toBe(cacheControl);
      expect(response.headers()["vary"]).toBe("Accept");
      expect(response.headers()["content-security-policy"]).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
      expect(response.headers()["x-content-type-options"]).toBe("nosniff");
      expect(response.headers()["x-nextjs-cache"]).toBe("MISS");
    });
  }
});

// This Worker configures no image optimizer, so a format Next.js would
// optimize is served as-is too, with Next.js's image headers.
test.describe("/_next/image without an image optimizer", () => {
  test("serves a JPEG as-is", async ({ request }) => {
    const original = Buffer.from(await (await request.get("/image-still.jpg")).body());
    const response = await request.get(imagePath("/image-still.jpg"), {
      headers: { Accept: "image/avif,image/webp,*/*" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["location"]).toBeUndefined();
    expect(response.headers()["content-type"]).toBe("image/jpeg");
    expect(Buffer.from(await response.body()).equals(original)).toBe(true);
    expect(response.headers()["cache-control"]).toBe("public, max-age=14400, must-revalidate");
    expect(response.headers()["content-security-policy"]).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
    expect(response.headers()["x-nextjs-cache"]).toBe("MISS");
  });
});
