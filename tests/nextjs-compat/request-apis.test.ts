/**
 * Next.js Compatibility Tests: request-apis
 *
 * Ported from Next.js adapter-level behavior:
 * - packages/next/src/server/web/spec-extension/adapters/headers.test.ts
 * - packages/next/src/server/web/spec-extension/adapters/request-cookies.test.ts
 *
 * Covers real App Router request behavior for:
 * - legacy sync access to headers() / cookies()
 * - readonly headers() in both pages and route handlers
 * - iterator-based headers() access in route handlers
 * - readonly cookies() in Server Component render paths
 * - mutable cookies() in route handlers, including sync access
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

describe("Next.js compat: request-apis", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("supports sync headers() and cookies() reads in a Server Component", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/request-api-sync`, {
      headers: {
        "x-sync-header": "header-from-request",
        Cookie: "session=cookie-from-request",
      },
    });
    const html = await res.text();

    expect(html).toContain("header-from-request");
    expect(html).toContain("cookie-from-request");
  });

  it("keeps headers() and cookies() read-only in Server Component render paths", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/request-api-readonly`, {
      headers: {
        "x-test-page": "original-header",
        Cookie: "session=original-cookie",
      },
    });
    const html = await res.text();

    expect(html).toContain("Headers cannot be modified");
    expect(html).toContain("Cookies can only be modified in a Server Action or Route Handler");
    expect(html).toContain("original-header");
    expect(html).toContain("original-cookie");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('preserves the dynamic = "error" failure for sync request API access', async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/request-api-dynamic-error`);
    const html = await res.text();

    expect(html).toMatch(
      /Page with `dynamic = (?:&quot;|\\")error(?:&quot;|\\")` used a dynamic API/,
    );
    expect(html).not.toContain("Headers cannot be modified");
    expect(html).not.toContain("Cookies can only be modified in a Server Action or Route Handler");
  });

  it("allows sync cookies() mutation in route handlers", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/request-api-sync`, {
      headers: { "x-sync-header": "route-header" },
    });
    const data = await res.json();

    expect(data).toEqual({
      syncHeader: "route-header",
      syncCookie: "set-via-sync",
    });
    expect(res.headers.getSetCookie()).toEqual([
      expect.stringContaining("sync-session=set-via-sync"),
    ]);
  });

  it("keeps headers() read-only in route handlers", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/headers-readonly`, {
      headers: { "x-test-header": "original-route-header" },
    });
    const data = await res.json();

    expect(data).toEqual({
      error: expect.stringContaining("Headers cannot be modified"),
      value: "original-route-header",
    });
  });

  it("supports iterator-based headers() access in route handlers", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/headers-iterate`, {
      headers: {
        "x-iterate-a": "alpha",
        "x-iterate-b": "beta",
      },
    });
    const data = await res.json();

    expect(data).toEqual({
      syncEntries: [
        ["x-iterate-a", "alpha"],
        ["x-iterate-b", "beta"],
      ],
      awaitedEntries: [
        ["x-iterate-a", "alpha"],
        ["x-iterate-b", "beta"],
      ],
      keys: ["x-iterate-a", "x-iterate-b"],
      values: expect.arrayContaining(["alpha", "beta"]),
      object: {
        "x-iterate-a": "alpha",
        "x-iterate-b": "beta",
      },
    });
  });

  it("supports mixed sync and awaited request API access in the same route handler", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/request-api-repeat`, {
      headers: { "x-repeat": "original-repeat-header" },
    });
    const data = await res.json();

    expect(data).toEqual({
      firstHeader: "original-repeat-header",
      secondHeader: "original-repeat-header",
      headerError: expect.stringContaining("Headers cannot be modified"),
      repeatCookie: "repeat-value",
    });
    expect(res.headers.getSetCookie()).toEqual([
      expect.stringContaining("repeat-cookie=repeat-value"),
    ]);
  });
});
