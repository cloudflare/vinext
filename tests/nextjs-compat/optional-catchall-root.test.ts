/**
 * Next.js Compatibility Tests: root-level optional catch-all
 *
 * Tests that `app/[[...slug]]/page.tsx` at the root correctly handles:
 * - Root path `/` with no slug segments (empty params)
 * - Deep paths like `/a/b` with multiple slug segments
 * - Single segment paths like `/hello`
 *
 * This is a common Next.js pattern for apps that want a single page component
 * to handle all routes. The key edge case is the root `/` where the optional
 * catch-all receives undefined/empty slug.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import {
  APP_OPTIONAL_CATCHALL_ROOT_FIXTURE_DIR,
  startFixtureServer,
  fetchDom,
} from "../helpers.js";

describe("Next.js compat: optional catch-all at root", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_OPTIONAL_CATCHALL_ROOT_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("matches root path / with empty slug", async () => {
    const { $, res } = await fetchDom(baseUrl, "/");
    expect(res.status).toBe(200);
    // At root, slug should be undefined or empty — page renders "__EMPTY__"
    expect($("#slug-value").text()).toBe("__EMPTY__");
  });

  it("matches single segment path", async () => {
    const { $, res } = await fetchDom(baseUrl, "/hello");
    expect(res.status).toBe(200);
    expect($("#slug-value").text()).toBe("hello");
    expect($("#slug-type").text()).toBe("array");
    expect($("#slug-length").text()).toBe("1");
  });

  it("matches deep path with multiple segments", async () => {
    const { $, res } = await fetchDom(baseUrl, "/a/b/c");
    expect(res.status).toBe(200);
    expect($("#slug-value").text()).toBe("a/b/c");
    expect($("#slug-type").text()).toBe("array");
    expect($("#slug-length").text()).toBe("3");
  });
});
