/**
 * Next.js Compatibility Tests: searchparams-static-bailout
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
 *
 * Tests that searchParams are correctly passed to page components:
 * - Server components can await searchParams
 * - Client components can use() searchParams
 * - SearchParams passed from server component to client component work
 * - Pages that don't use searchParams still render correctly
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchDom } from "../helpers.js";

describe("Next.js compat: searchparams-static-bailout", () => {
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

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts

  describe("server component", () => {
    it("should render searchParams in server component page", async () => {
      const { $ } = await fetchDom(baseUrl, "/nextjs-compat/searchparams-server?search=hello");
      expect($("h1").text()).toBe("Parameter: hello");
    });

    it("should render page that doesn't use searchParams", async () => {
      const { $ } = await fetchDom(
        baseUrl,
        "/nextjs-compat/searchparams-server-no-use?search=hello",
      );
      expect($("h1").text()).toBe("No searchParams used");
    });
  });

  describe("client component", () => {
    it("should render searchParams in client component page", async () => {
      const { $ } = await fetchDom(baseUrl, "/nextjs-compat/searchparams-client?search=hello");
      expect($("h1").text()).toBe("Parameter: hello");
    });

    it("should render searchParams passed from server to client component", async () => {
      const { $ } = await fetchDom(
        baseUrl,
        "/nextjs-compat/searchparams-client-passthrough?search=hello",
      );
      expect($("h1").text()).toBe("Parameter: hello");
    });

    it("should render page that doesn't use searchParams", async () => {
      const { $ } = await fetchDom(
        baseUrl,
        "/nextjs-compat/searchparams-client-no-use?search=hello",
      );
      expect($("h1").text()).toBe("No searchParams used");
    });
  });
});
