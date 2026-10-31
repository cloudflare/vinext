import { expect, test } from "@playwright/test";

const imagePath = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`;

// Verified against Next.js 16.2.7 `next start`: the image endpoint answers 400
// (`"url" parameter is not allowed`) for a local source that no
// `images.localPatterns` entry matches. The fixture lists every path without a
// query string plus `/heart.png?v=listed` (tests/fixtures/app-basic/next.config.ts).
test.describe("image optimization endpoint images.localPatterns", () => {
  test("serves sources a pattern lists", async ({ request }) => {
    const direct = await request.get("/heart.png");
    expect(direct.status()).toBe(200);
    const heartPng = Buffer.from(await direct.body());

    for (const source of ["/heart.png", "/heart.png?v=listed"]) {
      const response = await request.get(imagePath(source));
      expect(response.status(), source).toBe(200);
      expect(response.headers()["content-type"], source).toBe("image/png");
      expect(Buffer.from(await response.body()).equals(heartPng), source).toBe(true);
    }
  });

  test("rejects a source no pattern lists", async ({ request }) => {
    const response = await request.get(imagePath("/heart.png?v=unlisted"));
    expect(response.status()).toBe(400);
    expect(response.headers()["content-type"] ?? "").not.toContain("image/");
  });
});
