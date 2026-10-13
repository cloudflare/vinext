import { expect, test, type APIRequestContext } from "@playwright/test";

const BASE = "http://localhost:4175";

const imageQuery = (source: string) => `/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`;
const imagePath = (source: string) => `${BASE}${imageQuery(source)}`;

// Next.js answers a local source that yields no image with this 400.
const INVALID_IMAGE = "The requested resource isn't a valid image.";

async function readPng(request: APIRequestContext, path: string, cookie?: string): Promise<Buffer> {
  const response = await request.get(
    `${BASE}${path}`,
    cookie ? { headers: { cookie } } : undefined,
  );
  expect(response.status(), path).toBe(200);
  expect(response.headers()["content-type"], path).toBe("image/png");
  return Buffer.from(await response.body());
}

// Next.js' image optimizer fetches a local source through the router as a GET
// without the caller's headers (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts), so middleware admits the
// source as it would an anonymous direct request.
test.describe("image optimization source behind middleware", () => {
  test("does not serve a source middleware denies", async ({ request }) => {
    const privatePng = await readPng(request, "/members%20only/private.png", "members=1");
    const direct = await request.get(`${BASE}/members%20only/private.png`);
    expect(direct.status()).toBe(403);

    for (const cookie of [undefined, "members=1"]) {
      const image = await request.get(
        imagePath("/members only/private.png"),
        cookie ? { headers: { cookie } } : undefined,
      );
      expect(image.status(), cookie).toBe(400);
      expect(await image.text(), cookie).toBe(INVALID_IMAGE);
      expect(image.headers()["content-type"] ?? "", cookie).not.toContain("image/");
      expect(Buffer.from(await image.body()).includes(privatePng), cookie).toBe(false);
    }
  });

  test("does not follow a redirect middleware answers the source with", async ({ request }) => {
    const image = await request.get(imagePath("/image-source-redirect.png"));
    expect(image.status()).toBe(400);
    expect(await image.text()).toBe(INVALID_IMAGE);
    expect(image.headers()["content-type"] ?? "").not.toContain("image/");
  });

  test("serves an admitted or rewritten source", async ({ request }) => {
    const heartPng = await readPng(request, "/heart.png");
    for (const source of ["/heart.png", "/image-source-rewrite.png"]) {
      const image = await request.get(imagePath(source));
      expect(image.status(), source).toBe(200);
      expect(image.headers()["content-type"], source).toBe("image/png");
      expect(image.headers()["content-security-policy"], source).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
      expect(Buffer.from(await image.body()).equals(heartPng), source).toBe(true);
    }
  });

  test("keeps rejecting missing, recursive, and SVG sources", async ({ request }) => {
    // Ported from Next.js: test/integration/image-optimizer/test/util.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/image-optimizer/test/util.ts
    const missing = await request.get(imagePath("/missing.png"));
    expect(missing.status()).toBe(400);
    expect(await missing.text()).toBe(INVALID_IMAGE);
    // Next.js rejects a source that is itself the image endpoint.
    expect((await request.get(imagePath(imageQuery("/heart.png")))).status()).toBe(400);

    for (const source of ["/logo.svg", "/logo.svg?.png"]) {
      const svg = await request.get(imagePath(source));
      expect(svg.status(), source).toBe(400);
      expect(await svg.text(), source).toBe("The requested resource is not an allowed image type");
    }
  });
});
