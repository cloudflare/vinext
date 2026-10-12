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
      ["/_next/image?url=%2Fmissing.png&w=64&q=75", 404],
    ] as const) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(status);
      expect(response.headers()["x-nextjs-cache"], path).toBeUndefined();
      expect(response.headers()["x-vinext-cache"], path).toBeUndefined();
    }
  });
});
