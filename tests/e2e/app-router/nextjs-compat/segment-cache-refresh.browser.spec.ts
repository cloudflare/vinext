import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/segment-cache-refresh";

type RscResponseRecord = {
  body: string | null;
  pathname: string;
  settled: boolean;
};

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: Server;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function buildAndServeFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-segment-cache-refresh-"));
  const sourceRoot = path.resolve(process.cwd(), "tests/fixtures/app-bfcache");
  const sourceNodeModules = path.join(sourceRoot, "node_modules");
  await fs.cp(sourceRoot, fixtureRoot, {
    recursive: true,
    filter: (source) =>
      source !== sourceNodeModules && !source.startsWith(`${sourceNodeModules}${path.sep}`),
  });
  await fs.symlink(sourceNodeModules, path.join(fixtureRoot, "node_modules"), "junction");

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });

  return { baseUrl: `http://127.0.0.1:${started.port}`, fixtureRoot, server: started.server };
}

function trackRscResponses(page: Page): RscResponseRecord[] {
  const responses: RscResponseRecord[] = [];
  const recordsByRequest = new WeakMap<object, RscResponseRecord>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc") || request.headers()["rsc"] !== "1") return;
    const record: RscResponseRecord = { body: null, pathname: url.pathname, settled: false };
    recordsByRequest.set(request, record);
    responses.push(record);
  });
  page.on("response", async (response) => {
    const record = recordsByRequest.get(response.request());
    if (!record) return;
    try {
      record.body = await response.text();
    } catch {
      // An aborted response has no body to read.
    }
    record.settled = true;
  });
  page.on("requestfailed", (request) => {
    const record = recordsByRequest.get(request);
    if (record) record.settled = true;
  });
  return responses;
}

test.setTimeout(120_000);

test.describe("Next.js compat: segment-cache refresh", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/refresh/segment-cache-refresh.test.ts
  test("Server Action refresh() refreshes dynamic data only, not cached", async ({ page }) => {
    const app = await buildAndServeFixture();

    try {
      const responses = trackRscResponses(page);
      await page.goto(`${app.baseUrl}${ROOT}`);
      await waitForAppRouterHydration(page);
      const initialRender = await page.locator("#dynamic-render").textContent();

      // Reveal the link to the docs page to prefetch it.
      await page.locator(`input[data-link-accordion="${ROOT}/docs"]`).click();
      await expect
        .poll(() =>
          responses.some(
            (response) =>
              response.pathname === `${ROOT}/docs` &&
              response.body?.includes("Static docs page") === true,
          ),
        )
        .toBe(true);
      await expect.poll(() => responses.every((response) => response.settled)).toBe(true);

      // The server form of refresh() re-renders the dynamic data on the page
      // but does not purge cached data, so the docs page is not prefetched
      // again.
      const beforeAction = responses.length;
      await page.locator("#server-refresh-button").click();
      await expect(page.locator("#dynamic-render")).not.toHaveText(initialRender ?? "");
      // Allow for the revalidation cooldown and the prefetch queue.
      await page.waitForTimeout(1_000);
      expect(
        responses.slice(beforeAction).filter((response) => response.pathname === `${ROOT}/docs`),
      ).toEqual([]);

      // Navigating to the docs page needs no additional requests.
      const beforeNavigation = responses.length;
      await page.locator(`a[href="${ROOT}/docs"]`).click();
      await expect(page.locator("#docs-page:visible")).toHaveText("Static docs page");
      expect(responses.slice(beforeNavigation)).toEqual([]);
    } finally {
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
