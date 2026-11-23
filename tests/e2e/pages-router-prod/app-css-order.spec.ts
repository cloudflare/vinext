import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// The order of `_app`'s stylesheets in production, on
// tests/fixtures/pages-app-css-order. Next.js links the global CSS that `_app`
// imports ahead of the CSS modules `_app` imports after it, whichever pages
// also import them. Real Next.js 16.2.7 (webpack) meets the expectations below
// on this fixture, and so does vinext's dev server. Without `pages/404.tsx`,
// vinext's production build does too.

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/pages-app-css-order");

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
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-app-css-order-"));
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

test("_app's global stylesheet stays ahead of a CSS module that a page sorted before _app also imports", async ({
  page,
}) => {
  // `_app` imports `styles/global.css` (`.pill { margin: 0 }`) and then a
  // badge whose CSS module refines it (`.badge { margin-bottom: 8px }`).
  // `pages/404.tsx` renders the badge too, and its file sorts before `_app`.
  await page.goto(`${baseUrl}/`);
  await waitForHydration(page);

  const rules = await page.evaluate(() =>
    Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .map((rule) => (rule.selectorText === ".pill" ? "global" : "module")),
  );
  expect.soft(rules).toEqual(["global", "module"]);

  // The module's rule comes later, so it applies. With the module's rule
  // first, the global `margin: 0` overrides it on every page.
  await expect(page.getByTestId("app-badge")).toHaveCSS("margin-bottom", "8px");

  await page.goto(`${baseUrl}/missing`);
  await waitForHydration(page);
  await expect(page.getByTestId("page-badge")).toHaveCSS("margin-bottom", "8px");
});
