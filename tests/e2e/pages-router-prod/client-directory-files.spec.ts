import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4175";

// Like `next start` and the Workers adapter, the Node server serves only
// public files and build output from dist/client, not the build metadata
// written next to them.
test.describe("client directory files", () => {
  test("does not serve build metadata from the client directory", async ({ request }) => {
    const response = await request.get(`${BASE}/vinext-client-entry-manifest.json`);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain("pagesClientEntry");
  });

  test("serves a public file under /api ahead of API routing", async ({ request }) => {
    const response = await request.get(`${BASE}/api/public-file.json`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ publicApiFile: true });
  });

  test("serves client build files outside _next/static before middleware", async ({ request }) => {
    const response = await request.get(`${BASE}/pages-client-build-file.js`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("javascript");
    expect(response.headers()["x-custom-middleware"]).toBeUndefined();
    expect(await response.text()).toBe("export const remote = true;\n");
  });
});
