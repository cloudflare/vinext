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
});
