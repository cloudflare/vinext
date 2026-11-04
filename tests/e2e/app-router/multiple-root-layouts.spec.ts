import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";
import {
  startChildViteDevServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";

// Like Next.js, navigating to a page under another root layout loads a new
// document, also when a server action redirects there.
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/root-layout/root-layout.test.ts
test.setTimeout(60_000);

let server: ChildProductionServer | null = null;
let cacheDir = "";
let baseUrl = "";

test.beforeAll(async () => {
  // The app-router project's dev server serves app-basic, so this fixture gets
  // its own server. Prebundled deps resolve bare imports from the cache's
  // location, so it stays inside the fixture's node_modules.
  const fixtureRoot = path.resolve("tests/fixtures/app-multiple-root-layouts");
  cacheDir = await fs.mkdtemp(path.join(fixtureRoot, "node_modules", ".vite-e2e-"));
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

for (const entry of ["/pin", "/"] as const) {
  // Middleware rewrites / to /pin until the pin cookie is set, so entering at
  // / renders the (pin) root layout at the (site) root layout's URL.
  test(`a server action redirect from ${entry} to another root layout loads a new document`, async ({
    page,
  }) => {
    await page.goto(`${baseUrl}${entry}`);
    await expect(page.locator("body#pin-root")).toBeVisible();
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      Reflect.set(window, "__pinDocument", true);
    });

    await page.click("#submit-pin");

    await expect(page.locator("#home")).toHaveText("2. Home", { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await page.evaluate(() => Reflect.get(window, "__pinDocument"))).toBeUndefined();
    await expect(page.locator("body#pin-root")).toHaveCount(0);
    expect(
      await page
        .locator("body#site-root > :not(script)")
        .evaluateAll((elements) => elements.map((element) => element.localName)),
    ).toEqual(["header", "main", "footer"]);
  });
}
