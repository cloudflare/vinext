/**
 * OpenNext Compat: Middleware redirect, rewrite, and block behavior.
 *
 * Ported from:
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/middleware.redirect.test.ts
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/middleware.rewrite.test.ts
 * Tests: ON-11 in TRACKING.md
 */
import { test, expect } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

const BASE = "http://localhost:4174";

function getRawPath(
  path: string,
): Promise<{ body: string; headers: IncomingHttpHeaders; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4174 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          body,
          headers: res.headers,
          location: Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location,
          status: res.statusCode ?? 0,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test.describe("Middleware Redirect (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare middleware.redirect.test.ts — "Middleware Redirect"
  test("navigating to /middleware-redirect lands on /about", async ({ page }) => {
    await page.goto(`${BASE}/middleware-redirect`);
    await page.waitForURL(/\/about$/);

    const el = page.getByText("About", { exact: true });
    await expect(el).toBeVisible();
  });

  // Ref: opennextjs-cloudflare middleware.redirect.test.ts — cookie set on redirect
  test("redirect sets a cookie", async ({ page, context }) => {
    await page.goto(`${BASE}/middleware-redirect`);
    await page.waitForURL(/\/about$/);

    const cookies = await context.cookies();
    const mwCookie = cookies.find((c) => c.name === "middleware-redirect");
    expect(mwCookie?.value).toBe("success");
  });

  // Ref: opennextjs-cloudflare middleware.redirect.test.ts — direct load also redirects
  test("direct load of /middleware-redirect redirects", async ({ request }) => {
    const res = await request.get(`${BASE}/middleware-redirect`, {
      maxRedirects: 0,
    });
    // Should be a 307 redirect (Next.js default for temporary redirect)
    expect([301, 302, 307, 308]).toContain(res.status());
    expect(res.headers()["location"]).toMatch(/\/about$/);
  });
});

test.describe("Middleware Rewrite (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare middleware.rewrite.test.ts — "Middleware Rewrite"
  test("rewrite serves / content at /middleware-rewrite URL", async ({ page }) => {
    await page.goto(`${BASE}/middleware-rewrite`);

    // URL should stay as /middleware-rewrite (rewrite, not redirect)
    expect(page.url()).toMatch(/\/middleware-rewrite$/);

    // Content should be from / (home page)
    const el = page.getByText("Welcome to App Router", { exact: true });
    await expect(el).toBeVisible();
  });

  // Ref: opennextjs-cloudflare middleware.rewrite.test.ts — "Middleware Rewrite Status Code"
  test("rewrite with custom status code returns 403", async ({ page }) => {
    const statusPromise = new Promise<number>((resolve) => {
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === "/middleware-rewrite-status") {
          resolve(response.status());
        }
      });
    });

    await page.goto(`${BASE}/middleware-rewrite-status`);

    // Content should be from / (home page) despite 403 status
    const el = page.getByText("Welcome to App Router", { exact: true });
    await expect(el).toBeVisible();

    expect(await statusPromise).toBe(403);
  });
});

test.describe("Middleware Block (OpenNext compat)", () => {
  test("blocked route returns 403", async ({ request }) => {
    const res = await request.get(`${BASE}/middleware-blocked`);
    expect(res.status()).toBe(403);

    const body = await res.text();
    expect(body).toContain("Blocked by middleware");
  });

  test("double-encoded static paths are not decoded twice", async ({ request }) => {
    const direct = await request.get("/admin");
    expect(direct.status()).toBe(403);

    const response = await request.get("/%2561dmin");
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain("Protected admin content");

    const encodedStatic = await getRawPath("/%61bout");
    expect(encodedStatic.status).toBe(404);
    expect(encodedStatic.body).not.toContain("About");
  });

  test("server action rerenders preserve encoded request route identity", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-revalidate`);
    await expect(page.locator("#revalidate")).toBeVisible();
    await page.evaluate(() => history.pushState(null, "", "/%2561dmin"));

    const actionResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST",
    );
    await page.locator("#revalidate").click();
    const actionResponse = await actionResponsePromise;

    expect(new URL(actionResponse.url()).pathname).toBe("/%2561dmin");
    expect(await actionResponse.text()).not.toContain("Protected admin content");
  });

  for (const pathname of ["/foo/..%252fadmin", "/api/health/..%252fadmin"]) {
    test(`keeps encoded delimiters non-structural for ${pathname}`, async ({ request }) => {
      const response = await request.get(pathname);
      expect(response.status()).toBe(404);
      expect(await response.text()).not.toContain("Protected admin content");
    });
  }
});

test.describe("encoded App route parity", () => {
  test("keeps encoded aliases out of slash and config-header identity in dev", async () => {
    const literal = await getRawPath("/about");
    expect(literal.status).toBe(200);
    expect(literal.headers["x-page-header"]).toBe("about-page");

    const alias = await getRawPath("/%61bout");
    expect(alias.status).toBe(404);
    expect(alias.body).not.toContain("About");
    expect(alias.headers["x-page-header"]).toBeUndefined();

    const slash = await getRawPath("/%61bout/");
    expect(slash.status).toBe(308);
    expect(slash.location).toBe("/%61bout");
  });

  test("canonicalizes WHATWG dot segments before App dev routing and config", async () => {
    const page = await getRawPath("/%2e/about");
    expect(page.status).toBe(200);
    expect(page.headers["x-mw-pathname"]).toBe("/about");
    expect(page.headers["x-page-header"]).toBe("about-page");
    expect(page.body).toContain("About");

    const redirect = await getRawPath("/x/%2e%2e/old-about");
    expect(redirect.status).toBe(308);
    expect(redirect.location).toBe("/about");

    const rewrite = await getRawPath("/x/%2e%2e/rewrite-about");
    expect(rewrite.status).toBe(200);
    expect(rewrite.body).toContain("About");

    for (const escapedDelimiter of ["%2f", "%5c", "%252f"]) {
      expect((await getRawPath(`/x/${escapedDelimiter}/about`)).status).toBe(404);
    }
  });

  test("keeps lazy Route Handler params stable across first and later requests", async ({
    request,
  }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request.get(`${BASE}/encoded-parity/handler/a%2561/b%2Fc`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ path: ["a%61", "b/c"] });
    }

    const optional = await request.get(`${BASE}/encoded-parity/handler`);
    expect(await optional.json()).toEqual({ path: null });
  });

  test("keeps direct, config-rewritten, and middleware-rewritten App Page params canonical", async ({
    request,
  }) => {
    for (const pathname of [
      "/encoded-parity/page/a%2561/b%2Fc",
      "/encoded-parity/rewrite/a%2561/b%2Fc",
      "/encoded-parity/middleware/a%2561/b%2Fc",
    ]) {
      const response = await request.get(`${BASE}${pathname}`);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain('["a%2561","b%2Fc"]');
    }
  });

  test("dynamicParams=false only accepts the encoded literal static value", async () => {
    const allowed = await getRawPath("/encoded-parity/static/a%252Fb");
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain("a%252Fb");

    const alias = await getRawPath("/encoded-parity/static/a%2Fb");
    expect(alias.status).toBe(404);
  });

  test("routes an explicit middleware rewrite whose normalized target is unchanged", async () => {
    const response = await getRawPath("/%61dmin");
    expect(response.status).toBe(200);
    expect(response.body).toContain("Protected admin content");
  });

  test("keeps config source literals distinct from percent-encoded aliases", async () => {
    const literalRewrite = await getRawPath("/rewrite-about");
    expect(literalRewrite.status).toBe(200);
    expect(literalRewrite.body).toContain("About");

    const encodedRewrite = await getRawPath("/%72ewrite-about");
    expect(encodedRewrite.status).toBe(404);
    expect(encodedRewrite.body).not.toContain("About");

    const literalRedirect = await getRawPath("/old-about");
    expect(literalRedirect.status).toBe(308);
    expect(literalRedirect.location).toBe("/about");

    const encodedRedirect = await getRawPath("/%6Fld-about");
    expect(encodedRedirect.status).toBe(404);
    expect(encodedRedirect.location).toBeUndefined();
  });

  test("preserves every encoding layer in repeated config redirect captures", async () => {
    const response = await getRawPath("/repeat-redirect/a%252Fb");

    expect(response.status).toBe(307);
    expect(response.location).toBe("/blog/a%252Fb/a%252Fb");
  });
});

test.describe("Middleware execution count", () => {
  test.beforeEach(async ({ request }) => {
    // Reset the invocation counter before each test.
    const res = await request.delete(`${BASE}/api/instrumentation-test`);
    expect(res.status()).toBe(200);
  });

  // Regression test: in a hybrid app+pages fixture the connect handler
  // forwards middleware results to the RSC entry via x-vinext-mw-ctx so that
  // middleware only executes once per request. Without this, middleware runs
  // twice — once in the SSR env (connect handler) and again in the RSC env.
  test("middleware runs exactly once per App Router request in hybrid app+pages fixture", async ({
    request,
  }) => {
    // /about is an App Router route that is in the middleware matcher.
    const res = await request.get(`${BASE}/about`);
    expect(res.status()).toBe(200);
    expect(res.headers()["x-mw-ran"]).toBe("true");

    const stateRes = await request.get(`${BASE}/api/instrumentation-test`);
    const data = await stateRes.json();

    expect(data.middlewareInvocationCount).toBe(1);
    expect(data.middlewareInvokedPaths).toEqual(["/about"]);
  });
});
