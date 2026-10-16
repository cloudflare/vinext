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
let baseUrl = "";

test.beforeAll(async () => {
  server = await startChildViteDevServer(path.resolve("tests/fixtures/app-basic"));
  baseUrl = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => {
  if (server) await stopChildProductionServer(server);
});

for (const mode of ["first-aborts", "all-503"] as const) {
  test(`a page redirect whose RSC fetch fails loads the target once (${mode})`, async ({
    page,
  }) => {
    await page.context().clearCookies();
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

    let targetDocumentRequests = 0;
    page.on("request", (request) => {
      if (!request.isNavigationRequest()) return;
      if (new URL(request.url()).pathname === TARGET_PATH) targetDocumentRequests++;
    });

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator("#mpa-fallback-login")).toHaveText("login", { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe(TARGET_PATH);

    // Give a looping RedirectBoundary time to show up as extra requests.
    await page.waitForTimeout(2_000);
    expect(targetRscReads).toBe(1);
    expect(targetDocumentRequests).toBe(1);
  });
}
