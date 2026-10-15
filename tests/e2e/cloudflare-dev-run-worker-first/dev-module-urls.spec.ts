/**
 * Dev with the `runWorkerFirst: ["/*", "!/_next/static/*"]` pattern that
 * `vinext init` generates. The Cloudflare plugin sends every matching request
 * to the Worker before Vite's middlewares, so vinext has to let Vite serve its
 * module URLs and referenced assets first, while public files, project files,
 * and routes keep reaching the Worker.
 *
 * See https://github.com/cloudflare/vinext/issues/4005.
 */
import { expect, test } from "@playwright/test";

test("loads, styles, and hydrates a page", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });

  await page.goto("/dev-module-urls");
  await expect(page.locator("#js-badge")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("networkidle");

  await expect(page.locator(".dev-module-urls-title")).toHaveCSS("color", "rgb(243, 128, 32)");
  await expect(page.locator("#css-badge")).toHaveCSS("background-image", /badge\.svg/);
  expect(
    await page.locator("#js-badge").evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(16);
  expect(failed).toEqual([]);
});

test("serves assets referenced from CSS and JS", async ({ page, request }) => {
  await page.goto("/dev-module-urls");
  await expect(page.locator("#js-badge")).toHaveAttribute("data-hydrated", "true");
  const src = await page.locator("#js-badge").getAttribute("src");
  expect(src).toBe("/app/dev-module-urls/badge.svg");

  const res = await request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/svg+xml");
});

test("serves Vite's client and answers its HMR ping", async ({ request }) => {
  const client = await request.get("/@vite/client");
  expect(client.status()).toBe(200);
  expect(client.headers()["content-type"]).toContain("javascript");

  const ping = await request.get("/", { headers: { accept: "text/x-vite-ping" } });
  expect(ping.status()).toBe(204);
});

test("keeps running middleware for public files", async ({ request }) => {
  for (const path of ["/members%20only/confidential.txt", "/members%20only/styles.css"]) {
    const res = await request.get(path);
    expect(res.status()).toBe(403);
    expect(await res.text()).toBe("blocked by middleware");
  }

  // Vite's transform middleware treats `.js` and `.css` URLs as modules
  const script = await request.get("/dev-module-urls.js");
  expect(script.status()).toBe(200);
  expect(await script.text()).toContain("devModuleUrlsPublicScript");
});

test("sends other methods for a referenced asset to the Worker", async ({ page, request }) => {
  await page.goto("/dev-module-urls");
  await expect(page.locator("#js-badge")).toHaveAttribute("data-hydrated", "true");

  const res = await request.post("/app/dev-module-urls/badge.svg");
  expect(res.status()).toBe(404);
  expect(await res.text()).not.toContain("<svg");
});

test("keeps sending unreferenced project files and routes to the Worker", async ({ request }) => {
  const projectFile = await request.get("/package.json");
  expect(projectFile.status()).toBe(404);
  expect(await projectFile.text()).not.toContain("vinext-cf-app-basic");

  const route = await request.get("/api/hello");
  expect(route.status()).toBe(200);
});
