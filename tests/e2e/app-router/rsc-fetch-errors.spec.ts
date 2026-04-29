/**
 * RSC fetch error handling tests.
 *
 * Verifies that when an RSC navigation fetch returns a non-ok response (404,
 * 500), the client performs a clean hard navigation to the destination URL
 * rather than trying to parse the HTML error body as an RSC stream.
 *
 * Without the fix:
 *   - fetch(url.rsc) returns 404 HTML
 *   - createFromFetch throws a cryptic stream-parse error
 *   - The catch block logs "[vinext] RSC navigation error: ..." and hard-navs
 *     to the same URL again, which can loop
 *
 * With the fix:
 *   - !response.ok is detected immediately after fetch
 *   - Client hard-navigates directly to the destination URL (no .rsc suffix)
 *   - No stream-parse error is logged
 *
 * Ported behavior from Next.js fetch-server-response.ts:211:
 *   if (!isFlightResponse || !res.ok || !res.body) {
 *     return doMpaNavigation(responseUrl.toString())
 *   }
 */
import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

// Stream-parse errors thrown by createFromFetch / createFromReadableStream
// when handed a non-RSC payload (HTML error body, wrong content-type, empty
// stream). The pre-fix failure path produces one of these diagnostics; the
// filter here stays narrow on purpose so unrelated console errors (hydration
// timing, third-party scripts, JSON.parse in fixture code) never
// false-positive. Generic strings ("Connection closed", "Unexpected token")
// are gated on an RSC-context co-marker so a benign third-party JSON.parse
// diagnostic cannot satisfy them.
function isRscStreamParseError(msg: string): boolean {
  const hasRscContext = msg.includes("RSC") || msg.includes("vinext");
  return (
    msg.includes("createFromFetch") ||
    msg.includes("createFromReadableStream") ||
    msg.includes("Failed to parse RSC") ||
    (hasRscContext && msg.includes("Connection closed")) ||
    (hasRscContext && msg.includes("Unexpected token"))
  );
}

test.describe("RSC fetch non-ok response handling", () => {
  test("client navigation to a non-existent route hard-navs to the non-.rsc URL", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);

    // Trigger RSC navigation to a route that does not exist (returns 404 HTML).
    // We need to wait for the hard navigation, so we listen for the URL to change.
    const navigationPromise = page.waitForURL(`${BASE}/this-route-does-not-exist`, {
      timeout: 10_000,
    });
    await Promise.all([navigationPromise, page.getByTestId("missing-route-link").click()]);

    // The browser must land on the non-.rsc URL — never on the .rsc variant.
    expect(page.url()).toBe(`${BASE}/this-route-does-not-exist`);

    // The bug this PR fixes surfaces as one of a small set of RSC-stream
    // parse errors when createFromFetch is handed an HTML body. Match only
    // those diagnostics so an unrelated console error (e.g. a hydration-
    // timing race that pre-existed this PR) does not false-positive here.
    const rscParseError = consoleErrors.find((msg) => isRscStreamParseError(msg));
    expect(rscParseError).toBeUndefined();
  });

  test("client navigation to a 500-route hard-navs to the destination URL without looping", async ({
    page,
  }) => {
    const targetPath = "/rsc-fetch-error-target";

    // Intercept the .rsc request for a dedicated unlinked fixture page and
    // return a 500 error. Using an unlinked target keeps the hit count tied to
    // the explicit navigation below instead of racing home-page Link prefetch.
    // intercept persists across navigations and reloads on this page, so if
    // the fix is incomplete and a reload loop develops, the intercept hit
    // count will grow without bound.
    let targetRscHits = 0;
    await page.route(/\/rsc-fetch-error-target\.rsc(\?|$)/, (route) => {
      targetRscHits += 1;
      return route.fulfill({
        status: 500,
        // status 500 + text/html exercises both the !ok guard and the
        // content-type guard at the nav site; editing either value in
        // isolation drops the combined-guard coverage this test targets.
        contentType: "text/html",
        body: "<html><body><h1>Internal Server Error</h1></body></html>",
      });
    });

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);

    const navigationPromise = page.waitForURL(`${BASE}${targetPath}`, { timeout: 10_000 });
    await page.evaluate(() => {
      void (window as any).__VINEXT_RSC_NAVIGATE__("/rsc-fetch-error-target");
    });
    await navigationPromise;

    expect(page.url()).toBe(`${BASE}${targetPath}`);

    // Stability check: the hard-nav must settle. Without the
    // readInitialRscStream reload-loop guard, the initial RSC fetch on the
    // freshly-loaded target page hits the intercepted 500 and reloads
    // indefinitely — networkidle would never fire and the default timeout
    // catches that. Tracking actual request activity avoids flaky wall-clock
    // waits in CI.
    const hitsBeforeNetworkIdle = targetRscHits;
    await page.waitForLoadState("networkidle");
    expect(page.url()).toBe(`${BASE}${targetPath}`);
    // Pin the embedded-RSC assumption: after the hard-nav lands on the target,
    // hydration must come from the HTML-embedded RSC branch and issue no
    // further .rsc fetches. If a future change makes the embed path
    // conditional and falls back to a fetch, this count would grow and the
    // test would flag it rather than silently relying on networkidle timing.
    expect(targetRscHits).toBe(hitsBeforeNetworkIdle);

    // Expected trajectory: exactly one hit from the client RSC nav fetch that
    // triggers the hard-nav. The target route is intentionally absent from the
    // home page's visible Links, so a count of 0 means the test skipped the
    // !ok guard path, while a count above 1 means hydration fell back to a
    // post-reload .rsc fetch or entered a reload loop.
    expect(targetRscHits).toBe(1);

    const rscParseError = consoleErrors.find((msg) => isRscStreamParseError(msg));
    expect(rscParseError).toBeUndefined();
  });

  test("redirect chain to a non-ok endpoint hard-navs to the post-redirect URL", async ({
    page,
  }) => {
    const sourcePath = "/rsc-fetch-redirect-src";
    const targetPath = "/rsc-fetch-error-target";

    // Chain: client nav to /rsc-fetch-redirect-src → fetch
    // /rsc-fetch-redirect-src.rsc → real server redirect to
    // /rsc-fetch-error-target.rsc → 500. The hard-nav target must be
    // /rsc-fetch-error-target (the post-redirect URL), not
    // /rsc-fetch-redirect-src (the original request).
    // Without the navResponseUrl ?? navResponse.url branch in the nav-site
    // guard, the browser would bounce off the source path and the server
    // would re-issue the 307, flashing the wrong URL in the address bar
    // and mis-keying analytics.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Capture the document URL at every main-frame navigation so we can
    // assert the address bar never flashes the source URL en route to the target.
    // Without this, a regression that dropped `navResponseUrl ?? navResponse.url`
    // would still pass because the server's 307 converges to the target eventually.
    const frameUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) frameUrls.push(frame.url());
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);

    const sourceRedirectPromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${sourcePath}.rsc` && response.status() === 307,
      { timeout: 10_000 },
    );
    const targetErrorPromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${targetPath}.rsc` && response.status() === 500,
      { timeout: 10_000 },
    );
    const navigationPromise = page.waitForURL(`${BASE}${targetPath}`, { timeout: 10_000 });
    await Promise.all([
      sourceRedirectPromise,
      targetErrorPromise,
      navigationPromise,
      page.getByTestId("rsc-fetch-redirect-src-link").click(),
    ]);

    expect(page.url()).toBe(`${BASE}${targetPath}`);
    await expect(page.getByRole("heading", { name: "RSC fetch error target" })).toBeVisible();
    expect(frameUrls.some((url) => url.includes(sourcePath))).toBe(false);

    const rscParseError = consoleErrors.find((msg) => isRscStreamParseError(msg));
    expect(rscParseError).toBeUndefined();
  });
});
