import { expect, test } from "@playwright/test";

// Verified against Next.js 16.2.7 `next start`: the image endpoint answers 400
// (`"url" parameter is not allowed`) for a local source that no
// `images.localPatterns` entry matches. The example lists every path without a
// query string plus the queries its middleware gates on
// (examples/app-router-cloudflare/next.config.mjs).
test.describe("Cloudflare Workers /_next/image images.localPatterns", () => {
  test("rejects a local source with a query string no pattern lists", async ({ request }) => {
    const listed = await request.get("/_next/image?url=%2Fvinext-image.png&w=64&q=75");
    expect(listed.status()).toBe(200);

    const response = await request.get("/_next/image?url=%2Fvinext-image.png%3Fv%3D2&w=64&q=75");
    expect(response.status()).toBe(400);
    expect(response.headers()["content-type"] ?? "").not.toContain("image/");
  });
});
