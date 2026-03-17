/**
 * Next.js Compatibility Tests: app-routes-trailing-slash
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes-trailing-slash/app-routes-trailing-slash.test.ts
 *
 * Tests that route handlers respect trailingSlash=true:
 * - requesting /runtime/<rt> redirects to /runtime/<rt>/
 * - requesting the canonical slash form returns 200 and both url.pathname
 *   and req.nextUrl.pathname include the trailing slash
 */

import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer, fetchJson } from "../helpers.js";

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../fixtures/app-routes-trailing-slash-compat",
);

describe("Next.js compat: app-routes-trailing-slash", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/runtime/node`, { redirect: "manual" }).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes-trailing-slash/app-routes-trailing-slash.test.ts
  it.each(["edge", "node"])("should handle trailing slash for %s runtime", async (runtime) => {
    let res = await fetch(`${baseUrl}/runtime/${runtime}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toContain(`/runtime/${runtime}/`);

    const json = await fetchJson(baseUrl, `/runtime/${runtime}/`);
    expect(json.res.status).toBe(200);
    expect(json.data).toEqual({
      url: `/runtime/${runtime}/`,
      nextUrl: `/runtime/${runtime}/`,
    });
  });
});
