import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// What a Pages Router production page downloads when the code its pages share
// is made of small files, on tests/fixtures/pages-shared-group-requests. Each
// list and its three files of rows are over 20 kB together, and `/overview`
// renders both. The two small components that the lists use are a few hundred
// bytes each. Next.js' webpack `splitChunks` gives a group of modules a chunk
// once the group reaches `minSize` and leaves a smaller one in the chunks
// that use it, so a small component never costs a request of its own:
// packages/next/src/build/webpack-config.ts (`splitChunks`)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack-config.ts
// Real Next.js 16.2.7 (webpack) meets every expectation below on this fixture.

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/pages-shared-group-requests");

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
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-shared-group-requests-"));
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

/** How many JavaScript files a full load of `route` downloads. */
async function countScripts(page: Page, route: string): Promise<number> {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
  await waitForHydration(page);
  return page.evaluate(
    () =>
      new Set(
        performance
          .getEntriesByType("resource")
          .map((entry) => new URL(entry.name).pathname)
          .filter((pathname) => pathname.endsWith(".js")),
      ).size,
  );
}

test("a small component that two shared groups of small files use costs no request of its own", async ({
  page,
}) => {
  // What each page downloads beyond what `/` does. In Next.js that is one
  // file per list: `/overview` loads two more files than `/`, and `/catalog`
  // and `/orders` one more. The label that both lists render is in those.
  const home = await countScripts(page, "/");
  const extra: Record<string, number> = {};
  for (const route of ["/overview", "/catalog", "/orders"]) {
    extra[route] = (await countScripts(page, route)) - home;
  }

  expect(extra).toEqual({ "/overview": 2, "/catalog": 1, "/orders": 1 });
});

test("a page links one stylesheet for the small CSS modules that its shared groups use", async ({
  page,
}) => {
  // The label's CSS module and the dot's are under 50 bytes each. Next.js
  // links one stylesheet on each of these pages.
  const links: Record<string, number> = {};
  for (const route of ["/overview", "/catalog", "/orders", "/about"]) {
    await page.goto(`${baseUrl}${route}`);
    await waitForHydration(page);
    links[route] = await page.locator('link[rel="stylesheet"]').count();
  }

  expect(links).toEqual({ "/overview": 1, "/catalog": 1, "/orders": 1, "/about": 1 });
});
