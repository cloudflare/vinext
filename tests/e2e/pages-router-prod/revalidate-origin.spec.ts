import { createServer, request as sendHttpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

const APP_PORT = 4175;

function requestWithHost(
  host: string,
  path = "/api/revalidate-reason",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: APP_PORT,
        path,
        headers: { host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("on-demand revalidation uses the bound production server origin", async () => {
  let capturedRevalidateHeader: string | undefined;
  const outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    capturedRevalidateHeader = Array.isArray(header) ? header[0] : header;
    response.writeHead(418);
    response.end();
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));

  try {
    const outsidePort = (outsideServer.address() as AddressInfo).port;
    const result = await requestWithHost(`127.0.0.1:${outsidePort}`);

    expect(capturedRevalidateHeader).toBeUndefined();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      outsideServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("on-demand revalidation keeps path inputs on the production server origin", async () => {
  let capturedRevalidateHeader: string | undefined;
  const outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    capturedRevalidateHeader = Array.isArray(header) ? header[0] : header;
    response.writeHead(418);
    response.end();
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));

  try {
    const outsidePort = (outsideServer.address() as AddressInfo).port;
    const revalidatePath = `//127.0.0.1:${outsidePort}/outside`;
    const result = await requestWithHost(
      `localhost:${APP_PORT}`,
      `/api/revalidate-reason?path=${encodeURIComponent(revalidatePath)}`,
    );

    expect(capturedRevalidateHeader).toBeUndefined();
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ revalidated: false });
  } finally {
    await new Promise<void>((resolve, reject) =>
      outsideServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("authenticated on-demand revalidation bypasses Pages middleware", async () => {
  const result = await requestWithHost(
    `localhost:${APP_PORT}`,
    `/api/revalidate-reason?path=${encodeURIComponent("/revalidate-middleware-sentinel")}`,
  );

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ revalidated: true });
});

// Ported from Next.js: test/e2e/prerender.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
test("only-generated revalidation does not generate an unseen blocking fallback path", async ({
  request,
}) => {
  const slug = `unseen-${Date.now()}`;
  const pathname = `/revalidate-only-generated/${slug}`;
  const result = await requestWithHost(
    `localhost:${APP_PORT}`,
    `/api/revalidate-reason?path=${encodeURIComponent(pathname)}&onlyGenerated=1`,
  );

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ revalidated: true });

  const firstPageResponse = await request.get(`http://localhost:${APP_PORT}${pathname}`);
  expect(firstPageResponse.status()).toBe(200);
  expect(firstPageResponse.headers()["x-nextjs-cache"]).toBe("MISS");
  const firstPageHtml = await firstPageResponse.text();
  expect(firstPageHtml).toContain("Generated");
  expect(firstPageHtml).toContain(slug);

  const cachedPageResponse = await request.get(`http://localhost:${APP_PORT}${pathname}`);
  expect(cachedPageResponse.headers()["x-nextjs-cache"]).toBe("HIT");
});

test("rejects a nested revalidation from an authenticated loopback", async () => {
  const result = await requestWithHost(
    `localhost:${APP_PORT}`,
    `/api/revalidate-reason?path=${encodeURIComponent("/api/nested-revalidate")}`,
  );

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ revalidated: false });
});

test("does not reject a forged revalidation-header presence as an internal loopback", async () => {
  const result = await new Promise<{ body: string; status: number }>((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: APP_PORT,
        path: "/api/nested-revalidate",
        headers: {
          host: `localhost:${APP_PORT}`,
          "x-prerender-revalidate": "forged",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ nestedRejected: false });
});

test("bounds a self-targeting revalidation loop", async () => {
  const startedAt = Date.now();
  const result = await requestWithHost(`localhost:${APP_PORT}`, "/api/nested-revalidate?self=1");

  expect(result.status).toBe(200);
  expect(JSON.parse(result.body)).toEqual({ nestedRejected: true });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

// Ported from Next.js: test/e2e/prerender.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
test("on-demand revalidation synchronously replaces non-expiring content, notFound, and redirects", async ({
  request,
}) => {
  const target = `http://localhost:${APP_PORT}/revalidate-parity-target`;
  const initial = await request.get(target);
  expect(initial.status()).toBe(200);
  const initialBody = await initial.text();

  const contentRevalidate = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-parity?mode=content`,
  );
  expect(contentRevalidate.status()).toBe(200);
  const immediate = await request.get(target);
  expect(immediate.status()).toBe(200);
  expect(immediate.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(await immediate.text()).not.toBe(initialBody);

  const notFoundRevalidate = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-parity?mode=notFound`,
  );
  expect(notFoundRevalidate.status()).toBe(200);
  const notFound = await request.get(target);
  expect(notFound.status()).toBe(404);
  expect(notFound.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(await notFound.text()).toContain("404 - Page Not Found");

  const redirectRevalidate = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-parity?mode=redirect`,
  );
  expect(redirectRevalidate.status()).toBe(200);
  const redirect = await request.get(target, { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(redirect.headers()["x-nextjs-cache"]).toBe("HIT");
  expect(redirect.headers().location).toBe("/about");
});

test("production renders HTML after redirect data regeneration produces a data-only entry", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  const target = `${origin}/revalidate-parity-target`;
  const dataUrl = `${origin}/_next/data/test-build-id/revalidate-parity-target.json`;

  await request.get(`${origin}/api/revalidate-parity?mode=redirect&revalidate=1`);
  const redirectData = await request.get(dataUrl);
  expect(await redirectData.json()).toMatchObject({
    pageProps: { __N_REDIRECT: "/about", __N_REDIRECT_STATUS: 307 },
  });

  await request.get(`${origin}/api/revalidate-parity?mode=content&revalidate=1&setOnly=1`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const staleRedirectData = await request.get(dataUrl);
  expect(staleRedirectData.headers()["x-nextjs-cache"]).toBe("STALE");
  expect(await staleRedirectData.json()).toMatchObject({
    pageProps: { __N_REDIRECT: "/about", __N_REDIRECT_STATUS: 307 },
  });

  await expect
    .poll(async () => {
      const response = await request.get(dataUrl);
      const body = await response.json();
      return {
        cache: response.headers()["x-nextjs-cache"],
        hasContent: typeof body.pageProps?.renderedAt === "number",
      };
    })
    .toEqual({ cache: "HIT", hasContent: true });

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const html = await request.get(target);
  expect(html.status()).toBe(200);
  expect(await html.text()).toMatch(/rendered at: (?:<!-- -->)?\d+/);
});

test("production cached and stale data representations carry the deployment ID", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  const dataUrl = `${origin}/_next/data/test-build-id/revalidate-parity-target.json`;
  const deploymentId = "pages-production-deployment";

  for (const mode of ["content", "redirect", "notFound"] as const) {
    await request.get(`${origin}/api/revalidate-parity?mode=${mode}&revalidate=1`);
    const hit = await request.get(dataUrl);
    expect(hit.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(hit.headers()["x-nextjs-deployment-id"]).toBe(deploymentId);

    if (mode === "content") {
      const html = await request.get(`${origin}/revalidate-parity-target`);
      expect(html.headers()["x-nextjs-deployment-id"]).toBeUndefined();
    }

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const stale = await request.get(dataUrl);
    expect(stale.headers()["x-nextjs-cache"]).toBe("STALE");
    expect(stale.headers()["x-nextjs-deployment-id"]).toBe(deploymentId);

    await expect
      .poll(async () => (await request.get(dataUrl)).headers()["x-nextjs-cache"])
      .toBe("HIT");
  }
});

// Next.js source: packages/next/src/server/render.tsx and
// packages/next/src/server/route-modules/pages/pages-handler.ts.
test("production revalidation stores the current content and notFound lifetime", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;

  await request.get(`${origin}/api/revalidate-parity?mode=content&revalidate=2`);
  const numericContent = await request.get(`${origin}/revalidate-parity-target`);
  expect(numericContent.headers()["cache-control"]).toContain("s-maxage=2");
  expect(numericContent.headers()["cache-control"]).toContain("stale-while-revalidate=31535998");

  await request.get(`${origin}/api/revalidate-parity?mode=content&revalidate=false`);
  const nonExpiringContent = await request.get(`${origin}/revalidate-parity-target`);
  expect(nonExpiringContent.headers()["cache-control"]).toBe(
    "s-maxage=31536000, stale-while-revalidate",
  );

  await request.get(`${origin}/api/revalidate-parity?mode=redirect&revalidate=2`);
  const numericRedirect = await request.get(`${origin}/revalidate-parity-target`, {
    maxRedirects: 0,
  });
  expect(numericRedirect.status()).toBe(307);
  expect(numericRedirect.headers()["cache-control"]).toContain("s-maxage=2");

  await request.get(`${origin}/api/revalidate-parity?mode=redirect&revalidate=false`);
  const nonExpiringRedirect = await request.get(`${origin}/revalidate-parity-target`, {
    maxRedirects: 0,
  });
  expect(nonExpiringRedirect.status()).toBe(307);
  expect(nonExpiringRedirect.headers()["cache-control"]).toContain("s-maxage=31536000");

  await request.get(`${origin}/api/revalidate-parity?mode=notFound&revalidate=2`);
  const numericNotFound = await request.get(`${origin}/revalidate-parity-target`);
  expect(numericNotFound.status()).toBe(404);
  expect(numericNotFound.headers()["cache-control"]).toContain("s-maxage=2");
  expect(await numericNotFound.text()).toContain("404 - Page Not Found");

  await request.get(`${origin}/api/revalidate-parity?mode=notFound&revalidate=false`);
  for (let index = 0; index < 2; index++) {
    const nonExpiringNotFound = await request.get(`${origin}/revalidate-parity-target`);
    expect(nonExpiringNotFound.status()).toBe(404);
    expect(nonExpiringNotFound.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(nonExpiringNotFound.headers()["cache-control"]).toContain("s-maxage=31536000");
    expect(await nonExpiringNotFound.text()).toContain("404 - Page Not Found");
  }
});

test("production revalidation forwards configured headers without forwarding cookies by default", async ({
  request,
}) => {
  const response = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-parity?headers=1`,
    {
      headers: {
        cookie: "private-session=secret",
        "x-revalidate-token": "allowed-token",
      },
    },
  );
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    revalidated: true,
    capturedCookie: null,
    capturedToken: "allowed-token",
  });
});

// Next.js 16.2.7 source references:
// packages/next/src/server/api-utils/node/api-resolver.ts
// packages/next/src/server/response-cache/index.ts
test("distinguishes regenerated redirects from config redirects", async ({ request }) => {
  const external = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-parity?mode=externalRedirect`,
  );
  expect(external.status()).toBe(200);

  const cachedRedirect = await request.get(
    `http://localhost:${APP_PORT}/revalidate-parity-target`,
    { maxRedirects: 0 },
  );
  expect(cachedRedirect.status()).toBe(307);
  expect(cachedRedirect.headers().location).toBe("https://example.com/revalidated");
  expect(cachedRedirect.headers()["x-nextjs-cache"]).toBe("HIT");

  const configRedirect = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-reason?path=${encodeURIComponent("/old-about")}`,
  );
  expect(configRedirect.status()).toBe(200);
  expect(await configRedirect.json()).toEqual({ revalidated: false });
});

test("coalesces concurrent same-path on-demand revalidations", async () => {
  await requestWithHost(`localhost:${APP_PORT}`, "/api/revalidate-parity?reset=1");

  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      requestWithHost(`localhost:${APP_PORT}`, "/api/revalidate-parity?mode=concurrent"),
    ),
  );
  for (const response of responses) expect(response.status).toBe(200);

  const inspected = await requestWithHost(
    `localhost:${APP_PORT}`,
    "/api/revalidate-parity?inspect=1",
  );
  expect(JSON.parse(inspected.body)).toMatchObject({ generationCount: 1 });
});

test("clears failed on-demand batches so the next revalidation can succeed", async ({
  request,
}) => {
  await request.get(`http://localhost:${APP_PORT}/api/revalidate-parity?mode=error&setOnly=1`);
  const failed = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-reason?path=${encodeURIComponent("/revalidate-parity-target")}`,
  );
  expect(await failed.json()).toEqual({ revalidated: false });

  await request.get(`http://localhost:${APP_PORT}/api/revalidate-parity?mode=content&setOnly=1`);
  const recovered = await request.get(
    `http://localhost:${APP_PORT}/api/revalidate-reason?path=${encodeURIComponent("/revalidate-parity-target")}`,
  );
  expect(await recovered.json()).toEqual({ revalidated: true });
});

// Ported from the Pages response-cache representation contract in Next.js:
// packages/next/src/server/route-modules/pages/pages-handler.ts
test("natural stale regeneration persists content, redirect, and notFound transitions", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  const target = `${origin}/revalidate-parity-target`;

  await request.get(`${origin}/api/revalidate-parity?mode=content&revalidate=1`);
  const initial = await request.get(target);
  expect(initial.status()).toBe(200);

  await request.get(`${origin}/api/revalidate-parity?mode=redirect&revalidate=1&setOnly=1`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const staleContent = await request.get(target, { maxRedirects: 0 });
  expect(staleContent.status()).toBe(200);
  expect(staleContent.headers()["x-nextjs-cache"]).toBe("STALE");
  await expect
    .poll(async () => (await request.get(target, { maxRedirects: 0 })).status())
    .toBe(307);

  await request.get(`${origin}/api/revalidate-parity?mode=notFound&revalidate=1&setOnly=1`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const staleRedirect = await request.get(target, { maxRedirects: 0 });
  expect(staleRedirect.status()).toBe(307);
  expect(staleRedirect.headers()["x-nextjs-cache"]).toBe("STALE");
  await expect.poll(async () => (await request.get(target)).status()).toBe(404);

  await request.get(`${origin}/api/revalidate-parity?mode=promised&revalidate=1&setOnly=1`);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const staleNotFound = await request.get(target);
  expect(staleNotFound.status()).toBe(404);
  expect(staleNotFound.headers()["x-nextjs-cache"]).toBe("STALE");
  await expect
    .poll(async () => {
      const response = await request.get(target);
      return (
        response.status() === 200 && /rendered at: (?:<!-- -->)?\d+/.test(await response.text())
      );
    })
    .toBe(true);
});

test("cached notFound renders the custom 404 per request and stays consistent with data requests", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  await request.get(`${origin}/api/revalidate-parity?mode=notFound&revalidate=false`);

  const alice = await request.get(`${origin}/revalidate-parity-target`, {
    headers: { "x-viewer": "alice-secret" },
  });
  expect(alice.status()).toBe(404);
  expect(await alice.text()).toContain("alice-secret");

  const bob = await request.get(`${origin}/revalidate-parity-target`, {
    headers: { "x-viewer": "bob" },
  });
  const bobHtml = await bob.text();
  expect(bob.status()).toBe(404);
  expect(bobHtml).toContain("bob");
  expect(bobHtml).not.toContain("alice-secret");

  const data = await request.get(
    `${origin}/_next/data/test-build-id/revalidate-parity-target.json`,
    { headers: { "x-viewer": "carol" } },
  );
  expect(data.status()).toBe(404);
  expect(await data.json()).toEqual({ notFound: true });
});

test("cached redirect uses the same canonical representation for HTML and data requests", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  await request.get(`${origin}/api/revalidate-parity?mode=redirect&revalidate=false`);

  const html = await request.get(`${origin}/revalidate-parity-target`, { maxRedirects: 0 });
  expect(html.status()).toBe(307);
  expect(html.headers().location).toBe("/about");
  expect(html.headers()["x-nextjs-cache"]).toBe("HIT");

  const data = await request.get(
    `${origin}/_next/data/test-build-id/revalidate-parity-target.json`,
  );
  expect(data.status()).toBe(200);
  expect(await data.json()).toMatchObject({
    pageProps: { __N_REDIRECT: "/about", __N_REDIRECT_STATUS: 307 },
  });
});

test("cached content keeps the full data envelope during client navigation", async ({
  page,
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  await request.get(`${origin}/api/revalidate-parity?mode=content&revalidate=false`);
  const warmed = await request.get(`${origin}/revalidate-parity-target`);
  expect(warmed.headers()["x-nextjs-cache"]).toBe("HIT");

  const directData = await request.get(
    `${origin}/_next/data/test-build-id/revalidate-parity-target.json`,
  );
  expect(await directData.json()).toMatchObject({
    pageProps: { renderedAt: expect.any(Number) },
  });

  await page.goto(`${origin}/about`);
  const dataResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/_next/data/test-build-id/revalidate-parity-target.json"),
  );
  await page.evaluate(() => (window as any).next.router.push("/revalidate-parity-target"));
  const dataResponse = await dataResponsePromise;
  expect(await dataResponse.json()).toMatchObject({
    pageProps: { renderedAt: expect.any(Number) },
  });
  await expect(page.locator("#rendered-at")).toContainText("rendered at:");
  await expect(page).toHaveURL(`${origin}/revalidate-parity-target`);
});

test("preserves permanent and basePath redirect metadata in cached HTML and data", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  const target = `${origin}/revalidate-parity-target`;

  await request.get(`${origin}/api/revalidate-parity?mode=permanentRedirect&revalidate=false`);
  const permanent = await request.get(target, { maxRedirects: 0 });
  expect(permanent.status()).toBe(308);
  expect(permanent.headers().location).toBe("/about");
  expect(permanent.headers().refresh).toBe("0;url=/about");
  expect(await permanent.text()).toBe("/about");

  await request.get(`${origin}/api/revalidate-parity?mode=basePathFalseRedirect&revalidate=false`);
  const data = await request.get(
    `${origin}/_next/data/test-build-id/revalidate-parity-target.json`,
  );
  expect(await data.json()).toMatchObject({
    pageProps: {
      __N_REDIRECT: "/about",
      __N_REDIRECT_STATUS: 307,
      __N_REDIRECT_BASE_PATH: false,
    },
  });
});

test("rejects invalid redirect metadata without replacing cached content", async ({ request }) => {
  const origin = `http://localhost:${APP_PORT}`;
  const target = `${origin}/revalidate-parity-target`;
  await request.get(`${origin}/api/revalidate-parity?mode=content&revalidate=false`);
  const previous = await (await request.get(target)).text();

  for (const mode of ["conflictingRedirect", "invalidStatusRedirect"]) {
    await request.get(`${origin}/api/revalidate-parity?mode=${mode}&setOnly=1`);
    const regeneration = await request.get(
      `${origin}/api/revalidate-reason?path=${encodeURIComponent("/revalidate-parity-target")}`,
    );
    expect(await regeneration.json()).toEqual({ revalidated: false });
    const retained = await request.get(target);
    expect(retained.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(await retained.text()).toBe(previous);
  }
});

test("rejects invalid revalidate values without replacing the previous representation", async ({
  request,
}) => {
  const origin = `http://localhost:${APP_PORT}`;
  const target = `${origin}/revalidate-parity-target`;
  await request.get(`${origin}/api/revalidate-parity?mode=content&revalidate=false`);
  const previous = await (await request.get(target)).text();

  for (const invalid of ["zero", "fractional", "infinity", "string"]) {
    await request.get(`${origin}/api/revalidate-parity?mode=content&invalid=${invalid}&setOnly=1`);
    const regeneration = await request.get(
      `${origin}/api/revalidate-reason?path=${encodeURIComponent("/revalidate-parity-target")}`,
    );
    expect(await regeneration.json()).toEqual({ revalidated: false });
    const retained = await request.get(target);
    expect(retained.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(await retained.text()).toBe(previous);
  }
});
