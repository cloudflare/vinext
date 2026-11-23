import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// What a Pages Router production page downloads, on
// tests/fixtures/pages-client-chunk-requests. Next.js loads `pages/_app` and
// what it imports as one chunk, and its webpack `splitChunks` gives a page one
// copy of each module, whichever of the page's chunks need it:
// packages/next/src/build/webpack-config.ts (`splitChunks`)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack-config.ts
// Real Next.js 16.2.7 (webpack) meets every expectation below on this fixture.

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/pages-client-chunk-requests");

const RED = "rgb(255, 0, 0)";
const BLUE = "rgb(0, 0, 255)";

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
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-client-chunk-requests-"));
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

test("_app's imports load as one chunk when an unused export of a side-effect-free package uses import()", async ({
  page,
}) => {
  // `/` imports nothing that `_app` or another page uses.
  const scripts = await loadScripts(page, "/");
  await expect(page.locator('[data-page="home"]')).toBeVisible();

  // `_app` imports a frame, a footer and a header. The footer and the header
  // each use a table of their own that `/directory` also imports. `_app` keeps
  // a chunk of its own, and the frame, the footer and the footer's table share
  // the one other chunk that holds `_app`'s imports.
  const [appChunk] = filesWith(scripts, "marker-app");
  const [importsChunk] = filesWith(scripts, "marker-site-frame");
  expect(appChunk).toBeDefined();
  expect(importsChunk).toBeDefined();
  expect(filesWith(scripts, "marker-site-footer")).toEqual([importsChunk]);
  expect(filesWith(scripts, "marker-footer-links")).toEqual([importsChunk]);

  // The header also imports `formatTitle` from `vendor/toolkit`, a
  // side-effect-free barrel. Another export of that barrel, which nothing
  // imports, loads a module both statically and with `import()`. None of it is
  // in the build.
  expect(filesWith(scripts, "marker-toolkit-measure")).toEqual([]);

  // So the header and its table load in those two chunks too, and no other
  // chunk that every page downloads holds them.
  const headerChunks = [
    ...filesWith(scripts, "marker-site-header"),
    ...filesWith(scripts, "marker-nav-sections"),
  ];
  expect(Array.from(new Set([appChunk, importsChunk, ...headerChunks])).sort()).toEqual(
    [appChunk, importsChunk].sort(),
  );
});

test("a page downloads a small module once when two of its shared chunks use it", async ({
  page,
}) => {
  // `/reports` renders a chart panel that `/summary` also renders and a table
  // panel that `/invoices` also renders. Each panel is over 20 kB and keeps a
  // chunk of its own. Both use `formatCount`, a few hundred bytes.
  const scripts = await loadScripts(page, "/reports");
  await expect(page.locator('[data-page="reports"]')).toBeVisible();

  expect(filesWith(scripts, "marker-chart-data")).toHaveLength(1);
  expect(filesWith(scripts, "marker-table-data")).toHaveLength(1);
  expect(filesWith(scripts, "marker-chart-data")).not.toEqual(
    filesWith(scripts, "marker-table-data"),
  );

  // `formatCount` isn't copied into both panels' chunks: the page downloads it once.
  expect(filesWith(scripts, "marker-format-count")).toHaveLength(1);
});

async function probeBorderColors(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll("[data-probe]"), (element) => [
        element.getAttribute("data-probe")!,
        getComputedStyle(element).borderTopColor,
      ]),
    ),
  );
}

test("a CSS module that two of a page's shared chunks use is linked once, ahead of both", async ({
  page,
}) => {
  // Both panels render a `Tag` and recolour its border with a class from a
  // stylesheet that they import after the tag's. On a page with one panel, the
  // panel's colour wins.
  await page.goto(`${baseUrl}/summary`);
  await waitForHydration(page);
  expect(await probeBorderColors(page)).toEqual({ "chart-tag": RED });

  await page.goto(`${baseUrl}/invoices`);
  await waitForHydration(page);
  expect(await probeBorderColors(page)).toEqual({ "table-tag": BLUE });

  // `/reports` renders both. The tag's rules are linked once, ahead of both
  // panels' stylesheets, so each panel's colour still wins. A copy in each
  // panel's stylesheet would follow the first panel's and override its colour.
  await page.goto(`${baseUrl}/reports`);
  await waitForHydration(page);
  const tagRules = await page.evaluate(
    () =>
      Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules))
        .filter((rule) => rule instanceof CSSStyleRule && rule.style.padding === "2px 6px").length,
  );
  expect.soft(tagRules).toBe(1);
  expect(await probeBorderColors(page)).toEqual({ "chart-tag": RED, "table-tag": BLUE });
});
