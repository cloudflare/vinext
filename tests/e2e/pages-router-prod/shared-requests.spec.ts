import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page, Response } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// What a Pages Router production page downloads when the code its pages share
// is small components with CSS modules, on tests/fixtures/pages-shared-requests.
// Each folder under `pages/` is one case with pages and `lib/` code of its own,
// so the cases don't affect each other.
//
// A "list" in the fixture is six sections of about 5 kB, each with a CSS module
// of its own: over 20 kB of JavaScript together and a few hundred bytes of CSS.
// Next.js' webpack `splitChunks` gives a group of modules that the same pages
// share a chunk once the group reaches `minSize` (20 kB), counted separately
// for its JavaScript and its CSS, and leaves a smaller group in the chunks of
// the pages that use it. So a list gets a chunk, the small modules that lists
// and pages share cost no request of their own, and a page links one
// stylesheet:
// packages/next/src/build/webpack-config.ts (`splitChunks`)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack-config.ts
// Real Next.js 16.2.7 (webpack) meets every expectation below on this fixture.

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/pages-shared-requests");

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
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-shared-requests-"));
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
  const onResponse = (response: Response) => {
    const { pathname } = new URL(response.url());
    if (!pathname.endsWith(".js")) return;
    responses.push(response.text().then((code) => [path.posix.basename(pathname), code]));
  };
  page.on("response", onResponse);
  try {
    await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
    await waitForHydration(page);
  } finally {
    page.off("response", onResponse);
  }
  return new Map(await Promise.all(responses));
}

/** The names of the downloaded files whose code holds `marker`, a string the fixture's source renders. */
function filesWith(scripts: Map<string, string>, marker: string): string[] {
  return Array.from(scripts)
    .filter(([, code]) => code.includes(marker))
    .map(([file]) => file)
    .sort();
}

/** How many JavaScript files a full load of `route` downloads. */
async function countScripts(page: Page, route: string): Promise<number> {
  return (await loadScripts(page, route)).size;
}

/** How many JavaScript files each route downloads beyond what `/` does. */
async function extraScripts(page: Page, routes: string[]): Promise<Record<string, number>> {
  const home = await countScripts(page, "/");
  const extra: Record<string, number> = {};
  for (const route of routes) {
    extra[route] = (await countScripts(page, route)) - home;
  }
  return extra;
}

/** How many stylesheets each route links once it has loaded. */
async function stylesheetLinks(page: Page, routes: string[]): Promise<Record<string, number>> {
  const links: Record<string, number> = {};
  for (const route of routes) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
    await waitForHydration(page);
    links[route] = await page.locator('link[rel="stylesheet"]').count();
  }
  return links;
}

test("a page links one stylesheet for the small CSS modules of two shared lists", async ({
  page,
}) => {
  // pages/panels: `/panels/both` renders two lists that `/panels/alpha` and
  // `/panels/beta` render one each. Their CSS modules are under 1 kB in all,
  // so Next.js leaves them in each page's own stylesheet.
  const links = await stylesheetLinks(page, ["/panels/both", "/panels/alpha", "/panels/beta"]);

  // Vite limitation: Vite gives every JavaScript chunk a stylesheet of its
  // own, so the CSS of each list's chunk can't stay in the page's stylesheet.
  test.fail();
  expect(links).toEqual({ "/panels/both": 1, "/panels/alpha": 1, "/panels/beta": 1 });
});

test("a small component with a CSS module that two shared lists use costs no request of its own", async ({
  page,
}) => {
  // pages/lists: every section of both lists renders a label of about 300
  // bytes that has a CSS module. In Next.js each page loads one file per list
  // beyond what `/` loads, and links one stylesheet.
  const routes = ["/lists/both", "/lists/catalog", "/lists/orders"];
  const extra = await extraScripts(page, routes);
  const links = await stylesheetLinks(page, routes);

  // Rolldown limitation: `experimentalInlineCommonChunks` copies a small chunk
  // into the chunks that import it, not into the pages, so a copy in both
  // lists' chunks would download twice on `/lists/both`. The label keeps a
  // chunk.
  test.fail();
  expect.soft(extra).toEqual({ "/lists/both": 2, "/lists/catalog": 1, "/lists/orders": 1 });
  expect(links).toEqual({ "/lists/both": 1, "/lists/catalog": 1, "/lists/orders": 1 });
});

test("a small helper that two shared lists use costs no request of its own", async ({ page }) => {
  // pages/tables: every section of both lists calls `formatCell`, a few
  // lines without CSS. In Next.js each page loads one file per list beyond
  // what `/` loads.
  const extra = await extraScripts(page, ["/tables/both", "/tables/stock", "/tables/prices"]);

  // Rolldown limitation: as above, a copy in both lists' chunks would
  // download twice on `/tables/both`.
  test.fail();
  expect(extra).toEqual({ "/tables/both": 2, "/tables/stock": 1, "/tables/prices": 1 });
});

test("a small helper that a page and a shared list it renders both use costs no request of its own", async ({
  page,
}) => {
  // pages/cards: the list's sections call `cardTitle`, and so do
  // `/cards/full` (which also renders the list) and `/cards/title` (which
  // does not). In Next.js the helper is in the pages' own chunks: the list is
  // the one extra file, and `/cards/title` loads no more files than `/`.
  const extra = await extraScripts(page, ["/cards/full", "/cards/grid", "/cards/title"]);

  expect(extra).toEqual({ "/cards/full": 1, "/cards/grid": 1, "/cards/title": 0 });
});

test("a small component with a CSS module that pages and a next/dynamic component use costs no request of its own", async ({
  page,
}) => {
  // pages/drawer: `/drawer/framed` and `/drawer/frame` render a small frame
  // that has a CSS module, and the drawer that `/drawer/framed` and
  // `/drawer/plain` load with next/dynamic renders it too. In Next.js the
  // drawer is the one extra file, and `/drawer/frame` loads no more files
  // than `/`.
  const extra = await extraScripts(page, ["/drawer/framed", "/drawer/plain", "/drawer/frame"]);

  // Rolldown limitation: Rolldown builds one chunk per `import()` target,
  // where webpack builds the drawer once per page and leaves out what the
  // page has. A copy of the frame in the drawer's chunk would link its CSS
  // twice on `/drawer/framed`.
  test.fail();
  expect(extra).toEqual({ "/drawer/framed": 1, "/drawer/plain": 1, "/drawer/frame": 0 });
});

test("a page downloads once the modules of a side-effect-free barrel that _app imports from without using them", async ({
  page,
}) => {
  // pages/indexes: `_app` imports `siteName` from `lib/kit`, a barrel whose
  // package.json sets `sideEffects: false`. The barrel also exports
  // `unitName` and a chip with a CSS module, which `_app` does not use and
  // two indexes of over 20 kB do. `/indexes/both` renders both indexes.
  const scripts = await loadScripts(page, "/indexes/both");

  expect.soft(filesWith(scripts, "marker-unit-name")).toHaveLength(1);
  expect(filesWith(scripts, "marker-chip")).toHaveLength(1);
});

test("the modules of a side-effect-free barrel that _app imports from without using them cost no request of their own", async ({
  page,
}) => {
  // pages/indexes again, counting files. In Next.js each index is the one
  // extra file, and `unitName` and the chip are in the pages' chunks: no page
  // makes a request for what `_app` leaves of the barrel.
  const extra = await extraScripts(page, ["/indexes/both", "/indexes/north", "/indexes/south"]);

  expect(extra).toEqual({ "/indexes/both": 2, "/indexes/north": 1, "/indexes/south": 1 });
});

test("what one set of pages shares loads as one file, with and without CSS modules", async ({
  page,
}) => {
  // pages/atlas: `/atlas/first` and `/atlas/second` render the same board:
  // three files of rows without CSS (over 20 kB together) and a list of six
  // sections that each have a CSS module (over 20 kB together). The same two
  // pages share all of it, so Next.js loads it as one file.
  const extra = await extraScripts(page, ["/atlas/first", "/atlas/second"]);

  expect(extra).toEqual({ "/atlas/first": 1, "/atlas/second": 1 });
});
