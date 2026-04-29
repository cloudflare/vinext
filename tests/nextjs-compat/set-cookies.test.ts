/**
 * Next.js Compatibility Tests: set-cookies
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/set-cookies
 *
 * Tests cookies() API from next/headers in App Router route handlers:
 * - cookies().set() produces Set-Cookie header
 * - cookies().set() with httpOnly option
 * - Multiple cookies().set() calls produce multiple Set-Cookie headers
 * - cookies().delete() produces Max-Age=0 Set-Cookie
 * - cookies().get() reads cookie from request
 * - cookies().get() returns null when cookie not present
 *
 * Fixture routes live in:
 * - fixtures/app-basic/app/nextjs-compat/api/set-cookie/
 * - fixtures/app-basic/app/nextjs-compat/api/set-multiple-cookies/
 * - fixtures/app-basic/app/nextjs-compat/api/delete-cookie/
 * - fixtures/app-basic/app/nextjs-compat/api/read-cookie/
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchJson } from "../helpers.js";

describe("Next.js compat: set-cookies", () => {
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

  // ── cookies().set() ─────────────────────────────────────────
  // Next.js: setting a cookie in a route handler produces Set-Cookie header
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/set-cookies

  it("cookies().set() produces Set-Cookie header", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/set-cookie`);
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some((c) => c.includes("session=abc123"))).toBe(true);
  });

  it("cookies().set() with httpOnly option", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/set-multiple-cookies`);
    const setCookies = res.headers.getSetCookie();
    const tokenCookie = setCookies.find((c) => c.includes("token=xyz"));
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toMatch(/HttpOnly/i);
  });

  it("multiple cookies().set() produces multiple Set-Cookie headers", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/set-multiple-cookies`);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes("token=xyz"))).toBe(true);
    expect(setCookies.some((c) => c.includes("theme=dark"))).toBe(true);
  });

  it("returned response cookies take precedence over mutable cookies with the same name", async () => {
    // Next.js app route handlers merge mutable cookies as fallbacks before
    // reapplying returned response cookies as the final values.
    // Source: https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/adapters/request-cookies.ts
    const res = await fetch(`${baseUrl}/nextjs-compat/api/cookie-precedence`);
    const setCookies = res.headers.getSetCookie();

    expect(setCookies).toHaveLength(3);
    expect(setCookies.some((c) => c.startsWith("session=returned;"))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("response-only=1;"))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("mutable-only=final;"))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("session=mutable;"))).toBe(false);
    expect(setCookies.some((c) => c.startsWith("mutable-only=first;"))).toBe(false);
  });

  // ── cookies().delete() ──────────────────────────────────────
  // Next.js: deleting a cookie produces Set-Cookie with Max-Age=0

  it("cookies().delete() produces Max-Age=0 Set-Cookie", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/api/delete-cookie`);
    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.includes("session="));
    expect(sessionCookie).toBeDefined();
    // Deletion should set Max-Age=0 or an expired date
    expect(sessionCookie).toMatch(/Max-Age=0|expires=Thu, 01 Jan 1970/i);
  });

  // ── cookies().get() ─────────────────────────────────────────
  // Next.js: reading a cookie from the incoming request

  it("cookies().get() reads cookie from request", async () => {
    const { data } = await fetchJson(baseUrl, "/nextjs-compat/api/read-cookie", {
      headers: { Cookie: "session=test-value" },
    });
    expect(data).toEqual({ session: "test-value" });
  });

  it("cookies().get() returns null when cookie not present", async () => {
    const { data } = await fetchJson(baseUrl, "/nextjs-compat/api/read-cookie");
    expect(data).toEqual({ session: null });
  });
});
