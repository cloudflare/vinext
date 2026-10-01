import { test, expect } from "@playwright/test";

// A stale tab decides whether its build is still deployed with a HEAD request
// for the entry chunk (`script#_R_`). The Workers static-assets layer must
// answer HEAD like GET: 200 with a JavaScript content-type for a chunk that
// exists, 404 for one that does not.
test.describe("Cloudflare Workers static asset HEAD", () => {
  test.describe.configure({ mode: "serial" });

  let entryPath: string;

  test.beforeAll(async ({ request }) => {
    // Health check: a server failure must stop the run instead of reading as a result.
    const health = await request.get("/");
    expect(health.status(), "the wrangler dev server did not answer the health check").toBe(200);
  });

  test("the page exposes its entry chunk", async ({ page }) => {
    await page.goto("/");
    const source = await page.locator("body script#_R_[src]").getAttribute("src");
    expect(source).toBeTruthy();
    entryPath = new URL(source!, page.url()).pathname;
    expect(entryPath).toMatch(/^\/_next\/static\/.+\.js$/);
  });

  test("HEAD of the entry chunk answers 200 with a JavaScript content-type", async ({
    request,
  }) => {
    const response = await request.head(entryPath);

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/javascript/);
  });

  test("HEAD of a chunk that is not in the build answers 404 beside the entry chunk", async ({
    request,
  }) => {
    const missingBeside = entryPath.replace(/[^/]+$/, "chunk-that-was-never-built-A1b2C3d4.js");
    expect(missingBeside).not.toBe(entryPath);

    const response = await request.head(missingBeside);

    expect(response.status()).toBe(404);
  });
});
