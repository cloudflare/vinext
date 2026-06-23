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

import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchJson, fetchHtml } from "../helpers.js";

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
    expect(setCookies.some((c) => c.includes("__prerender_bypass"))).toBe(true);
  });

  // ── draftMode().disable() ───────────────────────────────────
  // Next.js: disabling draft mode should clear the __prerender_bypass cookie

  it("draftMode().disable() clears bypass cookie", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/draft-disable`);
    const setCookies = res.headers.getSetCookie();
    const bypassCookie = setCookies.find((c) => c.includes("__prerender_bypass"));
    expect(bypassCookie).toBeDefined();
    // Clearing should set Max-Age=0 or an expired date or empty value
    expect(bypassCookie).toMatch(
      /Max-Age=0|expires=Thu, 01 Jan 1970|__prerender_bypass=;|__prerender_bypass=""/i,
    );
  });

  // ── draftMode().isEnabled ───────────────────────────────────
  // Next.js: isEnabled should reflect the presence of the bypass cookie

  it("draftMode().isEnabled returns false by default", async () => {
    const { data } = await fetchJson(baseUrl, "/nextjs-compat/api/draft-status");
    expect(data).toEqual({ isEnabled: false });
  });

  it("draftMode().isEnabled returns false for arbitrary cookie values", async () => {
    // Arbitrary cookie values should NOT enable draft mode — only the
    // server-generated secret is valid (prevents predictable bypass).
    const { data } = await fetchJson(baseUrl, "/nextjs-compat/api/draft-status", {
      headers: { Cookie: "__prerender_bypass=some-value" },
    });
    expect(data).toEqual({ isEnabled: false });
  });

  it("draftMode().enable() cookie includes Secure flag in production", async () => {
    const {
      draftMode: draftModeFn,
      getDraftModeCookieHeader,
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    vi.stubEnv("NODE_ENV", "production");
    try {
      const ctx = headersContextFromRequest(new Request("http://localhost/test"));
      await runWithHeadersContext(ctx, async () => {
        const dm = await draftModeFn();
        dm.enable();
        const cookieHeader = getDraftModeCookieHeader();
        expect(cookieHeader).toBeDefined();
        expect(cookieHeader).toMatch(/;\s*Secure/i);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("draftMode().enable() uses cross-site cookie attributes in production", async () => {
    const {
      draftMode: draftModeFn,
      getDraftModeCookieHeader,
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    vi.stubEnv("NODE_ENV", "production");
    try {
      const ctx = headersContextFromRequest(new Request("https://preview.example.com/test"));
      await runWithHeadersContext(ctx, async () => {
        const dm = await draftModeFn();
        dm.enable();
        const cookieHeader = getDraftModeCookieHeader();
        expect(cookieHeader).toBeDefined();
        expect(cookieHeader).toMatch(/;\s*SameSite=None/i);
        expect(cookieHeader).toMatch(/;\s*Secure/i);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("draftMode().disable() clears with Next.js production cookie attributes", async () => {
    const {
      draftMode: draftModeFn,
      getDraftModeCookieHeader,
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    vi.stubEnv("NODE_ENV", "production");
    try {
      const ctx = headersContextFromRequest(new Request("https://preview.example.com/test"));
      await runWithHeadersContext(ctx, async () => {
        const dm = await draftModeFn();
        dm.disable();
        const cookieHeader = getDraftModeCookieHeader();
        expect(cookieHeader).toBeDefined();
        expect(cookieHeader).toMatch(/;\s*SameSite=None/i);
        expect(cookieHeader).toMatch(/;\s*Secure/i);
        expect(cookieHeader).toMatch(/;\s*Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
        expect(cookieHeader).not.toMatch(/;\s*Max-Age=0/i);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("draftMode().enable() cookie omits Secure flag in development", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/draft-enable`);
    const setCookies = res.headers.getSetCookie();
    const bypassCookie = setCookies.find((c) => c.includes("__prerender_bypass"));
    expect(bypassCookie).toBeDefined();
    // Dev server runs in development — should NOT have Secure flag
    expect(bypassCookie).not.toMatch(/;\s*Secure/i);
  });

  // ── draftMode() dynamic tracking ─────────────────────────────
  // Calling `draftMode()` itself is NOT dynamic — `isEnabled` is a plain
  // getter and merely awaiting `draftMode()` does not require bailing out
  // of static prerendering. Only `enable()` / `disable()` mutate state and
  // must be tracked as dynamic.
  //
  // Ported from Next.js: test/e2e/app-dir/draft-mode/draft-mode.test.ts
  // ("should not generate rand when draft mode disabled during next start").
  // Source: .nextjs-ref/packages/next/src/server/request/draft-mode.ts (trackDynamicDraftMode).

  it("draftMode() does NOT mark dynamic usage on its own (allows static prerender)", async () => {
    const {
      draftMode: draftModeFn,
      consumeDynamicUsage,
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    const ctx = headersContextFromRequest(new Request("http://localhost/test"));
    await runWithHeadersContext(ctx, async () => {
      consumeDynamicUsage();
      const dm = await draftModeFn();
      // Reading isEnabled is also non-dynamic.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      dm.isEnabled;
      expect(consumeDynamicUsage()).toBe(false);
    });
  });

  it("draftMode().enable() marks dynamic usage", async () => {
    const {
      draftMode: draftModeFn,
      consumeDynamicUsage,
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    const ctx = headersContextFromRequest(new Request("http://localhost/test"));
    await runWithHeadersContext(ctx, async () => {
      consumeDynamicUsage();
      const dm = await draftModeFn();
      expect(consumeDynamicUsage()).toBe(false);
      dm.enable();
      expect(consumeDynamicUsage()).toBe(true);
    });
  });

  it("draftMode().disable() marks dynamic usage", async () => {
    const {
      draftMode: draftModeFn,
      consumeDynamicUsage,
      runWithHeadersContext,
      headersContextFromRequest,
    } = await import("../../packages/vinext/src/shims/headers.js");

    const ctx = headersContextFromRequest(new Request("http://localhost/test"));
    await runWithHeadersContext(ctx, async () => {
      consumeDynamicUsage();
      const dm = await draftModeFn();
      expect(consumeDynamicUsage()).toBe(false);
      dm.disable();
      expect(consumeDynamicUsage()).toBe(true);
    });
  });

  it("draftMode().isEnabled returns true after enable() round-trip", async () => {
    // Enable draft mode and extract the Set-Cookie value
    const enableRes = await fetch(`${baseUrl}/nextjs-compat/api/draft-enable`);
    const setCookies = enableRes.headers.getSetCookie();
    const bypassCookie = setCookies.find((c) => c.includes("__prerender_bypass"));
    expect(bypassCookie).toBeDefined();
    // Extract raw cookie (name=value portion before first ;)
    const rawCookie = bypassCookie!.split(";")[0];

    // Send the valid cookie back to check isEnabled
    const { data } = await fetchJson(baseUrl, "/nextjs-compat/api/draft-status", {
      headers: { Cookie: rawCookie },
    });
    expect(data).toEqual({ isEnabled: true });
  });

  it('await draftMode() remains readable with dynamic = "error"', async () => {
    // Ported from Next.js: packages/next/src/server/request/draft-mode.ts
    // dynamicShouldError is checked by enable()/disable(), not by draftMode()
    // or its isEnabled getter.
    const res = await fetch(`${baseUrl}/nextjs-compat/draft-mode-dynamic-error`);
    const html = await res.text();

    expect(html).toContain("enabled:false");
    expect(res.headers.getSetCookie()).toEqual([]);

    const enableRes = await fetch(`${baseUrl}/nextjs-compat/api/draft-enable`);
    const bypassCookie = enableRes.headers
      .getSetCookie()
      .find((cookie) => cookie.includes("__prerender_bypass"));
    expect(bypassCookie).toBeDefined();

    const enabledRes = await fetch(`${baseUrl}/nextjs-compat/draft-mode-dynamic-error`, {
      headers: { Cookie: bypassCookie!.split(";")[0] },
    });
    expect(await enabledRes.text()).toContain("enabled:true");
  });

  // ── Draft mode streams Suspense fallbacks ────────────────────
  // Ported from Next.js: test/e2e/app-dir/cache-components/cache-components.draft-mode.test.ts
  // https://github.com/vercel/next.js/pull/93417

  it("should stream Suspense fallbacks when draft mode is enabled", async () => {
    // Enable draft mode and extract the bypass cookie
    const draftRes = await fetch(`${baseUrl}/nextjs-compat/api/draft-enable`);
    const setCookies = draftRes.headers.getSetCookie();
    const bypassCookie = setCookies.find((c) => c.includes("__prerender_bypass"));
    expect(bypassCookie).toBeDefined();
    const rawCookie = bypassCookie!.split(";")[0];

    // Request the streaming page with the draft cookie
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/draftmode/streaming", {
      headers: { Cookie: rawCookie },
    });

    expect(html).toContain('id="draft-mode">true');
    expect(html).toContain("Loading draft content...");
  });
});
