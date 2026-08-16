import { expect, test } from "../fixtures";
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
      'link[rel="preload"][as="script"][fetchpriority="low"]',
    );
    await expect(dynamicScriptPreloads).not.toHaveCount(0);
    for (const preload of await dynamicScriptPreloads.all()) {
      expect(await preload.evaluate((element) => (element as HTMLLinkElement).nonce)).toBe(
        "vinext-test-nonce",
      );
    }

    await page.click('[data-testid="dynamic-count"]');
    await expect(page.locator('[data-testid="dynamic-count"]')).toHaveText("Dynamic count: 1");

    void consoleErrors;
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
