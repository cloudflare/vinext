import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test as base } from "../fixtures";
import { waitForHydration } from "../helpers";

type ProductionApp = { baseUrl: string };

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function buildAndServeFixture(): Promise<{
  fixtureRoot: string;
  server: Server;
  app: ProductionApp;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-isr-query-browser-"));
  const sourceRoot = path.resolve(process.cwd(), "tests/fixtures/pages-isr-query-context");
  await fs.cp(sourceRoot, fixtureRoot, { recursive: true });
  await fs.symlink(
    path.resolve(process.cwd(), "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );

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
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });
  return {
    fixtureRoot,
    server: started.server,
    app: { baseUrl: `http://127.0.0.1:${started.port}` },
  };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- Playwright fixture `use`, not React */
const test = base.extend<{ productionApp: ProductionApp }>({
  productionApp: async ({ page }, use) => {
    const { fixtureRoot, server, app } = await buildAndServeFixture();
    try {
      await use(app);
    } finally {
      await page.close();
      await closeServer(server);
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  },
});
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

test("hydrates an ISR page from shared query state before publishing the browser query", async ({
  page,
  productionApp,
  consoleErrors,
}) => {
  const attackerToken = "ATTACKER_HYDRATION_QUERY_CONTEXT_TOKEN";
  const attacker = await fetch(`${productionApp.baseUrl}/hydrate?utm=${attackerToken}`);
  const attackerHtml = await attacker.text();
  expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
  expect(attackerHtml).not.toContain(attackerToken);
  expect(attackerHtml).toContain('<p id="as-path">/hydrate</p>');
  expect(attackerHtml).toContain('<p id="ready">false</p>');

  const victimToken = "VICTIM_HYDRATION_QUERY_CONTEXT_TOKEN";
  const response = await page.goto(`${productionApp.baseUrl}/hydrate?utm=${victimToken}`, {
    waitUntil: "load",
  });

  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForHydration(page);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_QUERY__?: string }).__INITIAL_ROUTER_QUERY__,
    ),
  ).toBe("{}");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_AS_PATH__?: string })
          .__INITIAL_ROUTER_AS_PATH__,
    ),
  ).toBe("/hydrate");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_READY__?: boolean }).__INITIAL_ROUTER_READY__,
    ),
  ).toBe(false);
  await expect(page.locator("#ready")).toHaveText("true");
  await expect(page.locator("#query")).toHaveText(JSON.stringify({ utm: victimToken }));
  await expect(page.locator("#query")).not.toContainText(attackerToken);
  await expect(page.locator("#as-path")).toHaveText(`/hydrate?utm=${victimToken}`);
  await expect(page.locator("#navigation-params")).toHaveText("{}");
  expect(consoleErrors).toEqual([]);
});

test("publishes a queryless browser URL over query-seeded shared ISR HTML", async ({
  page,
  productionApp,
  consoleErrors,
}) => {
  const attacker = await fetch(`${productionApp.baseUrl}/hydrate?utm=attacker`);
  expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
  await attacker.text();

  const response = await page.goto(`${productionApp.baseUrl}/hydrate`, { waitUntil: "load" });

  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForHydration(page);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_QUERY__?: string }).__INITIAL_ROUTER_QUERY__,
    ),
  ).toBe("{}");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_AS_PATH__?: string })
          .__INITIAL_ROUTER_AS_PATH__,
    ),
  ).toBe("/hydrate");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_READY__?: boolean }).__INITIAL_ROUTER_READY__,
    ),
  ).toBe(false);
  await expect(page.locator("#ready")).toHaveText("true");
  await expect(page.locator("#query")).toHaveText("{}");
  await expect(page.locator("#as-path")).toHaveText("/hydrate");
  await expect(page.locator("#navigation-params")).toHaveText("{}");
  expect(consoleErrors).toEqual([]);
});

test("publishes dynamic params after hydrating query-seeded shared ISR HTML", async ({
  page,
  productionApp,
  consoleErrors,
}) => {
  const attackerToken = "ATTACKER_DYNAMIC_QUERY_CONTEXT_TOKEN";
  const attacker = await fetch(`${productionApp.baseUrl}/dynamic/known?utm=${attackerToken}`);
  const attackerHtml = await attacker.text();
  expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
  expect(attackerHtml).not.toContain(attackerToken);
  expect(attackerHtml).toContain('<p id="ready">false</p>');
  expect(attackerHtml).toContain('<p id="navigation-params">null</p>');

  const response = await page.goto(`${productionApp.baseUrl}/dynamic/known`, {
    waitUntil: "load",
  });
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForHydration(page);
  await expect(page.locator("#ready")).toHaveText("true");
  await expect(page.locator("#query")).toHaveText(JSON.stringify({ slug: "known" }));
  await expect(page.locator("#as-path")).toHaveText("/dynamic/known");
  await expect(page.locator("#navigation-params")).toHaveText(JSON.stringify({ slug: "known" }));
  expect(consoleErrors).toEqual([]);
});
