/**
 * Next.js Compatibility Tests: draft-mode
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/draft-mode
 *
 * Tests draftMode() API from next/headers in App Router route handlers:
 * - draftMode().enable() sets the bypass cookie
 * - draftMode().disable() clears the bypass cookie
 * - draftMode().isEnabled returns false by default
 * - draftMode().isEnabled returns true with bypass cookie
 *
 * Fixture routes live in:
 * - fixtures/app-basic/app/nextjs-compat/api/draft-enable/
 * - fixtures/app-basic/app/nextjs-compat/api/draft-disable/
 * - fixtures/app-basic/app/nextjs-compat/api/draft-status/
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchJson } from "../helpers.js";

describe("Next.js compat: draft-mode", () => {
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

  // ── draftMode().enable() ────────────────────────────────────
  // Next.js: enabling draft mode should set the __prerender_bypass cookie
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/draft-mode

  it("draftMode().enable() sets bypass cookie", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/draft-enable`);
    const setCookies = res.headers.getSetCookie();
    expect(
      setCookies.some((c) => c.includes("__prerender_bypass")),
    ).toBe(true);
  });

  // ── draftMode().disable() ───────────────────────────────────
  // Next.js: disabling draft mode should clear the __prerender_bypass cookie

  it("draftMode().disable() clears bypass cookie", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/draft-disable`);
    const setCookies = res.headers.getSetCookie();
    const bypassCookie = setCookies.find((c) =>
      c.includes("__prerender_bypass"),
    );
    expect(bypassCookie).toBeDefined();
    // Clearing should set Max-Age=0 or an expired date or empty value
    expect(bypassCookie).toMatch(
      /Max-Age=0|expires=Thu, 01 Jan 1970|__prerender_bypass=;|__prerender_bypass=""/i,
    );
  });

  // ── draftMode().isEnabled ───────────────────────────────────
  // Next.js: isEnabled should reflect the presence of the bypass cookie

  it("draftMode().isEnabled returns false by default", async () => {
    const { data } = await fetchJson(
      baseUrl,
      "/nextjs-compat/api/draft-status",
    );
    expect(data).toEqual({ isEnabled: false });
  });

  it("draftMode().isEnabled returns false for arbitrary cookie values", async () => {
    // Arbitrary cookie values should NOT enable draft mode — only the
    // server-generated secret is valid (prevents predictable bypass).
    const { data } = await fetchJson(
      baseUrl,
      "/nextjs-compat/api/draft-status",
      {
        headers: { Cookie: "__prerender_bypass=some-value" },
      },
    );
    expect(data).toEqual({ isEnabled: false });
  });

  it("draftMode().enable() cookie includes Secure flag in production", async () => {
    const {
      draftMode: draftModeFn,
      getDraftModeCookieHeader,
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const ctx = headersContextFromRequest(
        new Request("http://localhost/test"),
      );
      await runWithHeadersContext(ctx, async () => {
        const dm = await draftModeFn();
        dm.enable();
        const cookieHeader = getDraftModeCookieHeader();
        expect(cookieHeader).toBeDefined();
        expect(cookieHeader).toMatch(/;\s*Secure/i);
      });
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  it("draftMode().enable() cookie omits Secure flag in development", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/draft-enable`);
    const setCookies = res.headers.getSetCookie();
    const bypassCookie = setCookies.find((c) =>
      c.includes("__prerender_bypass"),
    );
    expect(bypassCookie).toBeDefined();
    // Dev server runs in development — should NOT have Secure flag
    expect(bypassCookie).not.toMatch(/;\s*Secure/i);
  });

  it("draftMode().isEnabled returns true after enable() round-trip", async () => {
    // Enable draft mode and extract the Set-Cookie value
    const enableRes = await fetch(`${baseUrl}/nextjs-compat/api/draft-enable`);
    const setCookies = enableRes.headers.getSetCookie();
    const bypassCookie = setCookies.find((c) =>
      c.includes("__prerender_bypass"),
    );
    expect(bypassCookie).toBeDefined();
    // Extract raw cookie (name=value portion before first ;)
    const rawCookie = bypassCookie!.split(";")[0];

    // Send the valid cookie back to check isEnabled
    const { data } = await fetchJson(
      baseUrl,
      "/nextjs-compat/api/draft-status",
      {
        headers: { Cookie: rawCookie },
      },
    );
    expect(data).toEqual({ isEnabled: true });
  });
});
