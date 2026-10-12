import { expect, test } from "@playwright/test";

const BASE_URL = process.env.VINEXT_BASEPATH_E2E_BASE_URL ?? "";

const imagePath = (endpoint: string, source: string) =>
  `${BASE_URL}${endpoint}?url=${encodeURIComponent(source)}&w=640&q=75`;

test("serves the image endpoint behind basePath only for sources middleware admits", async ({
  request,
}) => {
  const direct = await request.get(`${BASE_URL}/docs/heart.png`);
  expect(direct.status()).toBe(200);
  const heartPng = Buffer.from(await direct.body());

  // Next.js serves the endpoint under basePath and expects basePath in `url`.
  // vinext's next/image emits the endpoint without basePath, so that form is
  // admitted as the basePath endpoint with its source resolved under basePath.
  for (const path of [
    imagePath("/docs/_next/image", "/docs/heart.png"),
    imagePath("/_next/image", "/heart.png"),
  ]) {
    const image = await request.get(path);
    expect(image.status(), path).toBe(200);
    expect(Buffer.from(await image.body()).equals(heartPng), path).toBe(true);
  }

  const protectedDirect = await request.get(`${BASE_URL}/docs/members%20only/private.png`);
  expect(protectedDirect.status()).toBe(403);
  const admitted = await request.get(`${BASE_URL}/docs/members%20only/private.png`, {
    headers: { cookie: "members=1" },
  });
  expect(admitted.status()).toBe(200);
  const privatePng = Buffer.from(await admitted.body());

  for (const path of [
    imagePath("/docs/_next/image", "/docs/members only/private.png"),
    imagePath("/_next/image", "/members only/private.png"),
  ]) {
    const image = await request.get(path, { headers: { cookie: "members=1" } });
    expect(image.status(), path).toBe(404);
    expect(Buffer.from(await image.body()).includes(privatePng), path).toBe(false);
  }
});
