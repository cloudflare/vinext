import { expect, test } from "@playwright/test";

const imagePath = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;

const endpointImagePath = (endpoint: string, source: string, extra = "") =>
  `${endpoint}?url=${encodeURIComponent(source)}&w=64&q=75${extra}`;

// Next.js answers a local source that yields no image with this 400.
const INVALID_IMAGE = "The requested resource isn't a valid image.";

// Next.js' image optimizer fetches a local source through the router as a GET
// without the caller's headers (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts), so middleware admits the
// source as it would an anonymous direct request. The example transforms images through the Cloudflare Images binding.
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
      expect(image.headers()["content-type"], source).toBe("image/webp");
    }
  });
});

// Verified against Next.js 16.2.7 `next start`: middleware runs on the image
// endpoint before it reads a source. wrangler.jsonc routes /protected/* to the
// Worker first, so middleware gates direct requests for those files.
test.describe("Cloudflare Workers image endpoint behind middleware", () => {
  for (const endpoint of ["/_next/image", "/_vinext/image"]) {
    test(`${endpoint} returns middleware's denial of the endpoint`, async ({ request }) => {
      const image = await request.get(endpointImagePath(endpoint, "/vinext-image.png", "&deny=1"));
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
        const image = await request.get(endpointImagePath(endpoint, "/protected/private.png"), {
          headers: { Accept: "image/webp", ...(cookie ? { cookie } : {}) },
        });
        expect(image.status(), cookie).toBe(400);
        expect(await image.text(), cookie).toBe(INVALID_IMAGE);
        expect(image.headers()["content-type"] ?? "", cookie).not.toContain("image/");
        expect(image.headers()["x-mw-image-endpoint"], cookie).toBe("true");
      }
    });
  }

  // Next.js looks a `_next/static` source up under `.next/static` by its once
  // decoded name, literally, so a segment that decodes to `%2E%2E` or a decoded
  // `..` segment names no file there.
  test("does not resolve an encoded dot segment out of _next/static", async ({ request }) => {
    for (const source of [
      "/_next/static/%252E%252E/%252E%252E/protected/private.png",
      "/_next/static/%252e%252E/.%252E/protected/private.png",
      "/_next/static/%252E./%252e%252e/protected/private.png",
      "/_next/static/a%2F..%2F..%2Fprotected%2Fprivate.png",
    ]) {
      const image = await request.get(endpointImagePath("/_next/image", source), {
        headers: { Accept: "image/webp" },
      });
      expect(image.status(), source).toBe(400);
      expect(await image.text(), source).toBe(INVALID_IMAGE);
      expect(image.headers()["content-type"] ?? "", source).not.toContain("image/");
    }
  });

  test("serves an admitted source with middleware's response headers", async ({ request }) => {
    const image = await request.get(endpointImagePath("/_next/image", "/vinext-image.png"), {
      headers: { Accept: "image/webp" },
    });
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/webp");
    expect(image.headers()["x-mw-image-endpoint"]).toBe("true");

    // HEAD runs in the complete response graph of a multi-stage build.
    const head = await request.head(endpointImagePath("/_next/image", "/vinext-image.png"), {
      headers: { Accept: "image/webp" },
      maxRedirects: 0,
    });
    expect(head.status()).toBe(200);
    expect(head.headers()["content-type"]).toBe("image/webp");
    expect(head.headers()["x-mw-image-endpoint"]).toBe("true");
  });

  test("serves the image query middleware rewrites to", async ({ request }) => {
    const image = await request.get(
      endpointImagePath("/_next/image", "/image-endpoint-replaced.png"),
      { headers: { Accept: "image/webp" } },
    );
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/webp");
  });

  test("keeps rejecting missing sources", async ({ request }) => {
    const missing = await request.get(endpointImagePath("/_next/image", "/missing.png"));
    expect(missing.status()).toBe(400);
    expect(missing.headers()["x-mw-image-endpoint"]).toBe("true");
  });
});
