import { test, expect } from "@playwright/test";
import { request as httpRequest } from "node:http";

const BASE = "http://localhost:4176";

function getRawPath(path: string): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4176 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ body, status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

test.describe("Cloudflare Workers SSR", () => {
  test("home page renders server-side HTML", async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
    await expect(page.locator("p").first()).toContainText("server-rendered by vinext");
  });

  test("SSR HTML is present without JavaScript", async ({ page }) => {
    // Block all JS to verify SSR output
    await page.route("**/*.js", (route) => route.abort());

    await page.goto(`${BASE}/`);

    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
    // Counter should show initial state from SSR
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 0");
    // Timestamp should be present (server-rendered)
    const timestamp = await page.textContent('[data-testid="timestamp"]');
    expect(timestamp).toContain("Rendered at:");
  });

  test("about page renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/about`);

    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("p").first()).toContainText(
      "vinext app deployed on Cloudflare Workers",
    );
  });

  test("each request gets a fresh server render (dynamic timestamp)", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const ts1 = await page.textContent('[data-testid="timestamp"]');

    // Small delay to ensure different timestamp
    await page.waitForTimeout(50);
    await page.goto(`${BASE}/`);
    const ts2 = await page.textContent('[data-testid="timestamp"]');

    // Timestamps should be different (not cached/static)
    expect(ts1).not.toBe(ts2);
  });

  test("unknown routes return 404", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent-page`);
    expect(response?.status()).toBe(404);
  });

  // Ported from Next.js: test/e2e/middleware-general/test/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-general/test/index.test.ts
  test("middleware can handle a missing build asset", async ({ request }) => {
    const rewritten = await request.get(`${BASE}/_next/static/middleware-rewrite.js`);
    expect(rewritten.status()).toBe(200);
    expect(await rewritten.text()).toBe("rewritten missing asset");

    const unhandled = await request.get(`${BASE}/_next/static/missing.js`);
    expect(unhandled.status()).toBe(404);
    expect(unhandled.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(await unhandled.text()).toBe("Not Found");
  });

  test("double-encoded static paths are not decoded twice", async ({ request }) => {
    const direct = await request.get(`${BASE}/admin`);
    expect(direct.status()).toBe(403);

    const encoded = await request.get(`${BASE}/%2561dmin`);
    expect(encoded.status()).toBe(404);
    expect(await encoded.text()).not.toContain("Protected admin content");

    const encodedStatic = await getRawPath("/%61dmin");
    expect(encodedStatic.status).toBe(404);
    expect(encodedStatic.body).not.toContain("Protected admin content");
  });

  test("preserves App Page encoded params like Next.js", async ({ request }) => {
    const encodedPercent = await request.get(`${BASE}/blog/%2561`);
    expect(encodedPercent.status()).toBe(200);
    expect(await encodedPercent.text()).toContain("Slug: <!-- -->%2561");

    const encodedSlash = await request.get(`${BASE}/blog/a%2Fb`);
    expect(encodedSlash.status()).toBe(200);
    expect(await encodedSlash.text()).toContain("Slug: <!-- -->a%2Fb");
  });

  for (const pathname of ["/foo/..%252fadmin", "/api/health/..%252fadmin"]) {
    test(`keeps encoded delimiters non-structural for ${pathname}`, async ({ request }) => {
      const response = await request.get(`${BASE}${pathname}`);
      const body = await response.text();

      expect(response.status()).toBe(404);
      expect(body).not.toContain("Protected admin content");
    });
  }

  test("root layout wraps pages with html/head/body", async ({ page }) => {
    await page.goto(`${BASE}/`);

    // Check html tag has lang
    const lang = await page.getAttribute("html", "lang");
    expect(lang).toBe("en");

    // Check title is set
    const title = await page.title();
    expect(title).toBe("vinext on Cloudflare Workers");

    // Check meta viewport
    const viewport = await page.getAttribute('meta[name="viewport"]', "content");
    expect(viewport).toBe("width=device-width, initial-scale=1");
  });
});
