/**
 * Next.js Compatibility Tests: app-simple-routes
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-simple-routes/app-simple-routes.test.ts
 *
 * Tests route handlers with dot-separated path segments:
 * - /api/node.json → route handler returns { pathname }
 * - /api/edge.json → route handler with runtime='edge'
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

describe("Next.js compat: app-simple-routes", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up with a regular page
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-simple-routes/app-simple-routes.test.ts
  // "renders a node route"
  it("renders a node route with dot in path", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/node.json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      pathname: "/nextjs-compat/api/node.json",
    });
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-simple-routes/app-simple-routes.test.ts
  // "renders a edge route"
  it("renders an edge route with dot in path", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/edge.json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      pathname: "/nextjs-compat/api/edge.json",
    });
  });
});
