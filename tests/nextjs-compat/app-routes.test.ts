/**
 * Next.js Compatibility Tests: app-custom-routes (Route Handlers)
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts
 *
 * Tests route handler behavior in the App Router:
 * - Basic HTTP methods (GET, POST, PUT, DELETE, PATCH)
 * - Query parameter reading
 * - Request headers reading via headers()
 * - Cookie reading via cookies()
 * - JSON and text body reading
 * - NextResponse.redirect() helper
 * - NextResponse.json() helper
 * - HEAD auto-implementation
 * - OPTIONS auto-implementation
 * - 405 Method Not Allowed
 * - 500 Internal Server Error (handler throws)
 * - redirect() and notFound() in route handlers
 * - cookies().set() and cookies().delete()
 * - Dynamic params in route handlers
 *
 * Fixture routes live in:
 * - fixtures/app-basic/app/nextjs-compat/api/* (new)
 * - fixtures/app-basic/app/api/* (pre-existing, referenced for some tests)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

describe("Next.js compat: app-routes", () => {
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

  // ── Basic HTTP methods ───────────────────────────────────────
  // Next.js: describe.each(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L30-L47

  describe.each(["GET", "POST", "PUT", "DELETE", "PATCH"])(
    "%s method",
    (method) => {
      it("responds with 200 and correct content", async () => {
        const res = await fetch(`${baseUrl}/nextjs-compat/api/methods`, {
          method,
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("hello, world");
        expect(res.headers.get("x-method")).toBe(method);
      });
    },
  );

  // ── Query parameters ─────────────────────────────────────────
  // Next.js: 'can read query parameters'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L69-L77

  it("can read query parameters", async () => {
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/query?ping=pong`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ping).toBe("pong");
  });

  // ── Headers reading ──────────────────────────────────────────
  // Next.js: 'gets the correct values' (headers)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L121-L131

  it("can read request headers via headers()", async () => {
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/headers-read`,
      {
        headers: { "x-test-ping": "pong" },
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ping).toBe("pong");
  });

  // ── Cookies reading ──────────────────────────────────────────
  // Next.js: 'gets the correct values' (cookies)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L134-L144

  it("can read cookies via cookies()", async () => {
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/cookies-read`,
      {
        headers: { cookie: "ping=pong" },
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ping).toBe("pong");
  });

  // ── JSON body ────────────────────────────────────────────────
  // Next.js: 'can read a JSON encoded body'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L137-L149

  it("can read a JSON encoded body", async () => {
    const body = { ping: "pong" };
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/body-json`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.body).toEqual(body);
  });

  // Next.js: 'can read a JSON encoded body for DELETE requests'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L163-L172

  it("can read a JSON encoded body for DELETE requests", async () => {
    const body = { name: "foo" };
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/body-json`,
      {
        method: "DELETE",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("delete foo");
  });

  // ── Text body ────────────────────────────────────────────────
  // Next.js: 'can read the text body'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L213-L223

  it("can read the text body", async () => {
    const body = "hello, world";
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/body-text`,
      {
        method: "POST",
        body,
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.body).toBe(body);
  });

  // ── NextResponse.redirect() ──────────────────────────────────
  // Next.js: 'supports the NextResponse.redirect() helper'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L94-L104

  it("supports NextResponse.redirect()", async () => {
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/redirect-response`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://nextjs.org/");
  });

  // ── NextResponse.json() ──────────────────────────────────────
  // Next.js: 'supports the NextResponse.json() helper'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L106-L115

  it("supports NextResponse.json()", async () => {
    const res = await fetch(
      `${baseUrl}/nextjs-compat/api/json-response?ping=hello`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data.ping).toBe("hello");
  });

  // ── HEAD auto-implementation ─────────────────────────────────
  // Next.js: 'implements HEAD on routes with GET already implemented'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L237-L244
  //
  // Using pre-existing /api/get-only which only exports GET

  it("auto-implements HEAD from GET", async () => {
    const res = await fetch(`${baseUrl}/api/get-only`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("");
  });

  // ── OPTIONS auto-implementation ──────────────────────────────
  // Next.js: 'implements OPTIONS on routes'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L246-L255

  it("auto-implements OPTIONS with Allow header", async () => {
    const res = await fetch(`${baseUrl}/api/get-only`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    const body = await res.text();
    expect(body).toBe("");
    const allow = res.headers.get("allow");
    expect(allow).toContain("GET");
    expect(allow).toContain("OPTIONS");
  });

  // ── 405 Method Not Allowed ───────────────────────────────────
  // Next.js: 'responds with 405 when method is not implemented'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L220-L227

  it("responds with 405 for unimplemented method", async () => {
    const res = await fetch(`${baseUrl}/api/get-only`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });

  // ── 500 Internal Server Error ────────────────────────────────
  // Next.js: 'responds with 500 when the handler throws an error'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L229-L233
  //
  // Using pre-existing /api/error-route

  it("responds with 500 when handler throws", async () => {
    const res = await fetch(`${baseUrl}/api/error-route`);
    expect(res.status).toBe(500);
  });

  // ── redirect() in route handlers ─────────────────────────────
  // Next.js: 'can respond correctly' (redirect)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L161-L172
  //
  // Using pre-existing /api/redirect-route (calls redirect('/about'))

  it("redirect() produces 307 with Location header", async () => {
    const res = await fetch(`${baseUrl}/api/redirect-route`, {
      redirect: "manual",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/about");
  });

  // ── notFound() in route handlers ─────────────────────────────
  // Next.js: 'can respond correctly in nodejs' (notFound)
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L186-L191
  //
  // Using pre-existing /api/not-found-route

  it("notFound() produces 404", async () => {
    const res = await fetch(`${baseUrl}/api/not-found-route`);
    expect(res.status).toBe(404);
  });

  // ── cookies().set() ──────────────────────────────────────────
  // Next.js: tests cookie setting via cookies() in route handlers
  // Using pre-existing /api/set-cookie

  it("cookies().set() produces Set-Cookie headers", async () => {
    const res = await fetch(`${baseUrl}/api/set-cookie`);
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c: string) =>
      c.startsWith("session="),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("abc123");
  });

  // ── cookies().delete() ───────────────────────────────────────
  it("cookies().delete() produces Set-Cookie with Max-Age=0", async () => {
    const res = await fetch(`${baseUrl}/api/set-cookie`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c: string) =>
      c.startsWith("session="),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("Max-Age=0");
  });

  // ── Dynamic params ───────────────────────────────────────────
  // Next.js: 'provides params to routes with dynamic parameters'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L84-L92
  //
  // Using pre-existing /api/items/[id]

  it("provides dynamic params to route handler", async () => {
    const res = await fetch(`${baseUrl}/api/items/42`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("42");
  });

  it("provides dynamic params with different methods", async () => {
    const res = await fetch(`${baseUrl}/api/items/99`, {
      method: "PUT",
      body: JSON.stringify({ name: "Widget" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("99");
    expect(data.name).toBe("Widget");
  });

  // ── Documented skips ─────────────────────────────────────────
  //
  // N/A: 'statically generates correctly with no dynamic usage'
  //   Next.js-specific build output (.next/server/app/...) not applicable
  //
  // N/A: 'works with generateStaticParams correctly'
  //   Tests ISR revalidation on route handlers with static params — build-specific
  //
  // N/A: 'abort via a request' (various methods)
  //   Tests AbortController on fetch — needs stderr inspection not available in vitest
  //
  // N/A: 'route groups' — Tests (group) routing syntax, separate feature
  //
  // N/A: 'can handle a streaming request and streaming response'
  //   Tests streaming body upload — complex streaming setup
  //
  // N/A: 'responds with 400 (Bad Request) when method is not a valid HTTP method'
  //   Can't send invalid HTTP method from fetch()
  //
  // N/A: 'responds with 500 when handler calls NextResponse.next()'
  //   Tests console output inspection, not available in vitest
  //
  // N/A: 'edge functions' — Tests edge runtime variant
  //
  // N/A: 'dynamic = "force-static"' — Tests force-static config stripping
  //
  // N/A: 'customized metadata routes' (robots.txt) — Metadata routes not in scope
  //
  // N/A: 'invalid exports' — Tests dev-only console error for default export
  //
  // N/A: 'no response returned' — Tests console error inspection
  //
  // N/A: 'permanentRedirect' — Would need fixture, minor variant of redirect
  //
  // N/A: 'catch-all routes' — Would need fixture with [...slug] route handler
});
