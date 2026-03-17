/**
 * Next.js Compatibility Tests: layout-params
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/layout-params/layout-params.test.ts
 *
 * Tests that layouts at each nesting level receive the correct params:
 * - Root/static layouts get empty params
 * - Dynamic segment layouts get params up to their level
 * - Deepest layout gets all params
 * - Catchall layouts get the full catchall array
 * - Optional catchall with no segments gets no params
 *
 * The original Next.js test uses a custom root layout with ShowParams.
 * We nest under /nextjs-compat/layout-params/ instead, with an equivalent
 * layout hierarchy that produces the same #id-based DOM structure.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchDom } from "../helpers.js";

describe("Next.js compat: layout-params", () => {
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

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/layout-params/layout-params.test.ts

  describe("basic params", () => {
    it("check layout without params gets no params", async () => {
      const { $ } = await fetchDom(baseUrl, "/nextjs-compat/layout-params/base/something/another");
      // Root and lvl1 layouts should have no param divs (they're above dynamic segments)
      expect($("#root-layout > div").length).toBe(0);
      expect($("#lvl1-layout > div").length).toBe(0);
    });

    it("check layout renders just its params", async () => {
      const { $ } = await fetchDom(baseUrl, "/nextjs-compat/layout-params/base/something/another");
      // lvl2 layout is at [param1] — it should see param1 only
      expect($("#lvl2-layout > div").length).toBe(1);
      expect($("#lvl2-param1").text()).toBe('"something"');
    });

    it("check topmost layout renders all params", async () => {
      const { $ } = await fetchDom(baseUrl, "/nextjs-compat/layout-params/base/something/another");
      // lvl3 layout is at [param1]/[param2] — it should see both
      expect($("#lvl3-layout > div").length).toBe(2);
      expect($("#lvl3-param1").text()).toBe('"something"');
      expect($("#lvl3-param2").text()).toBe('"another"');
    });
  });

  describe("catchall params", () => {
    it("should give catchall params just to last layout", async () => {
      const { $ } = await fetchDom(
        baseUrl,
        "/nextjs-compat/layout-params/catchall/something/another",
      );
      // Root layout should have no params
      expect($("#root-layout > div").length).toBe(0);
      // Catchall layout should see params array
      expect($("#lvl2-layout > div").length).toBe(1);
      expect($("#lvl2-params").text()).toBe('["something","another"]');
    });

    it("should give optional catchall params just to last layout", async () => {
      const { $ } = await fetchDom(
        baseUrl,
        "/nextjs-compat/layout-params/optional-catchall/something/another",
      );
      // Root layout should have no params
      expect($("#root-layout > div").length).toBe(0);
      // Optional catchall layout should see params array
      expect($("#lvl2-layout > div").length).toBe(1);
      expect($("#lvl2-params").text()).toBe('["something","another"]');
    });

    it("empty optional catchall params won't give params to any layout", async () => {
      const { $ } = await fetchDom(baseUrl, "/nextjs-compat/layout-params/optional-catchall");
      // Root layout should have no params
      expect($("#root-layout > div").length).toBe(0);
      // Optional catchall layout with no segments should have no params
      expect($("#lvl2-layout > div").length).toBe(0);
    });
  });
});
