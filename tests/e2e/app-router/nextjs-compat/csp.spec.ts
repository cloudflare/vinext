/**
 * Next.js Compat E2E: CSP nonce
 *
 * Ported from:
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
 */

import { test, expect } from "../../fixtures";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

// NOTE: this project runs the DEV server (`vp dev`). `next/dynamic` preload
// <link> tags are a PRODUCTION-only feature — they are emitted from the client
// build manifest (the Pages client asset descriptor), which dev never
// populates. So these browser tests verify the runtime CONSEQUENCE that matters
// (the boundary hydrates under `script-src 'nonce-…' 'strict-dynamic'` with no
// CSP console violations) — NOT the presence/nonce of preload links. The
// nonce-on-preload assertions live in tests/app-router-production-server.test.ts,
// which runs against a real production build.
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

  test("next/dynamic (client call site) hydrates cleanly under a CSP nonce with no violations", async ({
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
  // lazy-loads a client widget. In DEV (this project) no preload <link> is
  // emitted, so this verifies only that the lazy chunk loads under
  // `strict-dynamic` and the boundary hydrates with no CSP console violation.
  // The nonce-on-preload assertion for this exact route lives in the prod-server
  // Vitest suite (tests/app-router-production-server.test.ts).
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
