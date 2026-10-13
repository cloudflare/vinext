import { expect, test, type APIRequestContext } from "@playwright/test";

const imagePath = (endpoint: string, source: string) =>
  `${endpoint}?url=${encodeURIComponent(source)}&w=640&q=75`;

// Next.js answers a local source that yields no image with this 400.
const INVALID_IMAGE = "The requested resource isn't a valid image.";

// The protected image's bytes, read through the cookie middleware admits.
async function readPrivatePng(request: APIRequestContext): Promise<Buffer> {
  const response = await request.get("/members%20only/private.png", {
    headers: { cookie: "members=1" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  return Buffer.from(await response.body());
}

// Verified against Next.js 16.2.7 `next start`: middleware runs on the image
// endpoint before it reads a source, and the optimizer fetches a local source
// through the router without the caller's cookies (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts), so middleware admits it as an
// anonymous direct request.
test.describe("image optimization endpoint behind middleware", () => {
  for (const endpoint of ["/_next/image", "/_vinext/image"]) {
    test(`${endpoint} returns middleware's denial of the endpoint`, async ({ request }) => {
      const direct = await request.get("/image-endpoint-guarded.png");
      expect(direct.status()).toBe(200);
      const guardedPng = Buffer.from(await direct.body());

      const image = await request.get(imagePath(endpoint, "/image-endpoint-guarded.png"));
      expect(image.status()).toBe(403);
      const body = Buffer.from(await image.body());
      expect(body.toString()).toBe("image endpoint blocked by middleware");
      expect(body.includes(guardedPng)).toBe(false);
    });

    test(`${endpoint} does not serve a source middleware denies`, async ({ request }) => {
      const privatePng = await readPrivatePng(request);
      const direct = await request.get("/members%20only/private.png");
      expect(direct.status()).toBe(403);

      const image = await request.get(imagePath(endpoint, "/members only/private.png"));
      expect(image.status()).toBe(400);
      expect(await image.text()).toBe(INVALID_IMAGE);
      expect(image.headers()["content-type"] ?? "").not.toContain("image/");
      expect(Buffer.from(await image.body()).includes(privatePng)).toBe(false);
    });
  }

  test("fetches the source without the caller's cookies", async ({ request }) => {
    const privatePng = await readPrivatePng(request);
    const image = await request.get(imagePath("/_next/image", "/members only/private.png"), {
      headers: { cookie: "members=1" },
    });
    expect(image.status()).toBe(400);
    expect(await image.text()).toBe(INVALID_IMAGE);
    expect(Buffer.from(await image.body()).includes(privatePng)).toBe(false);
  });

  test("serves an admitted source with middleware's response headers", async ({ request }) => {
    const direct = await request.get("/heart.png");
    expect(direct.status()).toBe(200);
    const heartPng = Buffer.from(await direct.body());

    const image = await request.get(imagePath("/_next/image", "/heart.png"));
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    expect(image.headers()["content-security-policy"]).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
    expect(image.headers()["x-mw-image-endpoint"]).toBe("true");
    expect(Buffer.from(await image.body()).equals(heartPng)).toBe(true);
  });

  test("serves the image query middleware or config rewrites to", async ({ request }) => {
    const direct = await request.get("/heart.png");
    const heartPng = Buffer.from(await direct.body());

    for (const path of [
      "/middleware-image-rewrite",
      "/config-image-rewrite",
      imagePath("/_next/image", "/image-endpoint-replaced.png"),
    ]) {
      const image = await request.get(path);
      expect(image.status(), path).toBe(200);
      expect(image.headers()["content-type"], path).toBe("image/png");
      expect(Buffer.from(await image.body()).equals(heartPng), path).toBe(true);
    }
  });

  test("keeps rejecting missing and SVG sources", async ({ request }) => {
    // Ported from Next.js: test/integration/image-optimizer/test/util.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/util.ts
    const missing = await request.get(imagePath("/_next/image", "/missing.png"));
    expect(missing.status()).toBe(400);
    expect(await missing.text()).toBe(INVALID_IMAGE);

    // The type comes from the file served, so an image extension in the
    // source's query or hash does not admit an SVG.
    for (const source of ["/logo/logo.svg", "/logo/logo.svg?.png", "/logo/logo.svg#.png"]) {
      const svg = await request.get(imagePath("/_next/image", source));
      expect(svg.status(), source).toBe(400);
      expect(await svg.text(), source).toBe("The requested resource is not an allowed image type");
    }
  });
});
