import { expect, test } from "@playwright/test";

const imagePath = (endpoint: string, source: string, extra = "") =>
  `${endpoint}?url=${encodeURIComponent(source)}&w=64&q=75${extra}`;

// Verified against Next.js 16.2.7 `next start`: middleware runs on the image
// endpoint before it reads a source, and the optimizer fetches a local source
// through the router without the caller's cookies (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts), so middleware admits it as an
// anonymous direct request. Next.js then rejects the denial's non-image body
// with 400; vinext answers 404, as for a missing source. wrangler.jsonc
// routes /protected/* to the Worker first, so middleware gates direct requests.
test.describe("Cloudflare Workers image optimization behind middleware", () => {
  for (const endpoint of ["/_next/image", "/_vinext/image"]) {
    test(`${endpoint} returns middleware's denial of the endpoint`, async ({ request }) => {
      const image = await request.get(imagePath(endpoint, "/vinext-image.png", "&deny=1"));
      expect(image.status()).toBe(403);
      expect(await image.text()).toBe("image endpoint blocked by middleware");
    });

    test(`${endpoint} does not serve a source middleware denies`, async ({ request }) => {
      const admitted = await request.get("/protected/private.png", {
        headers: { cookie: "members=1" },
      });
      expect(admitted.status()).toBe(200);
      expect(admitted.headers()["content-type"]).toBe("image/png");
      const direct = await request.get("/protected/private.png");
      expect(direct.status()).toBe(403);

      for (const cookie of [undefined, "members=1"]) {
        const image = await request.get(imagePath(endpoint, "/protected/private.png"), {
          headers: { Accept: "image/webp", ...(cookie ? { cookie } : {}) },
        });
        expect(image.status(), cookie).toBe(404);
        expect(image.headers()["content-type"] ?? "", cookie).not.toContain("image/");
        expect(image.headers()["x-mw-image-endpoint"], cookie).toBe("true");
      }
    });
  }

  test("serves an admitted source with middleware's response headers", async ({ request }) => {
    const image = await request.get(imagePath("/_next/image", "/vinext-image.png"), {
      headers: { Accept: "image/webp" },
    });
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/webp");
    expect(image.headers()["x-mw-image-endpoint"]).toBe("true");

    // HEAD runs in the complete response graph of a multi-stage build.
    const head = await request.head(imagePath("/_next/image", "/vinext-image.png"), {
      headers: { Accept: "image/webp" },
      maxRedirects: 0,
    });
    expect(head.status()).toBe(200);
    expect(head.headers()["content-type"]).toBe("image/webp");
    expect(head.headers()["x-mw-image-endpoint"]).toBe("true");
  });

  test("serves the image query middleware rewrites to", async ({ request }) => {
    const image = await request.get(imagePath("/_next/image", "/image-endpoint-replaced.png"), {
      headers: { Accept: "image/webp" },
    });
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/webp");
  });

  test("keeps rejecting missing sources", async ({ request }) => {
    const missing = await request.get(imagePath("/_next/image", "/missing.png"));
    expect(missing.status()).toBe(404);
    expect(missing.headers()["x-mw-image-endpoint"]).toBe("true");
  });
});
