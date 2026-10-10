import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { waitForHydration } from "../helpers";

/**
 * Config redirects with header/cookie conditions in a Pages Router production
 * build. Next.js 16.2.7 keeps redirects in the server routes manifest only, so
 * condition values never reach public static assets, and the server stays the
 * authority for rules it alone can evaluate.
 */
const BASE = "http://localhost:4175";
const HEADER_VALUE = "header-capability-5f0c2e";
const COOKIE_VALUE = "cookie-capability-9a41d7";
const CLIENT_DIR = path.resolve(process.cwd(), "tests/fixtures/pages-basic/dist/client");

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

test.describe("Config redirect conditions (Pages Router production)", () => {
  test("header and cookie condition values stay out of public assets", async ({
    baseURL,
    page,
    request,
  }) => {
    const base = baseURL ?? BASE;
    const publicFiles = listFiles(CLIENT_DIR);
    expect(publicFiles.some((file) => file.endsWith(".js"))).toBe(true);
    for (const file of publicFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect(content.includes(HEADER_VALUE), file).toBe(false);
      expect(content.includes(COOKIE_VALUE), file).toBe(false);
      expect(content.includes("x-redirect-capability"), file).toBe(false);
    }

    const scriptUrls = new Set<string>();
    page.on("response", (response) => {
      if (response.request().resourceType() === "script") scriptUrls.add(response.url());
    });
    await page.goto(`${base}/`);
    await waitForHydration(page);

    expect(scriptUrls.size).toBeGreaterThan(0);
    for (const url of scriptUrls) {
      const body = await (await request.get(url)).text();
      expect(body.includes(HEADER_VALUE), url).toBe(false);
      expect(body.includes(COOKIE_VALUE), url).toBe(false);
    }
    const clientRedirects = await page.evaluate(() =>
      JSON.stringify((window as any).__VINEXT_CLIENT_REDIRECTS__),
    );
    expect(clientRedirects).toContain('"source":"/server-condition-redirect/header"');
    expect(clientRedirects).not.toContain(HEADER_VALUE);
    expect(clientRedirects).not.toContain(COOKIE_VALUE);
  });

  test("the server still applies header and cookie conditions", async ({ baseURL, request }) => {
    const base = baseURL ?? BASE;
    const header = await request.get(`${base}/server-condition-redirect/header`, {
      headers: { "x-redirect-capability": HEADER_VALUE },
      maxRedirects: 0,
    });
    expect(header.status()).toBe(307);
    expect(header.headers()["location"]).toBe("/about");

    const wrongHeader = await request.get(`${base}/server-condition-redirect/header`, {
      headers: { "x-redirect-capability": "wrong" },
      maxRedirects: 0,
    });
    expect(wrongHeader.status()).toBe(404);

    const cookie = await request.get(`${base}/server-condition-redirect/shadowed`, {
      headers: { cookie: `redirect-capability=${COOKIE_VALUE}` },
      maxRedirects: 0,
    });
    expect(cookie.status()).toBe(307);
    expect(cookie.headers()["location"]).toBe("/about");

    const noCookie = await request.get(`${base}/server-condition-redirect/shadowed`, {
      maxRedirects: 0,
    });
    expect(noCookie.status()).toBe(307);
    expect(noCookie.headers()["location"]).toBe("/nav-test");
  });

  test("client navigation leaves a matching server-only rule to the server", async ({
    baseURL,
    context,
    page,
  }) => {
    const base = baseURL ?? BASE;
    // HttpOnly: browser JavaScript cannot see this cookie, only the server can.
    await context.addCookies([
      {
        name: "redirect-capability",
        value: COOKIE_VALUE,
        url: base,
        httpOnly: true,
      },
    ]);
    await page.goto(`${base}/`);
    await waitForHydration(page);

    await page.evaluate(() =>
      (window as any).next.router.push("/server-condition-redirect/shadowed"),
    );
    await expect(page.locator("h1")).toHaveText("About");
    expect(new URL(page.url()).pathname).toBe("/about");
  });

  test("client navigation leaves a header-conditioned rule to the server", async ({
    baseURL,
    page,
  }) => {
    const base = baseURL ?? BASE;
    await page.setExtraHTTPHeaders({ "x-redirect-capability": HEADER_VALUE });
    await page.goto(`${base}/`);
    await waitForHydration(page);

    await page.evaluate(() =>
      (window as any).next.router.push("/server-condition-redirect/header"),
    );
    await expect(page.locator("h1")).toHaveText("About");
    expect(new URL(page.url()).pathname).toBe("/about");
  });

  test("the server applies the later rule when the server-only rule misses", async ({
    baseURL,
    page,
  }) => {
    const base = baseURL ?? BASE;
    await page.goto(`${base}/`);
    await waitForHydration(page);

    await page.evaluate(() =>
      (window as any).next.router.push("/server-condition-redirect/shadowed"),
    );
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    expect(new URL(page.url()).pathname).toBe("/nav-test");
  });
});
