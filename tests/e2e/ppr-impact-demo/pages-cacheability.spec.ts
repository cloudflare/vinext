import { expect, test } from "@playwright/test";
import fs from "node:fs";

const probeHeader = "X-Vinext-Cacheability-Probe";
const secretHeader = "X-Vinext-Prerender-Secret";
const buildId = "ppr-impact-demo-cacheability";

function prerenderSecret(): string {
  const manifest = JSON.parse(
    fs.readFileSync("tests/fixtures/ppr-impact-demo/dist/server/vinext-server.json", "utf8"),
  ) as { prerenderSecret: string };
  return manifest.prerenderSecret;
}

test("classifies Pages Router data contracts inside the staged Worker", async ({ request }) => {
  const headers = { [probeHeader]: "1", [secretHeader]: prerenderSecret() };

  // Ported from Next.js: test/e2e/prerender.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
  for (const [pathname, pattern] of [
    ["/cacheability-pages/isr", "/cacheability-pages/isr"],
    ["/cacheability-pages/posts/known", "/cacheability-pages/posts/:slug"],
  ] as const) {
    const response = await request.get(pathname, { headers });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      kind: "pages-page",
      pattern,
      state: "static-candidate",
      status: 200,
      version: 1,
    });
  }

  for (const [pathname, pattern] of [
    [`/_next/data/${buildId}/cacheability-pages/isr.json`, "/cacheability-pages/isr"],
    [
      `/_next/data/${buildId}/cacheability-pages/posts/known.json`,
      "/cacheability-pages/posts/:slug",
    ],
  ] as const) {
    const response = await request.get(pathname, { headers });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      kind: "pages-page",
      pattern,
      state: "static-candidate",
      status: 200,
      version: 1,
    });
  }

  for (const pathname of ["/cacheability-pages/gssp", "/cacheability-pages/get-initial-props"]) {
    const response = await request.get(pathname, { headers });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      kind: "pages-page",
      pattern: pathname,
      state: "dynamic",
      status: 200,
      version: 1,
    });
  }

  for (const pathname of [
    "/cacheability-pages/gssp-public",
    `/_next/data/${buildId}/cacheability-pages/gssp-public.json`,
  ]) {
    const response = await request.get(pathname, { headers });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      cacheControl: "public, s-maxage=36",
      kind: "pages-page",
      pattern: "/cacheability-pages/gssp-public",
      state: "static-candidate",
      status: 200,
      version: 1,
    });
  }

  const gsspDataPath = `/_next/data/${buildId}/cacheability-pages/gssp.json`;
  const gsspData = await request.get(gsspDataPath, { headers });
  expect(gsspData.ok(), gsspDataPath).toBe(true);
  await expect(gsspData.json(), gsspDataPath).resolves.toMatchObject({
    kind: "pages-page",
    pattern: "/cacheability-pages/gssp",
    state: "dynamic",
    status: 200,
    version: 1,
  });

  for (const [pathname, reason] of [
    ["/cacheability-pages/middleware", "middleware is eligible for this pathname"],
    [
      "/cacheability-pages/config-header",
      "next.config headers depend on request headers, cookies, or hostnames",
    ],
    [
      "/cacheability-pages/conditional-redirect",
      "next.config redirect depends on request headers, cookies, or hostnames",
    ],
    [
      "/cacheability-pages/conditional-rewrite",
      "next.config rewrite depends on request headers, cookies, or hostnames",
    ],
  ] as const) {
    const response = await request.get(pathname, {
      headers: { ...headers, Accept: "text/html" },
    });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      kind: "pages-page",
      pattern: pathname,
      reason,
      state: "dynamic",
      status: 200,
      version: 1,
    });
  }
});

test("admits pattern-backed Pages Router responses after each completed render", async ({
  request,
}) => {
  for (const pathname of [
    "/cacheability-pages/isr",
    "/cacheability-pages/isr?unlisted=1",
    "/cacheability-pages/posts/known",
    "/cacheability-pages/posts/unknown",
  ]) {
    const response = await request.get(pathname, { headers: { Accept: "text/html" } });
    expect(response.status(), pathname).toBe(200);
    expect(response.headers()["cdn-cache-control"], pathname).toContain("max-age=60");
  }

  for (const pathname of [
    `/_next/data/${buildId}/cacheability-pages/isr.json`,
    `/_next/data/${buildId}/cacheability-pages/isr.json?unlisted=1`,
    `/_next/data/${buildId}/cacheability-pages/posts/known.json`,
    `/_next/data/${buildId}/cacheability-pages/posts/unknown.json`,
  ]) {
    const response = await request.get(pathname, { headers: { Accept: "application/json" } });
    expect(response.status(), pathname).toBe(200);
    expect(response.headers()["content-type"], pathname).toContain("application/json");
    expect(response.headers()["cdn-cache-control"], pathname).toContain("max-age=60");
  }

  for (const pathname of [
    "/cacheability-pages/gssp-public",
    `/_next/data/${buildId}/cacheability-pages/gssp-public.json`,
  ]) {
    const response = await request.get(pathname, {
      headers: { Accept: pathname.includes("/_next/data/") ? "application/json" : "text/html" },
    });
    expect(response.status(), pathname).toBe(200);
    expect(response.headers()["cdn-cache-control"], pathname).toContain("max-age=36");
  }

  for (const pathname of [
    "/cacheability-pages/gssp",
    "/cacheability-pages/get-initial-props",
    `/_next/data/${buildId}/cacheability-pages/gssp.json`,
  ]) {
    const response = await request.get(pathname, {
      headers: { Accept: pathname.includes("/_next/data/") ? "application/json" : "text/html" },
    });
    expect(response.headers()["cache-control"], pathname).toContain("no-store");
    expect(response.headers()["cdn-cache-control"], pathname).toBeUndefined();
  }
});

test("keeps middleware cookie variants private", async ({ request }) => {
  // Next.js middleware matcher conditions are request-specific, but the route
  // cacheability decision must be stable for the pathname.
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-custom-matchers/test/index.test.ts
  const middlewarePublic = await request.get("/cacheability-pages/middleware", {
    headers: { Accept: "text/html" },
  });
  expect(middlewarePublic.status()).toBe(200);
  expect(middlewarePublic.headers()["x-cacheability-middleware"]).toBeUndefined();
  expect(middlewarePublic.headers()["cache-control"]).toContain("no-store");
  expect(middlewarePublic.headers()["cdn-cache-control"]).toBeUndefined();

  const middlewarePrivate = await request.get("/cacheability-pages/middleware", {
    headers: { Accept: "text/html", Cookie: "variant=private" },
  });
  expect(middlewarePrivate.status()).toBe(200);
  expect(middlewarePrivate.headers()["x-cacheability-middleware"]).toBe("matched");
  expect(middlewarePrivate.headers()["cache-control"]).toContain("no-store");
  expect(middlewarePrivate.headers()["cdn-cache-control"]).toBeUndefined();

  const dataPath = `/_next/data/${buildId}/cacheability-pages/middleware.json`;
  for (const cookie of [undefined, "variant=private"]) {
    const response = await request.get(dataPath, {
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    expect(response.status(), cookie ?? "public").toBe(200);
    expect(response.headers()["cache-control"], cookie ?? "public").toContain("no-store");
    expect(response.headers()["cdn-cache-control"], cookie ?? "public").toBeUndefined();
  }
});

test("keeps config-header cookie variants private", async ({ request }) => {
  const configPublic = await request.get("/cacheability-pages/config-header", {
    headers: { Accept: "text/html" },
  });
  expect(configPublic.status()).toBe(200);
  expect(configPublic.headers()["x-cacheability-config"]).toBeUndefined();
  expect(configPublic.headers()["cache-control"]).toContain("no-store");
  expect(configPublic.headers()["cdn-cache-control"]).toBeUndefined();

  const configPrivate = await request.get("/cacheability-pages/config-header", {
    headers: { Accept: "text/html", Cookie: "variant=private" },
  });
  expect(configPrivate.status()).toBe(200);
  expect(configPrivate.headers()["x-cacheability-config"]).toBe("private");
  expect(configPrivate.headers()["cache-control"]).toContain("no-store");
  expect(configPrivate.headers()["cdn-cache-control"]).toBeUndefined();

  const dataPath = `/_next/data/${buildId}/cacheability-pages/config-header.json`;
  for (const cookie of [undefined, "variant=private"]) {
    const response = await request.get(dataPath, {
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    expect(response.status(), cookie ?? "public").toBe(200);
    expect(response.headers()["cache-control"], cookie ?? "public").toContain("no-store");
    expect(response.headers()["cdn-cache-control"], cookie ?? "public").toBeUndefined();
  }
});

test("keeps invalid preview-cookie cleanup private", async ({ request }) => {
  // Ported from Next.js: test/e2e/prerender-preview/prerender-preview.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender-preview/prerender-preview.test.ts
  for (const pathname of [
    "/cacheability-pages/isr",
    `/_next/data/${buildId}/cacheability-pages/isr.json`,
  ]) {
    const response = await request.get(pathname, {
      headers: {
        Accept: pathname.includes("/_next/data/") ? "application/json" : "text/html",
        Cookie: "__prerender_bypass=invalid; __next_preview_data=invalid",
      },
    });

    expect(response.status(), pathname).toBe(200);
    expect(response.headers()["set-cookie"], pathname).toBeDefined();
    expect(response.headers()["cache-control"], pathname).toContain("no-store");
    expect(response.headers()["cdn-cache-control"], pathname).toBeUndefined();
  }
});
