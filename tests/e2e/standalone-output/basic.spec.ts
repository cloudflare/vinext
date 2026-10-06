import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Standalone output E2E tests.
 *
 * These tests run against `vite build` output with `output: "standalone"`,
 * started via `node dist/standalone/server.js`. The production server runs
 * on port 4182 via the webServer config in playwright.config.ts.
 */
const BASE = "http://localhost:4182";

test.describe("Standalone Output", () => {
  test("packages prerendered HTML and manifests from the real fixture", async ({ request }) => {
    // Adapted from Next.js: test/e2e/app-dir/app/standalone-gsp.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/standalone-gsp.test.ts
    // A successful HTTP response alone also passes when standalone skips prerendering.
    // Verify the actual build artifacts, including evaluated getStaticProps output.
    const output = path.resolve("tests/fixtures/standalone-output/dist");
    for (const [file, content] of [
      ["index.html", "Hello, standalone!"],
      ["about.html", "Static props from the standalone fixture."],
    ]) {
      const artifact = `server/prerendered-routes/${file}`;
      const html = await readFile(path.join(output, "standalone/dist", artifact), "utf8");
      expect(html).toContain(content);
      expect(html).toBe(await readFile(path.join(output, artifact), "utf8"));
    }

    for (const file of ["vinext-prerender.json", "vinext-prerender-paths.json"]) {
      const manifest = await readFile(path.join(output, "standalone/dist/server", file), "utf8");
      expect(manifest).toBe(await readFile(path.join(output, "server", file), "utf8"));
      expect(JSON.parse(manifest)).toMatchObject(
        file === "vinext-prerender.json"
          ? {
              routes: expect.arrayContaining([
                expect.objectContaining({ route: "/about", status: "rendered" }),
              ]),
            }
          : { pagesPaths: expect.arrayContaining(["/", "/about"]) },
      );
    }

    // Playwright starts the packaged server outside the repo, with only its own dependencies.
    const response = await request.get(`${BASE}/about`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Static props from the standalone fixture.");
  });

  test("index page renders with correct content", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");
    await expect(page.locator("body")).toContainText("output: standalone mode");
  });

  test("about page renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/about`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About Standalone");
  });

  test("navigation via Link works", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");

    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About Standalone");
    expect(page.url()).toBe(`${BASE}/about`);

    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");
    expect(page.url()).toBe(`${BASE}/`);
  });

  test("browser back button works", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About Standalone");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");
  });

  test("API route returns JSON", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const data = await response.json();
    expect(data).toEqual({ message: "Hello from standalone API!" });
  });

  test("externalized Shiki runs from isolated standalone output", async ({ request }) => {
    // Ported from Next.js: test/e2e/twoslash/standalone.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/twoslash/standalone.test.ts
    const response = await request.get(`${BASE}/api/highlight`);
    expect(response.status()).toBe(200);
    const data = (await response.json()) as { html: string };
    expect(data.html).toContain('class="shiki github-dark-default"');
    expect(data.html).toContain("const");
    expect(data.html).toContain("answer");
  });

  test("404 page for non-existent route", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent`);
    expect(response?.status()).toBe(404);
  });

  test("prod server responds with HTTP 200", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
  });
});
