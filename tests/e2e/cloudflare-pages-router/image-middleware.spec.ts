import { expect, test } from "@playwright/test";

const imagePath = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;

// Next.js answers a local source that yields no image with this 400.
const INVALID_IMAGE = "The requested resource isn't a valid image.";

// Next.js' image optimizer fetches a local source through the router as a GET
// without the caller's headers (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts), so middleware admits the
// source as it would an anonymous direct request. The example has no image optimizer, so an admitted source is passed through.
test.describe("image optimization source behind middleware", () => {
  test("does not serve a source middleware denies", async ({ request }) => {
    // The asset binding answers a direct request for a public file before the
    // Worker runs, so only middleware tells these two sources apart.
    expect((await request.get(imagePath("/vinext-image.png"))).status()).toBe(200);
    for (const cookie of [undefined, "members=1"]) {
      const image = await request.get(
        imagePath("/vinext-image.png?members-only"),
        cookie ? { headers: { cookie } } : undefined,
      );
      expect(image.status(), cookie).toBe(400);
      expect(await image.text(), cookie).toBe(INVALID_IMAGE);
      expect(image.headers()["content-type"] ?? "", cookie).not.toContain("image/");
    }
  });

  // Next.js looks a `_next/static` source up under `.next/static` by its once
  // decoded name, so a segment that decodes to `%2E%2E` names no file there.
  test("does not resolve an encoded dot segment out of _next/static", async ({ request }) => {
    const image = await request.get(
      imagePath("/_next/static/%252E%252E/%252E%252E/vinext-image.png?members-only"),
    );
    expect(image.status()).toBe(400);
    expect(await image.text()).toBe(INVALID_IMAGE);
    expect(image.headers()["content-type"] ?? "").not.toContain("image/");
  });

  test("does not follow a redirect middleware answers the source with", async ({ request }) => {
    const image = await request.get(imagePath("/vinext-image.png?redirect"));
    expect(image.status()).toBe(400);
    expect(await image.text()).toBe(INVALID_IMAGE);
    expect(image.headers()["content-type"] ?? "").not.toContain("image/");
  });

  test("serves an admitted or rewritten source", async ({ request }) => {
    for (const source of ["/vinext-image.png", "/image-source-rewrite.png"]) {
      const image = await request.get(imagePath(source), { headers: { Accept: "image/webp" } });
      expect(image.status(), source).toBe(200);
      expect(image.headers()["content-type"], source).toBe("image/png");
    }
  });
});
