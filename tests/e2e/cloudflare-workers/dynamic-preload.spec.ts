import { expect, test } from "../fixtures";
import { waitForAppRouterHydration } from "../helpers";
import {
  FIXTURE_HOOK_TIMEOUT_MS,
  startFixtureDevServer,
  stopFixtureDevServer,
  type FixtureDevServer,
} from "../../fixture-dev-server.js";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/fixture`;
const BASE_URL = "http://localhost:4192";

let server: FixtureDevServer;

test.describe("Cloudflare Workers dynamic preloads", () => {
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
    testInfo.setTimeout(FIXTURE_HOOK_TIMEOUT_MS);
    server = await startFixtureDevServer({
      name: "pure App Worker",
      root: FIXTURE_DIR,
      port: 4192,
      command: {
        bin: "sh",
        args: [
          "-c",
          "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build && npx wrangler dev --config dist/server/wrangler.json --port 4192",
        ],
      },
    });
  });

  test.afterAll(() => {
    stopFixtureDevServer(server?.process);
  });

  test("preloads dynamic assets with the CSP nonce in a pure App Worker", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE_URL}/dynamic-preload`);
    expect(response?.headers()["content-security-policy"]).toContain(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const dynamicStylesheet = page.locator('link[rel="stylesheet"][data-precedence="dynamic"]');
    await expect(dynamicStylesheet).toHaveCount(1);
    expect(await dynamicStylesheet.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
      "vinext-test-nonce",
    );

    const dynamicScriptPreloads = page.locator(
      'link[rel="modulepreload"][as="script"][fetchpriority="low"]',
    );
    await expect(dynamicScriptPreloads).not.toHaveCount(0);
    await expect(page.locator('link[rel="preload"][as="script"][fetchpriority="low"]')).toHaveCount(
      0,
    );
    for (const preload of await dynamicScriptPreloads.all()) {
      expect(await preload.getAttribute("crossorigin")).toBe("");
      expect(await preload.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
        "vinext-test-nonce",
      );
    }

    await page.click('[data-testid="dynamic-count"]');
    await expect(page.locator('[data-testid="dynamic-count"]')).toHaveText("Dynamic count: 1");

    void consoleErrors;
  });

  // Ported from Next.js: test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
  //
  // `inner2.tsx` throws during SSR, so the page recovers through a client
  // render. `global.css` is imported by a Server Component layout and by a
  // next/dynamic client component; the client chunk's copy must not be
  // re-inserted after the CSS Modules and page stylesheet that follow it.
  test.describe("next-dynamic-css", () => {
    const NEXT_DYNAMIC_CSS_URL = `${BASE_URL}/next-dynamic-css/page`;

    test("should have correct order of styles between global and css modules", async ({ page }) => {
      await page.goto(NEXT_DYNAMIC_CSS_URL);
      const server = page.locator("#server");
      await expect(server).toHaveText("Hello Server");
      await expect(server).toHaveCSS("background-color", "rgb(0, 128, 0)");
      await expect(server).toHaveCSS("color", "rgb(0, 0, 0)");
    });

    test("should have correct order of styles on client component that is sharing styles with next/dynamic", async ({
      page,
    }) => {
      await page.goto(NEXT_DYNAMIC_CSS_URL);
      const inner2 = page.locator("#inner2");
      await expect(inner2).toHaveText("Hello Inner 2");
      await expect(inner2).toHaveCSS("background-color", "rgb(0, 128, 0)");
      await expect(inner2).toHaveCSS("color", "rgb(0, 0, 0)");
    });

    test("should have correct order of styles on next/dynamic loaded component", async ({
      page,
    }) => {
      await page.goto(NEXT_DYNAMIC_CSS_URL);
      const component = page.locator("#component");
      await expect(component).toHaveText("Hello Component");
      await expect(component).toHaveCSS("background-color", "rgb(0, 128, 0)");
      await expect(component).toHaveCSS("color", "rgb(0, 0, 0)");
    });

    test("should have correct order of global styles between layout and pages", async ({
      page,
    }) => {
      await page.goto(NEXT_DYNAMIC_CSS_URL);
      const global = page.locator("#global");
      await expect(global).toHaveText("Hello Global");
      await expect(global).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(global).toHaveCSS("color", "rgb(0, 0, 0)");
      await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    });

    // vinext addition: the server stylesheets and the next/dynamic chunk's
    // stylesheets arrive together during a client-side navigation, the other
    // path where React has not committed the shared stylesheet yet.
    test("keeps the cascade after a soft navigation", async ({ page }) => {
      type SoftNavWindow = Window & { __softNavMarker?: boolean };
      await page.goto(`${BASE_URL}/next-dynamic-css/nav`);
      await waitForAppRouterHydration(page);
      await page.evaluate(() => {
        (window as SoftNavWindow).__softNavMarker = true;
      });
      await page.click("#to-page");
      const component = page.locator("#component");
      await expect(component).toHaveText("Hello Component");
      expect(await page.evaluate(() => (window as SoftNavWindow).__softNavMarker)).toBe(true);
      await expect(page.locator("#server")).toHaveCSS("background-color", "rgb(0, 128, 0)");
      await expect(page.locator("#server")).toHaveCSS("color", "rgb(0, 0, 0)");
      await expect(page.locator("#inner2")).toHaveCSS("background-color", "rgb(0, 128, 0)");
      await expect(page.locator("#inner2")).toHaveCSS("color", "rgb(0, 0, 0)");
      await expect(component).toHaveCSS("background-color", "rgb(0, 128, 0)");
      await expect(component).toHaveCSS("color", "rgb(0, 0, 0)");
      await expect(page.locator("#global")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    });

    // vinext addition: an import() started outside a render (an event
    // handler) commits through its own update, so the chunk must not
    // evaluate before its stylesheet has loaded or it renders unstyled.
    test("does not render an on-demand chunk before its stylesheet", async ({ page }) => {
      type PanelWindow = Window & { __panelFirstBackground?: string };
      // Make the stylesheet reliably slower than the JavaScript chunk.
      await page.route("**/_next/static/css/panel*.css", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.continue();
      });
      await page.goto(`${BASE_URL}/next-dynamic-css/on-demand`);
      await waitForAppRouterHydration(page);
      await page.evaluate(() => {
        new MutationObserver((_records, observer) => {
          const panel = document.getElementById("panel");
          if (!panel) return;
          (window as PanelWindow).__panelFirstBackground = getComputedStyle(panel).backgroundColor;
          observer.disconnect();
        }).observe(document.body, { childList: true, subtree: true });
      });
      await page.click("#open-panel");
      await expect(page.locator("#panel")).toHaveCSS("background-color", "rgb(0, 128, 0)");
      expect(await page.evaluate(() => (window as PanelWindow).__panelFirstBackground)).toBe(
        "rgb(0, 128, 0)",
      );
    });

    test("links the shared stylesheet once", async ({ page }) => {
      await page.goto(NEXT_DYNAMIC_CSS_URL);
      await expect(page.locator("#component")).toHaveText("Hello Component");
      const stylesheetPaths = await page
        .locator('link[rel="stylesheet"]')
        .evaluateAll((links) =>
          links.map((link) => new URL((link as HTMLLinkElement).href).pathname),
        );
      expect(stylesheetPaths).toEqual([...new Set(stylesheetPaths)]);
    });
  });

  test("preserves request.cf in App Router route handlers without ISR caching", async ({
    request,
  }) => {
    for (const marker of ["first", "second"]) {
      const response = await request.get(`${BASE_URL}/api/request-cf?marker=${marker}`);

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({
        marker,
        clonedMarker: marker,
      });
    }

    const forceStaticResponse = await request.get(
      `${BASE_URL}/api/request-cf-force-static?marker=hidden`,
    );
    expect(forceStaticResponse.status()).toBe(200);
    expect(await forceStaticResponse.json()).toEqual({
      hidesCfAfterDelete: true,
      hidesCfAfterLock: true,
    });
  });
});
