import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "../fixtures";

const FIXTURE_DIR = `${process.cwd()}/tests/e2e/cloudflare-workers/fixture`;
const BASE_URL = "http://localhost:4192";

let server: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`pure App Worker exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/dynamic-preload`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for pure App Worker");
}

test.describe("Cloudflare Workers dynamic preloads", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../../examples/app-router-cloudflare/node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; npx vp build && npx wrangler dev --config dist/server/wrangler.json --port 4192",
      {
        cwd: FIXTURE_DIR,
        shell: true,
        stdio: "inherit",
      },
    );
    await waitForServer();
  });

  test.afterAll(() => {
    server.kill();
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
});
