import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

// Ported from Next.js's Pages Router client stylesheet handling:
// packages/next/src/client/index.tsx (`onStart`, `onHeadCommit`), covered in
// test/production/css-features/css-rendering.test.ts and
// test/e2e/css-features/css-modules-ordering.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/css-features/css-modules-ordering.test.ts

const fixtureSource = path.resolve(process.cwd(), "tests/fixtures/pages-css-navigation");

const RED = "rgb(255, 0, 0)";
const GREEN = "rgb(0, 128, 0)";
const BLUE = "rgb(0, 0, 255)";
const PURPLE = "rgb(128, 0, 128)";
const ORANGE = "rgb(255, 165, 0)";

// Each page's colours on a full load. Page stylesheets come after `_app`'s,
// and a page's own after those of the components it imports. `/ordered` and
// `/reversed` load the gallery's shared stylesheet before the ledger's.
const EXPECTED: Record<string, Record<string, string>> = {
  alpha: { title: BLUE, text: GREEN },
  beta: { title: BLUE, text: PURPLE },
  plain: { title: BLUE, text: RED },
  bare: { title: BLUE, text: BLUE },
  dynamic: { title: BLUE, card: ORANGE },
  ledger: { title: BLUE, text: BLUE },
  gamma: { title: BLUE, text: GREEN },
  delta: { title: BLUE, text: PURPLE },
  ordered: { title: BLUE, text: BLUE },
  reversed: { title: BLUE, text: BLUE },
  lazy: { title: BLUE, text: BLUE },
};

let fixtureRoot: string;
let server: Server;
let baseUrl: string;

async function closeServer(target: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => target.close(() => resolve()));
  target.closeIdleConnections();
  target.closeAllConnections();
  await closed;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

test.beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-css-navigation-"));
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

async function probeColors(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll("[data-probe]"), (element) => [
        element.getAttribute("data-probe")!,
        getComputedStyle(element).color,
      ]),
    ),
  );
}

async function expectPage(page: Page, name: string): Promise<void> {
  await expect(page.locator(`[data-page="${name}"]`)).toBeVisible();
  if (name === "dynamic") await expect(page.locator('[data-probe="card"]')).toBeVisible();
  expect(await probeColors(page), name).toEqual(EXPECTED[name]);
}

/** After a client navigation: only the page's own stylesheets are on, in order, after the marker. */
async function expectPageStylesheets(page: Page, name: string): Promise<void> {
  const state = await page.evaluate((route) => {
    const pathOf = (href: string) => new URL(href, document.baseURI).pathname;
    const manifest = window.__VINEXT_PAGE_STYLESHEETS__;
    const shared = new Set(manifest?.shared.map(pathOf));
    const managed = new Set(
      Object.values(manifest?.routes ?? {})
        .flat()
        .map(pathOf)
        .filter((path) => !shared.has(path)),
    );
    const afterMarker: string[] = [];
    let node = document.querySelector("noscript[data-n-css]")?.nextElementSibling;
    while (node?.matches("style[data-n-href]:not([media])")) {
      afterMarker.push(node.getAttribute("data-n-href")!);
      node = node.nextElementSibling;
    }
    const links = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      (link) => pathOf(link.href),
    );
    return {
      expected: manifest?.routes[route] ?? [],
      shared: manifest?.shared ?? [],
      on: Array.from(document.querySelectorAll("style[data-n-href]:not([media])"), (tag) =>
        tag.getAttribute("data-n-href")!,
      ),
      afterMarker,
      links,
      managedLinks: links.filter((link) => managed.has(link)),
    };
  }, `/${name}`);

  expect(state.shared.length).toBeGreaterThan(0);
  expect(state.on, name).toEqual(state.expected);
  expect(state.afterMarker, name).toEqual(state.expected);
  expect(state.managedLinks, name).toEqual([]);
  expect(new Set(state.links).size, `${name}: ${state.links.join(", ")}`).toBe(state.links.length);
}

async function navigate(page: Page, name: string): Promise<void> {
  await page.evaluate(() => delete document.body.dataset.layoutColor);
  await page.getByTestId(`nav-${name}`).click();
  await expectPage(page, name);
  await expectPageStylesheets(page, name);
  if (name === "beta") {
    // The page's layout effects already see its stylesheets.
    expect(await page.evaluate(() => document.body.dataset.layoutColor)).toBe(PURPLE);
  }
}

test("full page loads apply each page's stylesheets in order", async ({ page }) => {
  for (const name of Object.keys(EXPECTED)) {
    await page.goto(`${baseUrl}/${name}`);
    await waitForHydration(page);
    // Once the links have prefetched their pages, which must not apply those
    // pages' stylesheets.
    await page.waitForLoadState("networkidle");
    await expectPage(page, name);
  }
});

test("client navigations keep each page's full-load cascade", async ({ page }) => {
  await page.goto(`${baseUrl}/bare`);
  await waitForHydration(page);
  await expectPage(page, "bare");

  // Small shared stylesheets are copied into each page's own, so an earlier
  // page's copy must not stay on after the page that overrides it. `/ledger`,
  // `/gamma` then `/ordered` leaves the ledger's stylesheet ahead of the
  // gallery's, which `/ordered` loads first.
  const tour = [
    "alpha",
    "beta",
    "alpha",
    "plain",
    "alpha",
    "bare",
    "dynamic",
    "alpha",
    "dynamic",
    "ledger",
    "gamma",
    "ordered",
    "reversed",
    "delta",
    "gamma",
    "ledger",
    "ordered",
    "beta",
  ];
  for (const name of tour) await navigate(page, name);

  for (const name of tour.slice(-5, -1).reverse()) {
    await page.goBack();
    await expectPage(page, name);
    await expectPageStylesheets(page, name);
  }
  for (const name of tour.slice(-4, -2)) {
    await page.goForward();
    await expectPage(page, name);
    await expectPageStylesheets(page, name);
  }
});

test("the first client navigation hands the page's stylesheets to <style> tags", async ({
  page,
}) => {
  await page.goto(`${baseUrl}/alpha`);
  await waitForHydration(page);

  const initial = await page.evaluate(() => ({
    marker: document.querySelector("noscript[data-n-css]") !== null,
    links: Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      (link) => new URL(link.href).pathname,
    ),
    alpha: window.__VINEXT_PAGE_STYLESHEETS__?.routes["/alpha"] ?? [],
  }));
  expect(initial.marker).toBe(true);
  // The server links the page's stylesheets, which client navigations manage.
  for (const href of initial.alpha) {
    expect(initial.links).toContain(new URL(href, baseUrl).pathname);
  }

  await navigate(page, "beta");
  await navigate(page, "alpha");

  // Page stylesheets keep their `url()` assets: they are absolute.
  const background = await page
    .locator('[data-probe="text"]')
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  const assetUrl = /url\("([^"]+)"\)/.exec(background)?.[1];
  expect(assetUrl).toBeDefined();
  expect(new URL(assetUrl!).pathname).toMatch(/^\/_next\/static\/media\//);
  expect((await page.request.get(assetUrl!)).status()).toBe(200);
});
