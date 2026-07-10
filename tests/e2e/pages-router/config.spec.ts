import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

let externalRewriteServer: Server;
const receivedPaths: string[] = [];

test.beforeAll(async () => {
  externalRewriteServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1:4229").pathname;
    receivedPaths.push(pathname);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ pathname }));
  });

  await new Promise<void>((resolve, reject) => {
    externalRewriteServer.once("error", reject);
    externalRewriteServer.listen(4229, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    externalRewriteServer.close((error) => (error ? reject(error) : resolve()));
  });
});

test.describe("next/config (Pages Router)", () => {
  test("getConfig returns publicRuntimeConfig", async ({ page }) => {
    await page.goto(`${BASE}/config-test`);
    await expect(page.locator("h1")).toHaveText("Config Test");
    // The config-test page reads publicRuntimeConfig.appName
    // Falls back to "default-app" if not set
    await expect(page.locator("#app-name")).toContainText("App:");
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

    expect((await request.get(`${BASE}/external-prefix../outside`)).status()).toBe(404);
  });
});
