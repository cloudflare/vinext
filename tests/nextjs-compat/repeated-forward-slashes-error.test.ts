/**
 * Next.js Compatibility Tests: repeated-forward-slashes-error
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/repeated-forward-slashes-error/repeated-forward-slashes-error.test.ts
 *
 * When a <Link href="..."> contains repeated forward-slashes (e.g.
 * "/hello//world"), Next.js emits an "Invalid href" console.error from
 * `resolveHref`. The upstream e2e renders the page and asserts the message
 * appears in the server CLI output (`next.cliOutput`).
 *
 * vinext's fixture server runs SSR in-process, so the Link shim's
 * `console.error` surfaces in this test process. We spy on it across an
 * actual SSR render (not just an isolated ReactDOMServer.renderToString — see
 * tests/link.test.ts for that) to exercise the full app-router render path.
 *
 * Fixture page: fixtures/app-basic/app/repeated-slashes-link/page.tsx
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: repeated-forward-slashes-error", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up — the first request compiles the RSC/SSR/client entries.
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Next.js: it('should log error when href has repeated forward-slashes', ...)
  it("should log error when a Link href has repeated forward-slashes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { html } = await fetchHtml(baseUrl, "/repeated-slashes-link");
      // Sanity: the page rendered.
      expect(html).toContain("repeated-slashes-link-page");

      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      const invalidHrefWarning = messages.find((m) => m.includes("Invalid href"));
      expect(invalidHrefWarning).toBeDefined();
      expect(invalidHrefWarning).toContain("Invalid href '/hello//world'");
      expect(invalidHrefWarning).toContain(
        "Repeated forward-slashes (//) or backslashes \\ are not valid in the href.",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("Next.js compat: repeated-forward-slashes-error (pages router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(PAGES_FIXTURE_DIR));
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Upstream's repeated-forward-slashes-error fixture is a Pages Router page
  // at the dynamic route `/my/path/[name]`. The full message — including the
  // route pattern `'/my/path/[name]'` — is asserted, matching:
  //   expect(next.cliOutput).toContain(
  //     "Invalid href '/hello//world' passed to next/router in page:
  //      '/my/path/[name]'. Repeated forward-slashes ..."
  //   )
  it("should log the full error (with route pattern) for repeated forward-slashes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { html } = await fetchHtml(baseUrl, "/my/path/name");
      expect(html).toContain("repeated-slashes-link-page");

      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      const invalidHrefWarning = messages.find((m) => m.includes("Invalid href"));
      expect(invalidHrefWarning).toBeDefined();
      // Match the exact upstream message, including the dynamic route pattern.
      expect(invalidHrefWarning).toBe(
        "Invalid href '/hello//world' passed to next/router in page: " +
          "'/my/path/[name]'. Repeated forward-slashes (//) or backslashes \\ " +
          "are not valid in the href.",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
