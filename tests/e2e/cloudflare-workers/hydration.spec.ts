import { test, expect } from "../fixtures";

const BASE = "http://localhost:4176";

test.describe("Cloudflare Workers Hydration", () => {
  // The consoleErrors fixture automatically fails tests if any console errors occur.
  // This catches React hydration mismatches (error #418), runtime errors, etc.

  test("client component hydrates and becomes interactive", async ({ page, consoleErrors }) => {
    await page.goto(`${BASE}/`);

    // SSR should show initial count
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 0");

    // After hydration, clicking should work
    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 2");

    void consoleErrors;
  });

  test("preinitializes bootstrap dependencies while executing one body bootstrap", async ({
    page,
    consoleErrors,
  }) => {
    const scriptResponses = new Map<string, number[]>();
    page.on("response", (response) => {
      if (response.request().resourceType() !== "script") return;
      const pathname = new URL(response.url()).pathname;
      const statuses = scriptResponses.get(pathname) ?? [];
      statuses.push(response.status());
      scriptResponses.set(pathname, statuses);
    });

    await page.goto(`${BASE}/`);

    const preinitScripts = page.locator('head script[async][type="module"][src]');
    await expect(preinitScripts).not.toHaveCount(0);
    const preinitSources = await preinitScripts.evaluateAll((scripts) =>
      scripts.map((script) => script.getAttribute("src")).filter((src): src is string => !!src),
    );

    const bootstrapScripts = page.locator('body script#_R_[type="module"][src]');
    await expect(bootstrapScripts).toHaveCount(1);
    const bootstrapSource = await bootstrapScripts.getAttribute("src");
    expect(bootstrapSource).toBeTruthy();
    expect(preinitSources).not.toContain(bootstrapSource);

    for (const source of [...preinitSources, bootstrapSource!]) {
      const pathname = new URL(source, BASE).pathname;
      await expect.poll(() => scriptResponses.get(pathname)).toEqual([200]);
    }

    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    void consoleErrors;
  });

  test("applies the CSP nonce to preinit and bootstrap scripts", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE}/?csp-nonce=1`);
    expect(response?.headers()["content-security-policy"]).toContain(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const preinitScripts = page.locator('head script[async][type="module"][src]');
    await expect(preinitScripts).not.toHaveCount(0);
    for (const script of await preinitScripts.all()) {
      expect(await script.evaluate((element) => (element as HTMLScriptElement).nonce)).toBe(
        "vinext-test-nonce",
      );
    }

    const bootstrapScript = page.locator('body script#_R_[type="module"][src]');
    await expect(bootstrapScript).toHaveCount(1);
    expect(await bootstrapScript.evaluate((element) => (element as HTMLScriptElement).nonce)).toBe(
      "vinext-test-nonce",
    );

    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    void consoleErrors;
  });

  // Regression test for https://github.com/cloudflare/vinext/issues/695
  // createFromReadableStream was awaited before hydrateRoot, blocking effects.
  test("useEffect fires after RSC hydration", async ({ page, consoleErrors }) => {
    await page.goto(`${BASE}/effect-test`);

    // useEffect should fire and update the status from "effect-pending" to "effect-fired"
    await expect(page.locator('[data-testid="effect-status"]')).toHaveText("effect-fired", {
      timeout: 10_000,
    });

    void consoleErrors;
  });

  test("page with timestamp hydrates without mismatch", async ({ page, consoleErrors }) => {
    // This test specifically verifies the fix for GitHub issue #61.
    // The home page has a timestamp that would cause hydration mismatch
    // if the browser fetched a new RSC payload instead of using embedded data.
    await page.goto(`${BASE}/`);

    // Wait for the client JS bundle to load and hydrate
    await page.waitForFunction(() => document.querySelector('[data-testid="increment"]') !== null);

    // Verify hydration completes and component becomes interactive
    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    // The timestamp element should exist and have content
    await expect(page.locator('[data-testid="timestamp"]')).toContainText("Rendered at:");

    // consoleErrors fixture will fail this test if any hydration errors occurred
    void consoleErrors;
  });
});
