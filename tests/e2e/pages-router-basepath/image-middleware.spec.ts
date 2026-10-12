import { expect, test } from "@playwright/test";

const imagePath = (source: string) =>
  `/docs/_next/image/?url=${encodeURIComponent(source)}&w=640&q=75`;

// Next.js serves the endpoint under basePath and expects basePath in `url`.
// The optimizer fetches the source without the caller's cookies, so
// middleware admits it as an anonymous direct request (fetchInternalImage in
// packages/next/src/server/image-optimizer.ts). The trailing slash comes from
// this fixture's trailingSlash config.
test("serves the image endpoint only for sources middleware admits under basePath", async ({
  request,
}) => {
  const direct = await request.get("/docs/open-image.png");
  expect(direct.status()).toBe(200);
  const openPng = Buffer.from(await direct.body());
  const image = await request.get(imagePath("/docs/open-image.png"));
  expect(image.status()).toBe(200);
  expect(Buffer.from(await image.body()).equals(openPng)).toBe(true);

  const protectedDirect = await request.get("/docs/protected/private.png");
  expect(protectedDirect.status()).toBe(403);
  const admitted = await request.get("/docs/protected/private.png", {
    headers: { cookie: "members=1" },
  });
  expect(admitted.status()).toBe(200);
  const privatePng = Buffer.from(await admitted.body());

  for (const cookie of [undefined, "members=1"]) {
    const denied = await request.get(imagePath("/docs/protected/private.png"), {
      headers: cookie ? { cookie } : {},
    });
    expect(denied.status(), cookie).toBe(404);
    expect(Buffer.from(await denied.body()).includes(privatePng), cookie).toBe(false);
  }
});
