import { test, expect } from "@playwright/test";

// Ported from Next.js: test/integration/image-optimizer/test/util.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/integration/image-optimizer/test/util.ts
// The Worker serves `/_next/image` through the Cloudflare Images binding and
// keeps no image cache, so it matches Next.js with the image cache disabled
// (`images.maximumDiskCacheSize: 0`): every 200 is a MISS.
test.describe("Cloudflare Workers /_next/image cache-state headers", () => {
  const imagePath = "/_next/image?url=%2Fvinext-image.png&w=64&q=75";

  test("labels every image response MISS", async ({ request }) => {
    for (const attempt of ["first", "repeat"]) {
      const response = await request.get(imagePath, {
        headers: { Accept: "image/webp" },
        maxRedirects: 0,
      });
      expect(response.status(), attempt).toBe(200);
      // Transformed by the Images binding, not passed through.
      expect(response.headers()["content-type"], attempt).toBe("image/webp");
      expect(response.headers()["x-nextjs-cache"], attempt).toBe("MISS");
      expect(response.headers()["x-vinext-cache"], attempt).toBe("MISS");
    }
  });

  test("sends no x-nextjs-cache or x-vinext-cache on an error", async ({ request }) => {
    for (const [path, status] of [
      ["/_next/image?url=%2Fvinext-image.png&w=65&q=75", 400],
      ["/_next/image?url=%2Fmissing.png&w=64&q=75", 400],
    ] as const) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(status);
      expect(response.headers()["x-nextjs-cache"], path).toBeUndefined();
      expect(response.headers()["x-vinext-cache"], path).toBeUndefined();
    }
  });
});

// Ported from Next.js: test/integration/image-optimizer/test/util.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/integration/image-optimizer/test/util.ts
// Next.js serves formats it does not optimize (`BYPASS_TYPES` in
// packages/next/src/server/image-optimizer.ts) and animated images as-is,
// and SVG only under `images.dangerouslyAllowSVG`, which this example leaves
// unset. Observed with `next start` on next@16.2.7.
test.describe("Cloudflare Workers /_next/image formats it does not optimize", () => {
  const imagePath = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;

  for (const [source, contentType] of [
    ["/vinext-icon.ico", "image/x-icon"],
    ["/vinext-animated.gif", "image/gif"],
    // Workers static assets serve ICNS without an image type; Next.js types
    // a source by its bytes.
    ["/vinext-icon.icns", "image/x-icns"],
  ] as const) {
    test(`serves ${source} as-is instead of transforming it`, async ({ request }) => {
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

  test("rejects an SVG source without dangerouslyAllowSVG", async ({ request }) => {
    const response = await request.get(imagePath("/vinext-logo.svg"), { maxRedirects: 0 });
    expect(response.status()).toBe(400);
    expect(await response.text()).toBe('"url" parameter is valid but image type is not allowed');
    expect(response.headers()["content-type"] ?? "").not.toContain("image/");
    expect(response.headers()["x-nextjs-cache"]).toBeUndefined();
  });
});
