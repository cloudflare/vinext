import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test as base } from "../fixtures";
import { waitForHydration } from "../helpers";

type ProductionApp = { baseUrl: string };
const BASE_PATH = "/app";

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
  const attacker = await fetch(`${productionApp.baseUrl}${BASE_PATH}/hydrate?utm=${attackerToken}`);
  const attackerHtml = await attacker.text();
  expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
  expect(attackerHtml).not.toContain(attackerToken);
  expect(attackerHtml).toContain('<p id="as-path">/hydrate</p>');
  expect(attackerHtml).toContain('<p id="ready">false</p>');

  const victimToken = "VICTIM_HYDRATION_QUERY_CONTEXT_TOKEN";
  const response = await page.goto(
    `${productionApp.baseUrl}${BASE_PATH}/hydrate?utm=${victimToken}`,
    { waitUntil: "load" },
  );

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
  ).toBe(`/hydrate?utm=${victimToken}`);
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

// Ported from Next.js: test/integration/router-is-ready/test/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/integration/router-is-ready/test/index.test.ts
test("publishes a queryless browser URL over query-seeded shared ISR HTML", async ({
  page,
  productionApp,
  consoleErrors,
}) => {
  const attacker = await fetch(`${productionApp.baseUrl}${BASE_PATH}/hydrate?utm=attacker`);
  expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
  await attacker.text();

  const response = await page.goto(`${productionApp.baseUrl}${BASE_PATH}/hydrate`, {
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
  ).toBe(true);
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
  const attacker = await fetch(
    `${productionApp.baseUrl}${BASE_PATH}/dynamic/known?utm=${attackerToken}`,
  );
  const attackerHtml = await attacker.text();
  expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
  expect(attackerHtml).not.toContain(attackerToken);
  expect(attackerHtml).toContain('<p id="ready">false</p>');
  expect(attackerHtml).toContain('<p id="navigation-params">null</p>');

  const response = await page.goto(`${productionApp.baseUrl}${BASE_PATH}/dynamic/known`, {
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
  ).toBe(JSON.stringify({ slug: "known" }));
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_AS_PATH__?: string })
          .__INITIAL_ROUTER_AS_PATH__,
    ),
  ).toBe("/dynamic/known");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_READY__?: boolean }).__INITIAL_ROUTER_READY__,
    ),
  ).toBe(true);
  await expect(page.locator("#ready")).toHaveText("true");
  await expect(page.locator("#query")).toHaveText(JSON.stringify({ slug: "known" }));
  await expect(page.locator("#as-path")).toHaveText("/dynamic/known");
  await expect(page.locator("#navigation-pathname")).toHaveText("/dynamic/known");
  await expect(page.locator("#navigation-params")).toHaveText(JSON.stringify({ slug: "known" }));
  // Next.js also constructs its client router as ready immediately for a
  // queryless GSP page even though ServerRouter.isReady is false. Components
  // should avoid using isReady to conditionally render server markup.
  expect(consoleErrors).toEqual([]);
});

test("hydrates a localized dynamic GSP with locale-free navigation state", async ({
  page,
  productionApp,
  consoleErrors,
}) => {
  const attackerToken = "LOCALIZED_ISR_ATTACKER_TOKEN";
  const attacker = await fetch(
    `${productionApp.baseUrl}${BASE_PATH}/nl/dynamic/known?utm=${attackerToken}`,
  );
  const attackerHtml = await attacker.text();
  expect(attacker.headers.get("x-vinext-cache")).toBe("MISS");
  expect(attackerHtml).not.toContain(attackerToken);
  expect(attackerHtml).toContain('<p id="query">{&quot;slug&quot;:&quot;known&quot;}</p>');
  expect(attackerHtml).toContain('<p id="as-path">/dynamic/known</p>');
  expect(attackerHtml).toContain('<p id="navigation-pathname">/dynamic/known</p>');
  expect(attackerHtml).toContain('<p id="navigation-params">null</p>');

  const victimToken = "LOCALIZED_ISR_VICTIM_TOKEN";
  const response = await page.goto(
    `${productionApp.baseUrl}${BASE_PATH}/nl/dynamic/known?utm=${victimToken}`,
    { waitUntil: "load" },
  );

  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-vinext-cache"]).toBe("HIT");
  await waitForHydration(page);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_NAVIGATION_PATHNAME__?: string | null })
          .__INITIAL_NAVIGATION_PATHNAME__,
    ),
  ).toBe("/dynamic/known");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_NAVIGATION_PARAMS__?: string })
          .__INITIAL_NAVIGATION_PARAMS__,
    ),
  ).toBe("null");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_QUERY__?: string }).__INITIAL_ROUTER_QUERY__,
    ),
  ).toBe(JSON.stringify({ slug: "known" }));
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_AS_PATH__?: string })
          .__INITIAL_ROUTER_AS_PATH__,
    ),
  ).toBe(`/dynamic/known?utm=${victimToken}`);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_ROUTER_READY__?: boolean }).__INITIAL_ROUTER_READY__,
    ),
  ).toBe(false);

  await expect(page.locator("#ready")).toHaveText("true");
  await expect(page.locator("#query")).toHaveText(
    JSON.stringify({ utm: victimToken, slug: "known" }),
  );
  await expect(page.locator("#as-path")).toHaveText(`/dynamic/known?utm=${victimToken}`);
  await expect(page.locator("#navigation-pathname")).toHaveText("/dynamic/known");
  await expect(page.locator("#navigation-params")).toHaveText(JSON.stringify({ slug: "known" }));

  await page.locator("#navigate-clean").click();
  await expect(page).toHaveURL(`${productionApp.baseUrl}${BASE_PATH}/nl/dynamic/clean?via=client`);
  await expect(page.locator("#ready")).toHaveText("true");
  await expect(page.locator("#query")).toHaveText(JSON.stringify({ via: "client", slug: "clean" }));
  await expect(page.locator("#as-path")).toHaveText("/dynamic/clean?via=client");
  await expect(page.locator("#navigation-pathname")).toHaveText("/dynamic/clean");
  await expect(page.locator("#navigation-params")).toHaveText(JSON.stringify({ slug: "clean" }));
  expect(consoleErrors).toEqual([]);
});

// Ported from Next.js: test/e2e/fallback-route-params/fallback-route-params.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/fallback-route-params/fallback-route-params.test.ts
test("keeps fallback:true params out of the shell until hydration", async ({
  page,
  productionApp,
  consoleErrors,
}) => {
  const shellSlug = "raw-fallback-shell";
  const shellResponse = await fetch(
    `${productionApp.baseUrl}${BASE_PATH}/fallback/${shellSlug}?from=shell`,
  );
  const shellHtml = await shellResponse.text();
  const nextDataJson = shellHtml.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  expect(nextDataJson).toBeTruthy();
  expect(JSON.parse(nextDataJson ?? "{}")).toMatchObject({
    isFallback: true,
    query: {},
  });
  expect(shellHtml).toContain('<p id="fallback">Loading...</p>');
  expect(shellHtml).toContain('<p id="fallback-query">{}</p>');
  expect(shellHtml).toContain('<p id="fallback-as-path">/fallback/[slug]</p>');
  expect(shellHtml).toContain('<p id="fallback-ready">false</p>');

  const browserSlug = "hydrated-fallback-shell";
  const response = await page.goto(
    `${productionApp.baseUrl}${BASE_PATH}/nl/fallback/${browserSlug}?from=browser#client-fragment`,
    { waitUntil: "load" },
  );
  expect(response?.status()).toBe(200);
  await waitForHydration(page);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_FALLBACK_QUERY__?: string })
          .__INITIAL_FALLBACK_QUERY__,
    ),
  ).toBe("{}");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_FALLBACK_SLUG__?: string })
          .__INITIAL_FALLBACK_SLUG__,
    ),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_FALLBACK_AS_PATH__?: string })
          .__INITIAL_FALLBACK_AS_PATH__,
    ),
  ).toBe(`/fallback/${browserSlug}?from=browser#client-fragment`);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __INITIAL_FALLBACK_READY__?: boolean })
          .__INITIAL_FALLBACK_READY__,
    ),
  ).toBe(false);

  await expect(page.locator("#query")).toHaveText(
    JSON.stringify({ from: "browser", slug: browserSlug }),
  );
  await expect(page.locator("#as-path")).toHaveText(
    `/fallback/${browserSlug}?from=browser#client-fragment`,
  );
  await expect(page.locator("#ready")).toHaveText("true");
  expect(consoleErrors).toEqual([]);
});
