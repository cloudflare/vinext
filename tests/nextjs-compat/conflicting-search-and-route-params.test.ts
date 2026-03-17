/**
 * Next.js Compatibility Tests: conflicting-search-and-route-params
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/conflicting-search-and-route-params/conflicting-search-and-route-params.test.ts
 *
 * Tests that when a search param and a route param have the same name (e.g. "id"),
 * they are correctly distinguished — route param wins in params, search param is
 * accessible via searchParams.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchDom } from "../helpers.js";

describe("Next.js compat: conflicting-search-and-route-params", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/conflicting-search-and-route-params/conflicting-search-and-route-params.test.ts

  it("should handle conflicting search and route params on page", async () => {
    const { $ } = await fetchDom(baseUrl, "/nextjs-compat/conflicting-params/render/123?id=456");
    expect($("#route-param").text()).toContain("Route param id: 123");
    expect($("#search-param").text()).toContain("Search param id: 456");
  });

  it("should handle conflicting search and route params on API route", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/conflicting-params/api/789?id=abc`);
    const data = await res.json();

    expect(data).toEqual({
      routeParam: "789",
      searchParam: "abc",
    });
  });
});
