import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

let externalRewriteServer: Server;

test.beforeAll(async () => {
  externalRewriteServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        pathname: new URL(request.url ?? "/", "http://127.0.0.1:4228").pathname,
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    externalRewriteServer.once("error", reject);
    externalRewriteServer.listen(4228, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    externalRewriteServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test.describe("Route segment configs", () => {
  test("force-static page renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/static-test`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Force Static Page");
    await expect(page.locator('[data-testid="timestamp"]')).not.toBeEmpty();
  });

  test("config-test page renders with all configs recognized", async ({ page }) => {
    const response = await page.goto(`${BASE}/config-test`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Config Test Page");
    await expect(page.locator("p")).toContainText("All route segment configs");
  });

  test("revalidate-test page renders with ISR config", async ({ page }) => {
    const response = await page.goto(`${BASE}/revalidate-test`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("ISR Revalidate Page");
    await expect(page.locator('[data-testid="timestamp"]')).not.toBeEmpty();
  });

  test("external catch-all rewrites preserve their destination path prefix", async ({
    request,
  }) => {
    const normal = await request.get(`${BASE}/external-prefix/resource`);
    expect(normal.status()).toBe(200);
    await expect(normal.json()).resolves.toEqual({ pathname: "/v1/resource" });

    for (const pathname of ["%252e%252e", ".%252e", "%252e."]) {
      const traversal = await request.get(`${BASE}/external-prefix/${pathname}/outside`);
      expect(traversal.status()).toBe(200);
      const traversalResult = (await traversal.json()) as { pathname: string };
      expect(traversalResult.pathname).toMatch(/^\/v1(?:\/|$)/);
    }

    const confusedPrefix = await request.get(`${BASE}/external-prefix../outside`);
    expect(confusedPrefix.status()).toBe(404);
  });
});
