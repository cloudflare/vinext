import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";
import {
  startChildViteDevServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../../production-server";

const SOURCE_PATH = "/nextjs-compat/mpa-fallback-redirect";
const TARGET_PATH = "/nextjs-compat/mpa-fallback-redirect/login";

// Next.js treats a failed or non-Flight RSC fetch as an MPA navigation: the
// router loads the URL as a document once and suspends the tree until the
// document unloads, so a RedirectBoundary that re-renders a committed
// redirect() cannot start another RSC request that races the document load.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router.tsx
test.setTimeout(60_000);

let server: ChildProductionServer | null = null;
let cacheDir = "";
let baseUrl = "";

test.beforeAll(async () => {
  // The app-router project's dev server also serves app-basic, so this one
  // keeps its own optimizer cache. Prebundled deps resolve bare imports from
  // the cache's location, so it stays inside the fixture's node_modules.
  const fixtureRoot = path.resolve("tests/fixtures/app-basic");
  cacheDir = await fs.mkdtemp(path.join(fixtureRoot, "node_modules", ".vite-mpa-fallback-"));
  server = await startChildViteDevServer(fixtureRoot, { cacheDir });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => {
  try {
    if (server) await stopChildProductionServer(server);
  } finally {
    if (cacheDir) await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

for (const mode of ["first-aborts", "all-503"] as const) {
  test(`a page redirect whose RSC fetch fails loads the target once (${mode})`, async ({
    page,
  }) => {
    await page.goto(`${baseUrl}${SOURCE_PATH}`);
    await waitForAppRouterHydration(page);

    let targetRscReads = 0;
    await page.route(/[?&]_rsc=/, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== TARGET_PATH) return route.continue();
      targetRscReads++;
      if (mode === "all-503") return route.fulfill({ status: 503, body: "" });
      if (targetRscReads === 1) return route.abort("failed");
      return route.continue();
    });

    let rscRequests = 0;
    let targetDocumentRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.searchParams.has("_rsc")) rscRequests++;
      if (request.isNavigationRequest() && url.pathname === TARGET_PATH) targetDocumentRequests++;
    });
    const historyLength = await page.evaluate(() => window.history.length);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#mpa-fallback-login")).toHaveText("login", { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe(TARGET_PATH);

    // Give a looping RedirectBoundary time to show up as extra requests.
    await page.waitForTimeout(2_000);
    expect(targetRscReads).toBe(1);
    // The source's refresh and the target's failed read, as in a Next.js
    // production build (dev's StrictMode runs the boundary's effect twice).
    expect(rscRequests).toBe(2);
    expect(targetDocumentRequests).toBe(1);
    // The boundary follows the redirect with router.replace, so the document
    // load replaces the entry instead of pushing one.
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  });
}

// A Pages Router target loads as a document. vinext knows the route is a Pages
// route from its route manifest; Next.js reaches the same MPA state because the
// target's RSC request answers with HTML.
test("a page redirect to a Pages Router route loads the target once", async ({ page }) => {
  await page.goto(`${baseUrl}${SOURCE_PATH}/to-pages`);
  await waitForAppRouterHydration(page);

  let targetDocumentRequests = 0;
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    if (new URL(request.url()).pathname === "/old-school") targetDocumentRequests++;
  });

  const historyLength = await page.evaluate(() => window.history.length);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("h1")).toHaveText("Old School Pages Directory", { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  expect(targetDocumentRequests).toBe(1);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});

test("a pushed navigation whose RSC fetch fails adds a history entry", async ({ page }) => {
  await page.goto(`${baseUrl}${SOURCE_PATH}/restore`);
  await waitForAppRouterHydration(page);

  await page.route(/[?&]_rsc=/, (route) => {
    if (new URL(route.request().url()).pathname !== TARGET_PATH) return route.continue();
    return route.fulfill({ status: 503, body: "" });
  });
  const historyLength = await page.evaluate(() => window.history.length);

  await page.getByRole("link", { name: "Login" }).click();
  await expect(page.locator("#mpa-fallback-login")).toHaveText("login", { timeout: 10_000 });
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1);
});

// Next.js loads a URL once until a bfcache restore (app-router.tsx's
// pendingMpaPath), so a later replace() to the same URL doesn't restart it.
test("a later navigation to a URL already loading as a document is ignored", async ({ page }) => {
  await page.goto(`${baseUrl}${SOURCE_PATH}/restore`);
  await waitForAppRouterHydration(page);

  let targetRscReads = 0;
  await page.route(
    (url) => url.pathname === TARGET_PATH,
    (route) => {
      if (route.request().isNavigationRequest()) return route.fulfill({ status: 204 });
      targetRscReads++;
      return route.fulfill({ status: 503, body: "" });
    },
  );
  let targetDocumentRequests = 0;
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    if (new URL(request.url()).pathname === TARGET_PATH) targetDocumentRequests++;
  });
  const historyLength = await page.evaluate(() => window.history.length);

  await page.getByRole("link", { name: "Login" }).click();
  await expect.poll(() => targetDocumentRequests).toBe(1);
  await page.getByRole("button", { name: "Replace" }).click();
  // The replace reaches the router and fails over to a document load too.
  await expect.poll(() => targetRscReads).toBe(2);
  await page.waitForTimeout(1_000);
  expect(targetDocumentRequests).toBe(1);
  // The 204 leaves this document in place, so history is untouched too.
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});

// Next.js keeps only the navigation's transition suspended until the document
// unloads (app-router.tsx: "useTransition isPending should stay true until the
// page unloads"); other updates keep rendering. vinext covers the external-URL
// case in navigation.spec.ts, ported from test/e2e/app-dir/navigation.
test("a transition whose RSC fetch fails stays pending during the document load", async ({
  page,
}) => {
  await page.goto(`${baseUrl}${SOURCE_PATH}/restore`);
  await waitForAppRouterHydration(page);

  // A 204 keeps this document alive so its state can be read afterwards.
  await page.route(
    (url) => url.pathname === TARGET_PATH,
    (route) => {
      if (route.request().isNavigationRequest()) return route.fulfill({ status: 204 });
      return route.fulfill({ status: 503, body: "" });
    },
  );
  let targetDocumentRequests = 0;
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    if (new URL(request.url()).pathname === TARGET_PATH) targetDocumentRequests++;
  });

  await page.getByRole("button", { name: "Start ticking" }).click();
  await expect(page.locator("#mpa-restore-tick")).not.toHaveText("0");
  await page.getByRole("button", { name: "Push in transition" }).click();
  await expect.poll(() => targetDocumentRequests).toBe(1);
  await page.waitForTimeout(1_000);
  await expect(page.locator("#mpa-restore-pending")).toHaveText("true");
  await expect(page.locator("#mpa-restore-pushed")).toHaveText("false");
  const tick = Number(await page.locator("#mpa-restore-tick").textContent());
  await expect
    .poll(async () => Number(await page.locator("#mpa-restore-tick").textContent()))
    .toBeGreaterThan(tick);
});

// Adapted from Next.js's bfcache-routing test (ported below) for a hard
// navigation after a failed RSC fetch. Next's test needs a headed browser for
// a real bfcache restore. Answering the document load with 204 keeps this
// document alive, and a persisted pagehide/pageshow pair stands in for the
// restore.
test("a document restored after a hard navigation renders and navigates again", async ({
  page,
}) => {
  await page.goto(`${baseUrl}${SOURCE_PATH}/restore`);
  await waitForAppRouterHydration(page);

  await page.route(
    (url) => url.pathname === TARGET_PATH,
    (route) => {
      if (route.request().isNavigationRequest()) return route.fulfill({ status: 204 });
      return route.fulfill({ status: 503, body: "" });
    },
  );
  let targetDocumentRequests = 0;
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    if (new URL(request.url()).pathname === TARGET_PATH) targetDocumentRequests++;
  });

  await page.getByRole("link", { name: "Login" }).click();
  await expect.poll(() => targetDocumentRequests).toBe(1);
  await expect(page.locator("#mpa-restore-link-pending")).toHaveText("true");

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  // Restoring finishes the navigation's transition, as Next.js's ACTION_RESTORE does.
  await expect(page.locator("#mpa-restore-link-pending")).toHaveText("false");
  await page.getByRole("button", { name: "Trigger re-render" }).click();
  await expect(page.locator("#mpa-restore-count")).toHaveText("1");
  await page.waitForTimeout(1_000);
  expect(targetDocumentRequests).toBe(1);
  expect(new URL(page.url()).pathname).toBe(`${SOURCE_PATH}/restore`);

  // The restored router can start the same hard navigation again.
  await page.getByRole("link", { name: "Login" }).click();
  await expect.poll(() => targetDocumentRequests).toBe(2);
});

// Ported from Next.js: test/production/bfcache-routing/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/production/bfcache-routing/index.test.ts
// As above, a 204 and a synthetic pagehide/pageshow pair stand in for the
// headed browser's real bfcache restore.
test("a document restored after an external navigation stays put", async ({ page }) => {
  await page.goto(`${baseUrl}${SOURCE_PATH}/restore`);
  await waitForAppRouterHydration(page);

  await page.route(
    (url) => url.hostname === "external.example",
    (route) => route.fulfill({ status: 204 }),
  );
  let externalDocumentRequests = 0;
  page.on("request", (request) => {
    if (!request.isNavigationRequest()) return;
    if (new URL(request.url()).hostname === "external.example") externalDocumentRequests++;
  });

  await page.getByRole("button", { name: "Push external" }).click();
  await expect.poll(() => externalDocumentRequests).toBe(1);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await page.getByRole("button", { name: "Trigger re-render" }).click();
  await expect(page.locator("#mpa-restore-count")).toHaveText("1");
  await page.waitForTimeout(1_000);
  expect(externalDocumentRequests).toBe(1);

  await page.getByRole("button", { name: "Push external" }).click();
  await expect.poll(() => externalDocumentRequests).toBe(2);
});
