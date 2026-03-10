/**
 * Next.js Compatibility Tests: rsc-basic
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
 *
 * Tests React Server Component behavior at the HTTP/SSR level:
 * - Server components render correctly in SSR HTML
 * - Props are passed from server components to client components
 * - Client component initial state is present in SSR
 * - Page returning null renders without error
 * - Async server components render after await
 * - RSC flight response has correct content-type
 * - Missing routes return 404
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/rsc-server/    (server + client child)
 * - fixtures/app-basic/app/nextjs-compat/rsc-null/       (returns null)
 * - fixtures/app-basic/app/nextjs-compat/rsc-async/      (async server component)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: rsc-basic", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetchHtml(baseUrl, "/nextjs-compat/rsc-server");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Server component rendering ──────────────────────────────

  // Next.js: 'should render server components correctly'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("server component renders correctly in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/rsc-server");
    expect(html).toContain("Server Component");
    expect(html).toContain("from server");
  });

  // Next.js: 'should pass props from server to client components'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("server component passes props to client component", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/rsc-server");
    expect(html).toContain("hello from server");
  });

  // Next.js: 'should render initial state of client component in SSR'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("client component SSR includes initial state", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/rsc-server");
    expect(html).toContain(">0<");
  });

  // Next.js: 'should render page returning null without error'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("page returning null renders without error", async () => {
    const { res } = await fetchHtml(baseUrl, "/nextjs-compat/rsc-null");
    expect(res.status).toBe(200);
  });

  // Next.js: 'should render async server component after await'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("async server component renders after await", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/rsc-async");
    expect(html).toContain("Async Server Component");
  });

  // ── RSC response ────────────────────────────────────────────

  // Next.js: 'should return RSC response with correct content-type'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("RSC response has correct content-type", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/rsc-server`, {
      headers: {
        RSC: "1",
        Accept: "text/x-component",
      },
    });
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/x-component");
  });

  // Next.js: 'should return RSC response with rendered content'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("RSC response contains rendered content", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/rsc-server`, {
      headers: {
        RSC: "1",
        Accept: "text/x-component",
      },
    });
    const body = await res.text();
    const hasContent = body.includes("Server Component") || body.includes("from server");
    expect(hasContent).toBe(true);
  });

  // ── 404 handling ────────────────────────────────────────────

  // Next.js: 'should return 404 for missing routes'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
  it("missing route returns 404", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/definitely-does-not-exist`);
    expect(res.status).toBe(404);
  });
});
