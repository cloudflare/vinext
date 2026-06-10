/**
 * Next.js Compat E2E: CSP nonce
 *
 * Ported from:
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
 */

import { test, expect } from "../../fixtures";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: CSP nonce (browser)", () => {
  test("page bootstraps successfully when middleware adds a CSP nonce", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE}/use-client-page-pathname?csp-nonce=1`);

    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    await waitForAppRouterHydration(page);
    await expect(page.locator("#client-page-pathname")).toHaveText("/use-client-page-pathname");
    expect(consoleErrors.filter((message) => message.includes("Content Security Policy"))).toEqual(
      [],
    );
  });

  test("next/dynamic preloads carry the middleware nonce and hydrate cleanly", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/dynamic?csp-nonce=1`);

    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    await waitForAppRouterHydration(page);
    await expect(page.locator("#css-text-dynamic-client")).toContainText(
      "next-dynamic dynamic on client",
    );
    expect(consoleErrors.filter((message) => message.includes("Content Security Policy"))).toEqual(
      [],
    );
  });

  // Server Component call site: dynamic() is called from a pure RSC page that
  // lazy-loads a client widget. The dynamic preload component must render in the
  // SSR pass (it is "use client") so the nonce is applied; the lazy chunk then
  // loads under `strict-dynamic` and hydrates without a CSP violation.
  test("next/dynamic from a Server Component call site hydrates cleanly under a CSP nonce", async ({
    page,
    consoleErrors,
  }) => {
    const response = await page.goto(
      `${BASE}/nextjs-compat/dynamic/rsc-imports-client?csp-nonce=1`,
    );

    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    await waitForAppRouterHydration(page);
    await expect(page.locator("#rsc-imports-client-widget")).toContainText(
      "next-dynamic dynamic client from server",
    );
    expect(consoleErrors.filter((message) => message.includes("Content Security Policy"))).toEqual(
      [],
    );
  });
});
