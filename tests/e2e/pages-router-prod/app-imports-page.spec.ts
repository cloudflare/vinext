import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// What `_app` adds to every page when one of its imports imports a page, on
// tests/fixtures/pages-app-imports-page. Next.js loads `pages/_app` and what it
// imports as one chunk and one stylesheet, a page module included:
// packages/next/src/build/webpack-config.ts (`splitChunks`)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack-config.ts
// Real Next.js 16.2.7 (webpack) meets the expectations below on this fixture.

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/pages-app-imports-page");

let fixtureRoot: string;
let server: Server;
let baseUrl: string;

async function closeServer(target: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => target.close(() => resolve()));
  target.closeIdleConnections();
  target.closeAllConnections();
  await closed;
}

test.setTimeout(60_000);

test.beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-app-imports-page-"));
  await fs.cp(fixtureSource, fixtureRoot, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"type":"module"}\n');
  await fs.symlink(
    path.resolve(process.cwd(), "tests/fixtures/pages-basic/node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );

  const { createBuilder } = await import("vite-plus");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.mts"),
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
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

test.afterAll(async () => {
  if (server) await closeServer(server);
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

/** The JavaScript files that a full load of `route` downloads, by file name. */
async function loadScripts(page: Page, route: string): Promise<Map<string, string>> {
  const responses: Promise<[string, string]>[] = [];
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (!pathname.endsWith(".js")) return;
    responses.push(response.text().then((code) => [path.posix.basename(pathname), code]));
  });
  await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  return new Map(await Promise.all(responses));
}

/** The names of the downloaded files whose code holds `marker`, a string the fixture's source renders. */
function filesWith(scripts: Map<string, string>, marker: string): string[] {
  return Array.from(scripts)
    .filter(([, code]) => code.includes(marker))
    .map(([file]) => file)
    .sort();
}

test("_app's imports load with _app when one of them imports a page", async ({ page }) => {
  // `/` imports nothing that `_app` or another page uses.
  const scripts = await loadScripts(page, "/");
  await expect(page.locator('[data-page="home"]')).toBeVisible();

  // `_app` imports a frame and an error boundary. The boundary imports
  // `pages/500` to show it when a page throws, and that page renders a panel
  // with a table that `/help` also imports.
  const [appChunk] = filesWith(scripts, "marker-app");
  const [importsChunk] = filesWith(scripts, "marker-site-frame");
  expect(appChunk).toBeDefined();
  expect(importsChunk).toBeDefined();

  // Every page loads the boundary and what it imports, so they add no chunk
  // to `_app`'s own and the one that holds its other imports. The panel and
  // its table each get a chunk instead.
  const boundaryChunks = [
    ...filesWith(scripts, "marker-error-boundary"),
    ...filesWith(scripts, "marker-error-panel"),
    ...filesWith(scripts, "marker-help-links"),
  ];
  expect
    .soft(Array.from(new Set([appChunk, importsChunk, ...boundaryChunks])).sort())
    .toEqual([appChunk, importsChunk].sort());

  // The same goes for their CSS modules: the frame's and the panel's are both
  // `_app`'s, in one stylesheet.
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
});
