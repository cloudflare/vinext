import { expect, test, type APIRequestContext } from "@playwright/test";

const TARGET = "/revalidate-parity-target";
const DATA_URL = "/_next/data/test-build-id/revalidate-parity-target.json";

async function resetAndSetMode(
  request: APIRequestContext,
  mode: "content" | "notFound" | "redirect" | "concurrent",
  revalidate = "false",
) {
  await request.get("/api/revalidate-parity?reset=1");
  await request.get(`/api/revalidate-parity?mode=${mode}&revalidate=${revalidate}&setOnly=1`);
}

async function generationCount(request: APIRequestContext) {
  const inspected = await request.get("/api/revalidate-parity?inspect=1");
  return (await inspected.json()).generationCount as number;
}

// Next.js source: packages/next/src/server/lib/incremental-cache/index.ts
// and test/e2e/revalidate-reason/revalidate-reason.test.ts. Pages route
// responses bypass the incremental cache in development so GSP always runs.
test("dev reruns getStaticProps for every HTML and data request", async ({ request }) => {
  await resetAndSetMode(request, "content");

  const first = await request.get(TARGET);
  expect(first.status()).toBe(200);
  expect(first.headers()["cache-control"]).toBe("no-cache, must-revalidate");
  expect(first.headers()["x-vinext-cache"]).toBeUndefined();

  const second = await request.get(TARGET);
  expect(second.status()).toBe(200);
  expect(second.headers()["cache-control"]).toBe("no-cache, must-revalidate");

  const data = await request.get(DATA_URL);
  expect(data.status()).toBe(200);
  expect(await data.json()).toMatchObject({ pageProps: { renderedAt: expect.any(Number) } });
  expect(await generationCount(request)).toBe(3);
});

test("dev on-demand revalidation renders once and stores no route response", async ({
  request,
}) => {
  await request.get("/api/revalidate-parity?reset=1");

  const revalidated = await request.get("/api/revalidate-parity?mode=content&revalidate=false");
  expect(revalidated.status()).toBe(200);
  expect(await revalidated.json()).toMatchObject({ revalidated: true });
  expect(await generationCount(request)).toBe(1);

  const ordinary = await request.get(TARGET);
  expect(ordinary.status()).toBe(200);
  expect(ordinary.headers()["cache-control"]).toBe("no-cache, must-revalidate");
  expect(await generationCount(request)).toBe(2);
});

test("dev recomputes terminal notFound and redirect results", async ({ request }) => {
  await request.get("/api/revalidate-parity?reset=1");
  const notFoundRevalidated = await request.get(
    "/api/revalidate-parity?mode=notFound&revalidate=false",
  );
  expect(notFoundRevalidated.status()).toBe(200);
  for (let index = 0; index < 2; index++) {
    const notFound = await request.get(TARGET);
    expect(notFound.status()).toBe(404);
    expect(notFound.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(notFound.headers()["x-vinext-cache"]).toBeUndefined();
    expect(notFound.headers()["cache-control"]).toBe("no-cache, must-revalidate");
  }
  const notFoundData = await request.get(DATA_URL);
  expect(notFoundData.status()).toBe(404);
  expect(notFoundData.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(notFoundData.headers()["x-vinext-cache"]).toBeUndefined();
  expect(notFoundData.headers()["cache-control"]).toBe("s-maxage=31536000");
  expect(await notFoundData.json()).toEqual({ notFound: true });
  expect(await generationCount(request)).toBe(4);

  await request.get("/api/revalidate-parity?reset=1");
  const redirectRevalidated = await request.get(
    "/api/revalidate-parity?mode=redirect&revalidate=false",
  );
  expect(redirectRevalidated.status()).toBe(200);
  for (let index = 0; index < 2; index++) {
    const redirect = await request.get(TARGET, { maxRedirects: 0 });
    expect(redirect.status()).toBe(307);
    expect(redirect.headers().location).toBe("/about");
    expect(redirect.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(redirect.headers()["x-vinext-cache"]).toBeUndefined();
    expect(redirect.headers()["cache-control"]).toBe("s-maxage=31536000");
  }
  const redirectData = await request.get(DATA_URL);
  expect(redirectData.status()).toBe(200);
  expect(redirectData.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(redirectData.headers()["x-vinext-cache"]).toBeUndefined();
  expect(redirectData.headers()["cache-control"]).toBe("s-maxage=31536000");
  expect(await redirectData.json()).toMatchObject({
    pageProps: { __N_REDIRECT: "/about", __N_REDIRECT_STATUS: 307 },
  });
  expect(await generationCount(request)).toBe(4);
});

test("dev does not coalesce concurrent same-path on-demand revalidations", async ({ request }) => {
  await resetAndSetMode(request, "concurrent");

  const responses = await Promise.all(
    Array.from({ length: 4 }, () => request.get("/api/revalidate-parity?mode=concurrent")),
  );
  for (const response of responses) expect(response.status()).toBe(200);
  expect(await generationCount(request)).toBe(4);
});

test("dev ignores custom Pages CacheHandler response values", async ({ request }) => {
  try {
    await resetAndSetMode(request, "content");
    await request.get("/api/custom-revalidate-cache?kind=redirect");

    const response = await request.get(TARGET, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers().location).toBeUndefined();
    expect(await response.text()).toMatch(/rendered at: (?:<!-- -->)?\d+/);
    expect(await generationCount(request)).toBe(1);
  } finally {
    await request.get("/api/custom-revalidate-cache?kind=restore");
  }
});
