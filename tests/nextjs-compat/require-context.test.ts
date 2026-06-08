/**
 * Next.js Compatibility Tests: require-context
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/require-context
 *
 * Webpack exposes `require.context(dir, recursive, regexp)` to build a module
 * map at compile time. Next.js apps still use it (often written as
 * `(require as any).context(...)` to satisfy TypeScript). vinext rewrites the
 * call at build time into a static map backed by Vite's `import.meta.glob`,
 * exposing the subset of the webpack context interface used in practice:
 * a callable context function with `.keys()`.
 *
 * Fixture page lives in:
 * - fixtures/app-basic/app/nextjs-compat/require-context/
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: require-context", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("should get correct require context keys when using regex filtering", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/require-context");
    const match = html.match(/<pre id="require-context-keys">([^<]*)<\/pre>/);
    expect(match).not.toBeNull();
    // React HTML-escapes the JSON string in SSR output; decode entities before parsing.
    const json = match![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(JSON.parse(json)).toEqual([
      "./parent/file1.js",
      "./parent/file2.js",
      "./parent2/file3.js",
    ]);
  });
});
