/**
 * Next.js Compatibility Tests: _allow-underscored-root-directory
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/_allow-underscored-root-directory/_allow-underscored-root-directory.test.ts
 *
 * Tests underscore-prefixed private folders at the app root:
 * - Root-level private folders (e.g. app/_handlers) are not routable
 * - A route can re-export from a private folder
 * - URL-encoded folder names (%5Ffoo) decode to underscore-prefixed URL paths and ARE routable
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_UNDERSCORED_ROOT_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

describe("Next.js compat: _allow-underscored-root-directory", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_UNDERSCORED_ROOT_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/_allow-underscored-root-directory/_allow-underscored-root-directory.test.ts
  it("should not serve app path with underscore", async () => {
    const res = await fetch(`${baseUrl}/_handlers`);
    expect(res.status).toBe(404);
  });

  it("should serve root route that re-exports from a private underscore folder", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("Hello, world!");
  });

  it("should serve app path with %5F", async () => {
    const res = await fetch(`${baseUrl}/_routable-folder`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("Hello, world!");
  });
});
