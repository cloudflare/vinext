// Ported from Next.js: test/e2e/basepath/trailing-slash.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/trailing-slash.test.ts

import { test, expect } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4190";

function getRawPath(path: string): Promise<{ body: string; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4190 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          body,
          location: Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location,
          status: res.statusCode ?? 0,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test.describe("basePath + trailingSlash", () => {
  test("preserves raw spelling while adding a trailing slash", async () => {
    const redirect = await getRawPath("/docs/%68ello");
    expect(redirect.status).toBe(308);
    expect(redirect.location).toBe("/docs/%68ello/");

    const alias = await getRawPath("/docs/%68ello/");
    expect(alias.status).toBe(404);
    expect(alias.body).not.toContain("Hello");
  });

  test("canonicalizes dot segments before basePath and trailing-slash handling", async () => {
    const redirect = await getRawPath("/docs/x/%2e%2e/hello");
    expect(redirect.status).toBe(308);
    expect(redirect.location).toBe("/docs/hello/");

    const page = await getRawPath("/docs/%2e/hello/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("hello page");

    const outside = await getRawPath("/docs/%2e%2e/hello/");
    expect(outside.status).toBe(404);
  });

  test("replaces state when same asPath but different url", async ({ page }) => {
    await page.goto(`${BASE}/docs/`);
    await expect(page.locator("#index-page")).toBeVisible({ timeout: 5_000 });
    await waitForHydration(page);

    // Index -> Hello via #hello-link
    await page.locator("#hello-link").click();
    await expect(page.locator("#something-else-link")).toBeVisible({ timeout: 5_000 });

    // Hello -> (navigate to something-else, displayed as /hello) via #something-else-link
    await page.locator("#something-else-link").click();
    await expect(page.locator("#something-else-page")).toBeVisible({ timeout: 5_000 });

    // Go back -> should show index
    await page.goBack();
    await expect(page.locator("#index-page")).toBeVisible({ timeout: 5_000 });

    // Go forward -> should show something-else-page
    await page.goForward();
    await expect(page.locator("#something-else-page")).toBeVisible({ timeout: 5_000 });
  });

  // Ported from Next.js: test/e2e/gssp-redirect-base-path/gssp-redirect-base-path.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/gssp-redirect-base-path/gssp-redirect-base-path.test.ts
  test("applies basePath and permanent redirect headers to cached gSP redirects", async ({
    request,
  }) => {
    const target = `${BASE}/docs/basepath-redirect/cached/`;
    const first = await request.get(target, { maxRedirects: 0 });
    expect(first.status()).toBe(308);
    expect(first.headers().location).toBe("/docs/hello");
    expect(first.headers().refresh).toBe("0;url=/docs/hello");
    expect(await first.text()).toBe("/docs/hello");

    const cached = await request.get(target, { maxRedirects: 0 });
    expect(cached.status()).toBe(308);
    expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(cached.headers().location).toBe("/docs/hello");
    expect(cached.headers().refresh).toBe("0;url=/docs/hello");

    const withoutBasePath = await request.get(`${BASE}/docs/basepath-redirect/no-base/`, {
      maxRedirects: 0,
    });
    expect(withoutBasePath.status()).toBe(308);
    expect(withoutBasePath.headers().location).toBe("/hello");
    expect(withoutBasePath.headers().refresh).toBe("0;url=/hello");
  });

  test("normalizes local redirect paths after basePath without changing data or external URLs", async ({
    request,
  }) => {
    const local = await request.get(`${BASE}/docs/basepath-redirect/slashes/`, {
      maxRedirects: 0,
    });
    expect(local.status()).toBe(308);
    expect(local.headers().location).toBe("/docs/hello/world/deep?keep=//query\\value");
    expect(local.headers().refresh).toBe("0;url=/docs/hello/world/deep?keep=//query\\value");

    const homeHtml = await (await request.get(`${BASE}/docs/`)).text();
    const buildId = homeHtml.match(/"buildId":"([^"]+)"/)?.[1];
    expect(buildId).toBeDefined();
    const data = await request.get(
      `${BASE}/docs/_next/data/${buildId}/basepath-redirect/slashes.json`,
    );
    expect(await data.json()).toMatchObject({
      pageProps: {
        __N_REDIRECT: "/hello//world\\deep?keep=//query\\value",
        __N_REDIRECT_STATUS: 308,
      },
    });

    const external = await request.get(`${BASE}/docs/basepath-redirect/external/`, {
      maxRedirects: 0,
    });
    expect(external.headers().location).toBe("https://example.com/a//b\\c?keep=//query\\value");
  });
});
