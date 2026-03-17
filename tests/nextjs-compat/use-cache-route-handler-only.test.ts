/**
 * Next.js Compatibility Tests: use-cache-route-handler-only
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-route-handler-only/use-cache-route-handler-only.test.ts
 *
 * Tests that App Router route handlers can use function-level "use cache"
 * without any pages in the app, and that revalidatePath() invalidates the
 * cached route-handler response.
 */

import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer, fetchJson } from "../helpers.js";

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../fixtures/app-use-cache-route-handler-only",
);

describe("Next.js compat: use-cache-route-handler-only", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/node`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache-route-handler-only/use-cache-route-handler-only.test.ts
  it("should cache results in node route handlers", async () => {
    const { data, res } = await fetchJson(baseUrl, "/node");
    expect(res.status).toBe(200);
    expect(data.date1).toBe(data.date2);
  });

  it("should be able to revalidate prerendered route handlers", async () => {
    const { data: initial, res: res1 } = await fetchJson(baseUrl, "/node");
    expect(res1.status).toBe(200);

    const revalidateRes = await fetch(`${baseUrl}/revalidate`, { method: "POST" });
    expect(revalidateRes.status).toBe(204);

    const { data: next, res: res2 } = await fetchJson(baseUrl, "/node");
    expect(res2.status).toBe(200);
    expect(initial.date1).not.toBe(next.date1);
    expect(next.date1).toBe(next.date2);
  });
});
