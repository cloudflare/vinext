import { expect, test } from "@playwright/test";

test("dev revalidation replaces a numeric ISR page with notFound immediately", async ({
  request,
}) => {
  await request.get("/api/revalidate-parity?mode=content");
  const initial = await request.get("/revalidate-parity-target");
  expect(initial.status()).toBe(200);

  const revalidated = await request.get("/api/revalidate-parity?mode=notFound");
  expect(revalidated.status()).toBe(200);

  const first404 = await request.get("/revalidate-parity-target");
  expect(first404.status()).toBe(404);
  expect(first404.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(await first404.text()).not.toContain("rendered at:");

  const second404 = await request.get("/revalidate-parity-target");
  expect(second404.status()).toBe(404);
  expect(second404.headers()["x-nextjs-cache"]).toBe("HIT");
});

test("dev cached representations replay only safe response headers", async ({ request }) => {
  const seeded = await request.get("/api/seed-revalidate-cache-headers");
  expect(seeded.status()).toBe(200);

  const cached = await request.get("/revalidate-parity-target");
  expect(cached.status()).toBe(200);
  expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(cached.headers()["content-type"]).toContain("text/html");
  expect(cached.headers()["set-cookie"]).toBeUndefined();
  expect(cached.headers().authorization).toBeUndefined();
  expect(await cached.text()).toContain("seeded cached representation");
});

test("dev coalesces concurrent same-path on-demand revalidations", async ({ request }) => {
  await request.get("/api/revalidate-parity?reset=1");

  const responses = await Promise.all(
    Array.from({ length: 4 }, () => request.get("/api/revalidate-parity?mode=concurrent")),
  );
  for (const response of responses) expect(response.status()).toBe(200);

  const inspected = await request.get("/api/revalidate-parity?inspect=1");
  expect(await inspected.json()).toMatchObject({ generationCount: 1 });
});
