import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4175";

const imagePath = (source: string) =>
  `${BASE}/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`;

// Verified against Next.js 16.2.7 `next start`: the optimizer fetches a local
// source through the router without the caller's cookies (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts), so middleware admits it as an
// anonymous direct request. Next.js then rejects the denial's non-image body
// with 400; vinext answers 404, as for a missing source.
test.describe("image optimization source behind middleware", () => {
  test("does not serve a source middleware denies, even with the caller's cookie", async ({
    request,
  }) => {
    const admitted = await request.get(`${BASE}/protected/private.png`, {
      headers: { cookie: "members=1" },
    });
    expect(admitted.status()).toBe(200);
    expect(admitted.headers()["content-type"]).toBe("image/png");
    const privatePng = Buffer.from(await admitted.body());
    const direct = await request.get(`${BASE}/protected/private.png`);
    expect(direct.status()).toBe(403);

    for (const cookie of [undefined, "members=1"]) {
      const image = await request.get(imagePath("/protected/private.png"), {
        headers: cookie ? { cookie } : {},
      });
      expect(image.status(), cookie).toBe(404);
      expect(image.headers()["content-type"] ?? "", cookie).not.toContain("image/");
      expect(Buffer.from(await image.body()).includes(privatePng), cookie).toBe(false);
    }
  });

  test("serves an admitted source", async ({ request }) => {
    const direct = await request.get(`${BASE}/open-image.png`);
    expect(direct.status()).toBe(200);
    const openPng = Buffer.from(await direct.body());

    const image = await request.get(imagePath("/open-image.png"));
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await image.body()).equals(openPng)).toBe(true);
  });

  test("resolves the source through rewrites, without the caller's host", async ({ request }) => {
    const direct = await request.get(`${BASE}/open-image.png`);
    const openPng = Buffer.from(await direct.body());

    // An extensionless source can rewrite to an image.
    const avatar = await request.get(imagePath("/image-avatar"));
    expect(avatar.status()).toBe(200);
    expect(avatar.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await avatar.body()).equals(openPng)).toBe(true);

    // Next.js' internal image request has no Host header, so a host-conditioned
    // rewrite matches only the direct request.
    const hostDirect = await request.get(`${BASE}/image-host-avatar`);
    expect(hostDirect.status()).toBe(200);
    expect(Buffer.from(await hostDirect.body()).equals(openPng)).toBe(true);
    const hostImage = await request.get(imagePath("/image-host-avatar"));
    expect(hostImage.status()).toBe(404);
  });

  test("keeps rejecting missing and non-image sources", async ({ request }) => {
    const missing = await request.get(imagePath("/missing.png"));
    expect(missing.status()).toBe(404);

    // The type comes from the file served, so an image extension in the
    // source's query does not admit a script.
    for (const source of ["/dedupe-script.js", "/dedupe-script.js?.png"]) {
      const script = await request.get(imagePath(source));
      expect(script.status(), source).toBe(400);
      expect(await script.text(), source).toBe(
        "The requested resource is not an allowed image type",
      );
    }
  });
});
