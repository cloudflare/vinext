import type { Page, Request } from "@playwright/test";
import { expect } from "@playwright/test";

const SERVER_READY_TIMEOUT = 30_000;
const SERVER_READY_POLL_INTERVAL = 300;
const SERVER_READY_REQUEST_TIMEOUT = 2_000;

/**
 * Poll the local server until it responds or the timeout is reached.
 * Used when a test manages its own server lifecycle outside of Playwright's
 * webServer config, which is the case for tests that build and serve a
 * temporary fixture inline.
 */
export async function waitForServer(baseUrl: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < SERVER_READY_TIMEOUT) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SERVER_READY_REQUEST_TIMEOUT);
      const response = await fetch(baseUrl, {
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timer);
      await response.text();
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, SERVER_READY_POLL_INTERVAL));
    }
  }
  throw new Error(`Server at ${baseUrl} failed to start within ${SERVER_READY_TIMEOUT / 1000}s`);
}

export function isAppRouterRscRequestForPath(request: Request, pathname: string): boolean {
  const url = new URL(request.url());
  return (
    url.pathname === pathname && url.searchParams.has("_rsc") && request.headers()["rsc"] === "1"
  );
}

export function isAppRouterServerActionRequestForPath(request: Request, pathname: string): boolean {
  const url = new URL(request.url());
  return (
    request.method() === "POST" &&
    url.pathname === pathname &&
    request.headers()["next-action"] !== undefined
  );
}

/**
 * Wait for Pages Router hydration to complete.
 * Checks for window.__VINEXT_ROOT__.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__VINEXT_ROOT__));
}

/**
 * Wait for App Router (RSC) hydration to complete.
 * Checks for window.__VINEXT_RSC_ROOT__.
 *
 * Uses expect().toPass() for better error messages on timeout.
 * 10 second timeout matches Next.js hydration expectations.
 */
export async function waitForAppRouterHydration(page: Page): Promise<void> {
  await expect(async () => {
    const ready = await page.evaluate(() => {
      const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime"));
      const hasNavigate =
        typeof runtime === "object" &&
        runtime !== null &&
        "functions" in runtime &&
        typeof runtime.functions === "object" &&
        runtime.functions !== null &&
        "navigate" in runtime.functions &&
        typeof runtime.functions.navigate === "function";
      return (
        Boolean(window.__VINEXT_RSC_ROOT__) &&
        hasNavigate &&
        typeof window.__VINEXT_HYDRATED_AT === "number"
      );
    });
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Hide both Vite's HMR error overlay and vinext's dev error overlay so their
 * modal backdrops don't intercept page clicks during tests that intentionally
 * trigger an error and then need to interact with the error.tsx fallback
 * (Try Again, navigate away, etc.).
 *
 * Best-effort — silently no-ops if the page isn't ready yet.
 */
export async function disableDevErrorOverlay(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content: `
        vite-error-overlay{display:none !important;pointer-events:none !important;}
        #__vinext_dev_error_overlay_root{display:none !important;pointer-events:none !important;}
      `,
    })
    .catch(() => {
      // best effort
    });
}
