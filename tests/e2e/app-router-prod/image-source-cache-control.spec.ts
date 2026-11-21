import { expect, test } from "@playwright/test";

// Verified against Next.js 16.2.7 `next start`: an image served as-is is cached
// for the larger of `images.minimumCacheTTL` (14400) and the max-age a direct
// request for the source gets, including one from a `headers()` rule (getMaxAge
// in packages/next/src/server/image-optimizer.ts). This server has no
// optimizer, so it serves every source as-is.
test.describe("/_next/image source Cache-Control", () => {
  for (const [source, cacheControl] of [
    ["/heart.png", "public, max-age=14400, must-revalidate"],
    ["/image-source-cache-policy.png", "public, max-age=86400, must-revalidate"],
  ] as const) {
    test(`caches ${source} like Next.js`, async ({ request }) => {
      const original = Buffer.from(await (await request.get(source)).body());
      const response = await request.get(
        `/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`,
      );
      expect(response.status()).toBe(200);
      expect(Buffer.from(await response.body()).equals(original)).toBe(true);
      expect(response.headers()["cache-control"]).toBe(cacheControl);
    });
  }
});
