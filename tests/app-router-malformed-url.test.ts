import { type ViteDevServer } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

describe("App Router dev server malformed URL handling", () => {
  let devServer: ViteDevServer;
  let devBaseUrl: string;

  beforeAll(async () => {
    ({ server: devServer, baseUrl: devBaseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
  }, 30000);

  afterAll(async () => {
    await devServer?.close();
  });

  it("returns 400 for malformed percent-encoded path", async () => {
    const res = await fetch(`${devBaseUrl}/%E0%A4%A`);
    expect(res.status).toBe(400);
  });

  it("returns 400 for truncated percent sequence", async () => {
    const res = await fetch(`${devBaseUrl}/%E0%A4`);
    expect(res.status).toBe(400);
  });

  it("still serves valid pages", async () => {
    const res = await fetch(`${devBaseUrl}/about`);
    expect(res.status).toBe(200);
  });
});
