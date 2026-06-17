import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test as base } from "../../fixtures";
import { waitForAppRouterHydration } from "../../helpers";

type ProductionApp = {
  baseUrl: string;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");

  await fs.mkdir(targetNodeModules, { recursive: true });

  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite-temp") continue;

    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

async function writeSoftHistoryFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");

  await linkFixtureNodeModules(fixtureRoot);
  await fs.mkdir(path.join(appDir, "with-id"), { recursive: true });
  await fs.mkdir(path.join(appDir, "navigation"), { recursive: true });
  await fs.mkdir(path.join(appDir, "slow"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "node_modules", "nanoid"), { recursive: true });

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "node_modules", "nanoid", "package.json"),
    `${JSON.stringify({ name: "nanoid", type: "module", exports: "./index.js" }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "node_modules", "nanoid", "index.js"),
    `export function nanoid() {
  return Math.random().toString(36).slice(2);
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import { use, type ReactNode } from "react";

export const revalidate = 0;

async function getData() {
  return {
    world: "world",
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const { world } = use(getData());

  return (
    <html className="this-is-the-document-html">
      <head>
        <title>{\`hello \${world}\`}</title>
        <link rel="icon" href="data:," />
      </head>
      <body className="this-is-the-document-body">{children}</body>
    </html>
  );
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "with-id", "page.tsx"),
    `import Link from "next/link";
import { nanoid } from "nanoid";

export default function Page() {
  return (
    <>
      <h1 id="render-id">{nanoid()}</h1>
      <Link href="/navigation" id="link">
        To Navigation
      </Link>
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "navigation", "page.tsx"),
    `import Link from "next/link";
import { nanoid } from "nanoid";

export default function Page() {
  return (
    <>
      <h1 id="render-id">{nanoid()}</h1>
      <h2 id="from-navigation">hello from /navigation</h2>
      <Link href="/slow" id="link-to-slow" prefetch={false}>
        To Slow
      </Link>
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "slow", "page.tsx"),
    `export const revalidate = 0;

async function getData() {
  // Intentionally stall so the RSC request is still in flight when the test
  // traverses back to the previous history entry.
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  return { id: "slow-page" };
}

export default async function Page() {
  const { id } = await getData();
  return <h1 id="render-id">{id}</h1>;
}
`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    path.join(fixtureRoot, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
});
`,
  );
}

async function buildAndServeSoftHistoryFixture(): Promise<{
  fixtureRoot: string;
  server: Server;
  app: ProductionApp;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-soft-history-"));
  await writeSoftHistoryFixture(fixtureRoot);

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();

  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root: fixtureRoot });

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });

  return {
    fixtureRoot,
    server: started.server,
    app: {
      baseUrl: `http://127.0.0.1:${started.port}`,
    },
  };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- Playwright fixture `use`, not a React hook */
const test = base.extend<{ productionApp: ProductionApp }>({
  productionApp: async ({ page }, use) => {
    const { fixtureRoot, server, app } = await buildAndServeSoftHistoryFixture();

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

test.setTimeout(90_000);

test.describe("Next.js compat: production Link history navigation", () => {
  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app/index.test.ts
  test("should be soft for back navigation", async ({ page, productionApp, consoleErrors }) => {
    await page.goto(`${productionApp.baseUrl}/with-id`);
    await waitForAppRouterHydration(page);

    const firstID = await page.locator("#render-id").textContent();

    await page.locator("#link").click();
    await expect(page.locator("#from-navigation")).toHaveText("hello from /navigation", {
      timeout: 10_000,
    });
    await page.goBack();
    await expect(page).toHaveURL(`${productionApp.baseUrl}/with-id`);

    const secondID = await page.locator("#render-id").textContent();
    expect(firstID).toBe(secondID);
    expect(consoleErrors).toEqual([]);
  });

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app/index.test.ts
  test("should be soft for forward navigation", async ({ page, productionApp, consoleErrors }) => {
    await page.goto(`${productionApp.baseUrl}/with-id`);
    await waitForAppRouterHydration(page);

    await page.locator("#link").click();
    await expect(page.locator("#from-navigation")).toHaveText("hello from /navigation", {
      timeout: 10_000,
    });

    const firstID = await page.locator("#render-id").textContent();

    await page.goBack();
    await expect(page).toHaveURL(`${productionApp.baseUrl}/with-id`);
    await page.goForward();
    await expect(page).toHaveURL(`${productionApp.baseUrl}/navigation`);

    const secondID = await page.locator("#render-id").textContent();
    expect(firstID).toBe(secondID);
    expect(consoleErrors).toEqual([]);
  });

  test("aborts superseded in-flight RSC request on soft back navigation", async ({
    page,
    productionApp,
    consoleErrors,
  }) => {
    // Observe the RSC request for /slow so we can detect when it is captured
    // and when it is later cancelled.
    let slowRequestCaptured = false;
    let slowRequestAborted = false;
    page.on("request", (request) => {
      if (request.url().includes("/slow")) {
        slowRequestCaptured = true;
      }
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("/slow")) {
        slowRequestAborted = true;
      }
    });

    await page.goto(`${productionApp.baseUrl}/with-id`);
    await waitForAppRouterHydration(page);

    const firstID = await page.locator("#render-id").textContent();

    // Establish a second history entry so we can traverse back while another
    // RSC request is still in flight.
    await page.locator("#link").click();
    await expect(page.locator("#from-navigation")).toHaveText("hello from /navigation", {
      timeout: 10_000,
    });

    // Start navigating to /slow; its RSC response intentionally hangs. The URL
    // stays on /navigation until the response arrives, so going back returns to
    // the /with-id history entry.
    await page.locator("#link-to-slow").click();
    await expect.poll(() => slowRequestCaptured).toBe(true);

    // Traverse back before the slow response can arrive.
    await page.goBack();
    await expect(page).toHaveURL(`${productionApp.baseUrl}/with-id`);

    // The superseded RSC request must be cancelled, not merely prevented from committing.
    await expect.poll(() => slowRequestAborted).toBe(true);

    // The restored snapshot must still be the original dynamic output.
    const secondID = await page.locator("#render-id").textContent();
    expect(secondID).toBe(firstID);
    expect(consoleErrors).toEqual([]);
  });
});
