import { type ViteDevServer } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "./helpers.js";

describe("App Router middleware with NextRequest", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("middleware receives NextRequest and can use .nextUrl", async () => {
    // The middleware sets x-mw-pathname from request.nextUrl.pathname
    // If the middleware received a plain Request, this would throw TypeError
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect(res.headers.get("x-mw-pathname")).toBe("/about");
  });

  it("middleware NextRequest.nextUrl.pathname strips .rsc suffix", async () => {
    // Regression: .rsc is an internal transport detail; middleware should see
    // the clean pathname (/about), not the raw URL (/about.rsc).
    const res = await fetch(`${baseUrl}/about.rsc`);
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect(res.headers.get("x-mw-pathname")).toBe("/about");
  });

  it("middleware receives NextRequest and can use .cookies", async () => {
    // The middleware checks request.cookies.get() which requires NextRequest
    const res = await fetch(`${baseUrl}/about`, {
      headers: {
        Cookie: "session=test-token",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect(res.headers.get("x-mw-has-session")).toBe("true");
  });

  it("object-form matcher requires has and missing conditions", async () => {
    const noHeaderRes = await fetch(`${baseUrl}/mw-object-gated`);
    expect(noHeaderRes.status).toBe(200);
    expect(noHeaderRes.headers.get("x-mw-ran")).toBeNull();

    const blockedRes = await fetch(`${baseUrl}/mw-object-gated`, {
      headers: {
        "x-mw-allow": "1",
        Cookie: "mw-blocked=1",
      },
    });
    expect(blockedRes.status).toBe(200);
    expect(blockedRes.headers.get("x-mw-ran")).toBeNull();

    const allowedRes = await fetch(`${baseUrl}/mw-object-gated`, {
      headers: { "x-mw-allow": "1" },
    });
    expect(allowedRes.status).toBe(200);
    expect(allowedRes.headers.get("x-mw-ran")).toBe("true");
    expect(allowedRes.headers.get("x-mw-pathname")).toBe("/mw-object-gated");
  });

  it("middleware can redirect using NextRequest", async () => {
    const res = await fetch(`${baseUrl}/middleware-redirect`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("middleware can rewrite using NextRequest", async () => {
    const res = await fetch(`${baseUrl}/middleware-rewrite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should render the / page content (the rewrite destination)
    expect(html).toContain("Welcome to App Router");
  });

  it("middleware can return custom response", async () => {
    const res = await fetch(`${baseUrl}/middleware-blocked`);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toBe("Blocked by middleware");
  });

  it("middleware that throws returns 500 instead of bypassing", async () => {
    const res = await fetch(`${baseUrl}/middleware-throw`);
    expect(res.status).toBe(500);
  });

  it("middleware request header overrides can delete credential headers before rendering", async () => {
    // Ported from Next.js: test/e2e/middleware-request-header-overrides/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-request-header-overrides/test/index.test.ts
    const { res, html } = await fetchHtml(baseUrl, "/header-override-delete", {
      headers: {
        authorization: "Bearer secret",
        cookie: "a=1; b=2",
      },
    });

    expect(res.status).toBe(200);
    expect(html).toContain('id="authorization">null<');
    expect(html).toContain('id="cookie">null<');
    expect(html).toContain('id="middleware-header">hello-from-middleware<');
    expect(html).toContain('id="cookie-count">0<');
  });

  it("middleware request header overrides also apply to App Route request.headers", async () => {
    const res = await fetch(`${baseUrl}/api/header-override-delete`, {
      headers: {
        authorization: "Bearer secret",
        cookie: "a=1; b=2",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requestAuthorization: null,
      requestCookie: null,
      requestMiddlewareHeader: "hello-from-middleware",
      headersApiAuthorization: null,
      headersApiCookie: null,
      headersApiMiddlewareHeader: "hello-from-middleware",
    });
  });

  it("middleware request header overrides can delete credential headers before pages getServerSideProps in mixed projects", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/pages-header-override-delete", {
      headers: {
        authorization: "Bearer secret",
        cookie: "a=1; b=2",
      },
    });

    expect(res.status).toBe(200);
    expect(html).toContain("Pages Header Override Delete");
    expect(html).toContain('<p id="authorization"></p>');
    expect(html).toContain('<p id="cookie"></p>');
    expect(html).toContain('id="middleware-header">hello-from-middleware<');
    expect(html).toContain('"authorization":null');
    expect(html).toContain('"cookie":null');
  });

  it("middleware rewrite preserves query params from the rewrite URL", async () => {
    // Middleware rewrites /middleware-rewrite-query → /search-query?searchParams=from-rewrite&extra=injected
    // The rewrite URL's query string must be visible to the target page.
    const res = await fetch(`${baseUrl}/middleware-rewrite-query`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The /search-query page renders searchParams from props
    expect(html).toContain("from-rewrite");
  });

  // Regression for cloudflare/vinext#1342: when middleware preserves the
  // original request's query — by mutating `request.nextUrl` (which already
  // carries the original search) rather than constructing a fresh path-only
  // URL — those params must survive into the rewrite target. The destination
  // URL is the source of truth; vinext does not auto-merge any extra original
  // query on top.
  // Mirrors the Next.js middleware idiom in test/e2e/middleware-rewrites/app/middleware.js
  // (`url.pathname = "/x"; NextResponse.rewrite(url)`).
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-rewrites/app/middleware.js
  it("middleware rewrite preserves original request query params into the rewrite target", async () => {
    const res = await fetch(
      `${baseUrl}/middleware-rewrite-keep-original-query?searchParams=from-original`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("from-original");
  });

  it("does not leak x-middleware-next or x-middleware-rewrite headers to the client", async () => {
    // NextResponse.next() sets x-middleware-next internally.
    // The dev server must strip it (and all x-middleware-* headers) before
    // sending the response to the client — they are internal routing signals.
    const nextRes = await fetch(`${baseUrl}/about`);
    expect(nextRes.status).toBe(200);
    // Middleware ran (verified by the custom header it sets)
    expect(nextRes.headers.get("x-mw-ran")).toBe("true");
    // Internal headers must NOT be present
    expect(nextRes.headers.get("x-middleware-next")).toBeNull();
    expect(nextRes.headers.get("x-middleware-rewrite")).toBeNull();
    // Check that no x-middleware-* header leaked at all
    for (const [key] of nextRes.headers) {
      expect(key.startsWith("x-middleware-")).toBe(false);
    }

    // NextResponse.rewrite() sets x-middleware-rewrite internally.
    const rewriteRes = await fetch(`${baseUrl}/middleware-rewrite`);
    expect(rewriteRes.status).toBe(200);
    expect(rewriteRes.headers.get("x-middleware-rewrite")).toBeNull();
    expect(rewriteRes.headers.get("x-middleware-next")).toBeNull();
    for (const [key] of rewriteRes.headers) {
      expect(key.startsWith("x-middleware-")).toBe(false);
    }
  });

  it("middleware receives event with waitUntil (for Clerk compat)", async () => {
    const res = await fetch(`${baseUrl}/middleware-event`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("Event OK");
  });

  it("middleware response headers appear on intercepting route RSC responses", async () => {
    // Intercepting route responses are constructed via renderInterceptResponse(),
    // which must merge _mwCtx.headers into the Response — same as the normal
    // page path through buildAppPageRscResponse().
    const res = await fetch(`${baseUrl}/photos/42.rsc`, {
      headers: {
        Accept: "text/x-component",
        "X-Vinext-Interception-Context": "/feed",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    // Middleware sets x-mw-ran and x-mw-pathname on all matched paths
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect(res.headers.get("x-mw-pathname")).toBe("/photos/42");
    const payload = await res.text();
    expect(payload).toContain("Photo Modal");
    expect(payload).toContain("Photo Feed");
  });
});
