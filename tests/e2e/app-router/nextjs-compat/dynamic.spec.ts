/**
 * Next.js Compat E2E: next/dynamic
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts
 *
 * Browser-level tests for next/dynamic behavior:
 * - ssr:false components appear after hydration
 * - React.lazy and dynamic() components are interactive after hydration
 * - Named exports work after hydration
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: next/dynamic (browser)", () => {
  // Next.js: 'should handle next/dynamic in hydration correctly'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts#L29-L36
  //
  // After hydration, the ssr:false component should appear in the DOM.
  test("ssr:false component appears after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic`);
    await waitForHydration(page);

    // The ssr:false component should now be visible after client-side rendering
    await expect(async () => {
      const text = await page.locator("#css-text-dynamic-no-ssr-client").textContent();
      expect(text).toContain("next-dynamic dynamic no ssr on client");
    }).toPass({ timeout: 10_000 });
  });

  // Verify SSR-rendered dynamic components are still present after hydration
  test("dynamic() components remain visible after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic`);
    await waitForHydration(page);

    await expect(page.locator("#css-text-lazy")).toContainText("next-dynamic lazy");
    await expect(page.locator("#css-text-dynamic-server")).toContainText(
      "next-dynamic dynamic on server",
    );
    await expect(page.locator("#css-text-dynamic-client")).toContainText(
      "next-dynamic dynamic on client",
    );
    await expect(page.locator("#text-dynamic-server-import-client")).toContainText(
      "next-dynamic server import client",
    );
  });

  // Next.js: 'should support dynamic import with accessing named exports'
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic/dynamic.test.ts#L97-L100
  test("named export via dynamic() renders button after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic/named-export`);
    await waitForHydration(page);

    await expect(page.locator("#client-button")).toHaveText("this is a client button");
  });

  // ssr:false dedicated page — static content present, dynamic appears after hydration
  test("ssr:false page shows dynamic content after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic/ssr-false-only`);

    // Static content should be present immediately
    await expect(page.locator("#static-text")).toHaveText("This is static content");

    await waitForHydration(page);

    // After hydration, the ssr:false component should appear
    await expect(async () => {
      const text = await page.locator("#css-text-dynamic-no-ssr-client").textContent();
      expect(text).toContain("next-dynamic dynamic no ssr on client");
    }).toPass({ timeout: 10_000 });
  });

  // ssr:false from a server component — the dynamic shim must be a client
  // module so the RSC serializer emits a client reference instead of
  // executing dynamic() inline and sending null to the client.
  test("ssr:false from server component loads after hydration", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/dynamic/ssr-false-server`);

    // Server-rendered static content should be present immediately
    await expect(page.locator("#server-text")).toHaveText("Server rendered");

    await waitForHydration(page);

    // After hydration, the ssr:false component should appear
    await expect(async () => {
      const text = await page.locator("#css-text-dynamic-no-ssr-client").textContent();
      expect(text).toContain("next-dynamic dynamic no ssr on client");
    }).toPass({ timeout: 10_000 });
  });
});
