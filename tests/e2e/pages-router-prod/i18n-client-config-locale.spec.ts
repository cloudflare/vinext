import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { waitForHydration } from "../helpers";

// Pages i18n: config rules see default-locale paths with the locale prefixed
// (`/locale-false-page` is matched as `/en/locale-false-page`, and with
// trailingSlash the root as `/en/`), on the server and in the browser alike.
// A client that matched the bare path would render a different page than a
// document request for the same URL.

type ProductionApp = { baseUrl: string; close: () => Promise<void> };

async function buildAndServe(fixture: string): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-${fixture}-`));
  await fs.cp(path.resolve(process.cwd(), "tests/fixtures", fixture), fixtureRoot, {
    recursive: true,
  });
  await fs.symlink(
    path.resolve(process.cwd(), "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  // These fixtures have no package.json; the built server entry is ESM.
  await fs.writeFile(path.join(fixtureRoot, "package.json"), '{ "type": "module" }\n');

  const { createBuilder } = await import("vite");
  const { default: vinext } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/src/index.ts")).href
  );
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ disableAppRouter: true })],
  });
  await builder.buildApp();

  const { startProdServer } = await import("../../../packages/vinext/src/server/prod-server.js");
  const { server, port } = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await closeServer(server);
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

// Expected values were observed against real Next.js 16.2.7 with the same
// config, for document requests and client navigation.
test.describe("Pages i18n locale: false rewrites (production)", () => {
  let app: ProductionApp;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    app = await buildAndServe("pages-i18n-public-rewrite");
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("document requests match default-locale paths with the locale prefix", async ({
    request,
  }) => {
    for (const [pathname, heading] of [
      ["/locale-false-page", "about page"],
      ["/en/locale-false-page", "about page"],
      ["/sv/locale-false-page", "about page"],
      ["/unprefixed-locale-false", "unprefixed locale false page"],
    ]) {
      const html = await (await request.get(`${app.baseUrl}${pathname}`)).text();
      expect(html, pathname).toContain(`<h1>${heading}</h1>`);
    }
  });

  for (const [pathname, heading] of [
    ["/locale-false-page", "about page"],
    ["/sv/locale-false-page", "about page"],
    ["/unprefixed-locale-false", "unprefixed locale false page"],
  ]) {
    test(`client navigation to ${pathname} renders the same page as the server`, async ({
      page,
    }) => {
      await page.goto(`${app.baseUrl}/`);
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as any).__LOCALE_NAV_MARKER__ = true;
      });

      await page.evaluate((target) => (window as any).next.router.push(target), pathname);
      await expect(page.locator("h1")).toHaveText(heading);
      expect(new URL(page.url()).pathname).toBe(pathname);
      expect(await page.evaluate(() => (window as any).__LOCALE_NAV_MARKER__)).toBe(true);
    });
  }
});

// Next.js's server applies the root rewrite (resolve-routes.ts re-adds the
// root slash). This fixture maps `en` to the example.com domain, so a
// default-locale client navigation from 127.0.0.1 is a cross-domain document
// load; the default-locale client match is covered by the router unit tests.
test.describe("Pages i18n domain locales with basePath and trailingSlash (production)", () => {
  let app: ProductionApp;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    app = await buildAndServe("pages-i18n-domains-basepath");
  });

  test.afterAll(async () => {
    await app?.close();
  });

  for (const [pathname, locale] of [
    ["/app/?root-rewrite=1", "en"],
    ["/app/fr/?root-rewrite=1", "fr"],
  ]) {
    test(`document request for ${pathname} renders the rewritten page`, async ({ request }) => {
      const html = await (await request.get(`${app.baseUrl}${pathname}`)).text();
      expect(html).toContain(`<p id="locale">${locale}</p>`);
      expect(html).not.toContain("<h1>Home</h1>");
    });
  }

  test("client navigation to the fr root renders the same page as the server", async ({ page }) => {
    await page.goto(`${app.baseUrl}/app/about/`);
    await waitForHydration(page);
    await page.evaluate(() => {
      (window as any).__LOCALE_NAV_MARKER__ = true;
    });

    await page.evaluate(() => (window as any).next.router.push("/fr/?root-rewrite=1"));
    await expect(page).toHaveURL(`${app.baseUrl}/app/fr/?root-rewrite=1`);
    await expect(page.locator("#locale")).toHaveText("fr");
    await expect(page.locator("h1")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__LOCALE_NAV_MARKER__)).toBe(true);
  });

  test("client navigation follows a domain default-locale redirect to that domain", async ({
    page,
  }) => {
    // Real Next.js 16.2.7 redirects `/fr/...` to the fr domain (absolute, with
    // basePath and the query) from any host.
    await page.route("http://example.fr/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>example.fr</h1>" }),
    );
    await page.goto(`${app.baseUrl}/app/about/`);
    await waitForHydration(page);

    await page.evaluate(() => (window as any).next.router.push("/fr/old-domain-redirect/?x=1"));
    await expect(page).toHaveURL("http://example.fr/app/about/?x=1");
    await expect(page.locator("h1")).toHaveText("example.fr");
  });
});
