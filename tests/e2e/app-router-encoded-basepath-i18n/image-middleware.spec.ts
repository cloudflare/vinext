import { expect, test } from "@playwright/test";

const BASE_URL = process.env.VINEXT_BASEPATH_E2E_BASE_URL ?? "";

const imagePath = (endpoint: string, source: string) =>
  `${BASE_URL}${endpoint}?url=${encodeURIComponent(source)}&w=640&q=75`;

// Next.js answers a local source that yields no image with this 400.
const INVALID_IMAGE = "The requested resource isn't a valid image.";

test("serves the image endpoint behind basePath only for sources middleware admits", async ({
  request,
}) => {
  const direct = await request.get(`${BASE_URL}/docs/heart.png`);
  expect(direct.status()).toBe(200);
  const heartPng = Buffer.from(await direct.body());

  // Next.js serves the endpoint only under basePath and expects basePath in `url`.
  const image = await request.get(imagePath("/docs/_next/image", "/docs/heart.png"));
  expect(image.status()).toBe(200);
  expect(Buffer.from(await image.body()).equals(heartPng)).toBe(true);
  const unprefixed = await request.get(imagePath("/_next/image", "/docs/heart.png"));
  expect(unprefixed.status()).toBe(404);

  const protectedDirect = await request.get(`${BASE_URL}/docs/members%20only/private.png`);
  expect(protectedDirect.status()).toBe(403);
  const admitted = await request.get(`${BASE_URL}/docs/members%20only/private.png`, {
    headers: { cookie: "members=1" },
  });
  expect(admitted.status()).toBe(200);
  const privatePng = Buffer.from(await admitted.body());

  const protectedImage = await request.get(
    imagePath("/docs/_next/image", "/docs/members only/private.png"),
    { headers: { cookie: "members=1" } },
  );
  expect(protectedImage.status()).toBe(400);
  expect(await protectedImage.text()).toBe(INVALID_IMAGE);
  expect(Buffer.from(await protectedImage.body()).includes(privatePng)).toBe(false);
});
