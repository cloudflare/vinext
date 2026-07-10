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
  expect(await first404.text()).toContain("404 - Page Not Found");

  const second404 = await request.get("/revalidate-parity-target");
  expect(second404.status()).toBe(404);
  expect(second404.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(await second404.text()).toContain("404 - Page Not Found");
});

// Next.js source: packages/next/src/server/render.tsx and
// packages/next/src/server/route-modules/pages/pages-handler.ts.
test("dev revalidation stores the current content and notFound lifetime", async ({ request }) => {
  await request.get("/api/revalidate-parity?mode=content&revalidate=2");
  const numericContent = await request.get("/revalidate-parity-target");
  expect(numericContent.headers()["cache-control"]).toContain("s-maxage=2");

  await request.get("/api/revalidate-parity?mode=content&revalidate=false");
  const nonExpiringContent = await request.get("/revalidate-parity-target");
  expect(nonExpiringContent.headers()["cache-control"]).toContain("s-maxage=31536000");

  await request.get("/api/revalidate-parity?mode=redirect&revalidate=2");
  const numericRedirect = await request.get("/revalidate-parity-target", { maxRedirects: 0 });
  expect(numericRedirect.status()).toBe(307);
  expect(numericRedirect.headers()["cache-control"]).toContain("s-maxage=2");

  await request.get("/api/revalidate-parity?mode=redirect&revalidate=false");
  const nonExpiringRedirect = await request.get("/revalidate-parity-target", {
    maxRedirects: 0,
  });
  expect(nonExpiringRedirect.status()).toBe(307);
  expect(nonExpiringRedirect.headers()["cache-control"]).toContain("s-maxage=31536000");

  await request.get("/api/revalidate-parity?mode=notFound&revalidate=2");
  const numericNotFound = await request.get("/revalidate-parity-target");
  expect(numericNotFound.status()).toBe(404);
  expect(numericNotFound.headers()["cache-control"]).toContain("s-maxage=2");
  expect(await numericNotFound.text()).toContain("404 - Page Not Found");

  await request.get("/api/revalidate-parity?mode=notFound&revalidate=false");
  for (let index = 0; index < 2; index++) {
    const nonExpiringNotFound = await request.get("/revalidate-parity-target");
    expect(nonExpiringNotFound.status()).toBe(404);
    expect(nonExpiringNotFound.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(nonExpiringNotFound.headers()["cache-control"]).toContain("s-maxage=31536000");
    expect(await nonExpiringNotFound.text()).toContain("404 - Page Not Found");
  }
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
