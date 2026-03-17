/**
 * Next.js Compatibility Tests: use-params
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/use-params.test.ts
 *
 * Tests the useParams() hook in client components during SSR:
 * - Single dynamic param: /[id]
 * - Nested dynamic params: /[id]/[id2]
 * - Catch-all params: /[...path]
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchDom } from "../helpers.js";

describe("Next.js compat: use-params", () => {
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

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/use-params.test.ts

  it("should work for single dynamic param", async () => {
    const { $ } = await fetchDom(baseUrl, "/nextjs-compat/use-params/a");
    expect($("#param-id").text()).toBe("a");
  });

  it("should work for nested dynamic params", async () => {
    const { $ } = await fetchDom(baseUrl, "/nextjs-compat/use-params/a/b");
    expect($("#param-id").text()).toBe("a");
    expect($("#param-id2").text()).toBe("b");
  });

  it("should work for catch all params", async () => {
    const { $ } = await fetchDom(baseUrl, "/nextjs-compat/use-params/catchall/a/b/c/d/e/f/g");
    expect($("#params").text()).toBe('["a","b","c","d","e","f","g"]');
  });
});
