import { expect, test } from "@playwright/test";

const DATA_URL = "/_next/data/test-build-id/revalidate-parity-target.json";

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

test("dev cached data keeps the full pageProps envelope", async ({ request }) => {
  await request.get("/api/revalidate-parity?mode=content&revalidate=false");
  const html = await request.get("/revalidate-parity-target");
  expect(html.headers()["x-nextjs-cache"]).toBe("HIT");

  const data = await request.get("/_next/data/test-build-id/revalidate-parity-target.json");
  expect(await data.json()).toMatchObject({
    pageProps: { renderedAt: expect.any(Number) },
  });
});

test("dev stale regeneration awaits promised page props", async ({ request }) => {
  await request.get("/api/revalidate-parity?mode=content&revalidate=1");
  await request.get("/revalidate-parity-target");
  await request.get("/api/revalidate-parity?mode=promised&revalidate=1&setOnly=1");
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const stale = await request.get("/revalidate-parity-target");
  expect(stale.headers()["x-nextjs-cache"]).toBe("STALE");
  await expect
    .poll(async () => {
      const response = await request.get("/revalidate-parity-target");
      const text = await response.text();
      return response.status() === 200 && /rendered at: (?:<!-- -->)?\d+/.test(text);
    })
    .toBe(true);
});

test("dev uses canonical custom CacheHandler redirect and notFound values", async ({ request }) => {
  try {
    await request.get("/api/custom-revalidate-cache?kind=redirect");
    const redirect = await request.get("/revalidate-parity-target", { maxRedirects: 0 });
    expect(redirect.status()).toBe(308);
    expect(redirect.headers().location).toBe("/about");
    expect(redirect.headers().refresh).toBe("0;url=/about");
    const redirectData = await request.get(
      "/_next/data/test-build-id/revalidate-parity-target.json",
    );
    expect(await redirectData.json()).toMatchObject({
      pageProps: {
        __N_REDIRECT: "/about",
        __N_REDIRECT_STATUS: 308,
        __N_REDIRECT_BASE_PATH: false,
      },
    });

    await request.get("/api/custom-revalidate-cache?kind=notFound");
    const alice = await request.get("/revalidate-parity-target", {
      headers: { "x-viewer": "alice" },
    });
    expect(alice.status()).toBe(404);
    expect(await alice.text()).toContain("alice");
    const bob = await request.get("/revalidate-parity-target", {
      headers: { "x-viewer": "bob" },
    });
    const bobHtml = await bob.text();
    expect(bobHtml).toContain("bob");
    expect(bobHtml).not.toContain("alice");
    const notFoundData = await request.get(
      "/_next/data/test-build-id/revalidate-parity-target.json",
    );
    expect(notFoundData.status()).toBe(404);
    expect(await notFoundData.json()).toEqual({ notFound: true });
  } finally {
    await request.get("/api/custom-revalidate-cache?kind=restore");
  }
});

test("dev reads legacy cached redirect and notFound representations", async ({ request }) => {
  try {
    await request.get("/api/custom-revalidate-cache?kind=legacyRedirect");
    const redirect = await request.get("/revalidate-parity-target", { maxRedirects: 0 });
    expect(redirect.status()).toBe(307);
    expect(redirect.headers().location).toBe("/about");

    await request.get("/api/custom-revalidate-cache?kind=legacyNotFound");
    const notFound = await request.get("/revalidate-parity-target");
    expect(notFound.status()).toBe(404);
    expect(await notFound.text()).toContain("404 - Page Not Found");
  } finally {
    await request.get("/api/custom-revalidate-cache?kind=restore");
  }
});

test("dev validates permanent and conflicting redirect metadata", async ({ request }) => {
  await request.get("/api/revalidate-parity?mode=permanentRedirect&revalidate=false");
  const permanent = await request.get("/revalidate-parity-target", { maxRedirects: 0 });
  expect(permanent.status()).toBe(308);
  expect(permanent.headers().refresh).toBe("0;url=/about");

  await request.get("/api/revalidate-parity?mode=content&revalidate=false");
  const previous = await (await request.get("/revalidate-parity-target")).text();
  for (const mode of ["conflictingRedirect", "invalidStatusRedirect"]) {
    await request.get(`/api/revalidate-parity?mode=${mode}&setOnly=1`);
    const failed = await request.get(
      `/api/revalidate-reason?path=${encodeURIComponent("/revalidate-parity-target")}`,
    );
    expect(await failed.json()).toEqual({ revalidated: false });
    expect(await (await request.get("/revalidate-parity-target")).text()).toBe(previous);
  }
});

test("dev renders HTML after redirect data regeneration produces a data-only entry", async ({
  request,
}) => {
  await request.get("/api/revalidate-parity?mode=redirect&revalidate=1");
  const redirectData = await request.get(DATA_URL);
  expect(await redirectData.json()).toMatchObject({
    pageProps: { __N_REDIRECT: "/about", __N_REDIRECT_STATUS: 307 },
  });

  await request.get("/api/revalidate-parity?mode=content&revalidate=1&setOnly=1");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const staleRedirectData = await request.get(DATA_URL);
  expect(staleRedirectData.headers()["x-nextjs-cache"]).toBe("STALE");
  expect(await staleRedirectData.json()).toMatchObject({
    pageProps: { __N_REDIRECT: "/about", __N_REDIRECT_STATUS: 307 },
  });

  await expect
    .poll(async () => {
      const response = await request.get(DATA_URL);
      const body = await response.json();
      return {
        cache: response.headers()["x-nextjs-cache"],
        hasContent: typeof body.pageProps?.renderedAt === "number",
      };
    })
    .toEqual({ cache: "HIT", hasContent: true });

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const html = await request.get("/revalidate-parity-target");
  expect(html.status()).toBe(200);
  expect(await html.text()).toMatch(/rendered at: (?:<!-- -->)?\d+/);

  const dataHit = await request.get(DATA_URL);
  expect(dataHit.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(await dataHit.json()).toMatchObject({ pageProps: { renderedAt: expect.any(Number) } });
});

test("dev cached and stale data representations carry the deployment ID", async ({ request }) => {
  const deploymentId = "pages-dev-deployment";
  await request.get(`/api/deployment-id?value=${deploymentId}`);

  try {
    for (const mode of ["content", "redirect", "notFound"] as const) {
      await request.get(`/api/revalidate-parity?mode=${mode}&revalidate=1`);
      const hit = await request.get(DATA_URL);
      expect(hit.headers()["x-nextjs-cache"]).toBe("HIT");
      expect(hit.headers()["x-nextjs-deployment-id"]).toBe(deploymentId);

      if (mode === "content") {
        const html = await request.get("/revalidate-parity-target");
        expect(html.headers()["x-nextjs-deployment-id"]).toBeUndefined();
      }

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const stale = await request.get(DATA_URL);
      expect(stale.headers()["x-nextjs-cache"]).toBe("STALE");
      expect(stale.headers()["x-nextjs-deployment-id"]).toBe(deploymentId);

      await expect
        .poll(async () => (await request.get(DATA_URL)).headers()["x-nextjs-cache"])
        .toBe("HIT");
    }
  } finally {
    await request.get("/api/deployment-id");
  }
});
