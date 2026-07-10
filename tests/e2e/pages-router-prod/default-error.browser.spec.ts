import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

type ProductionApp = {
  baseUrl: string;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function buildAndServeProductionFixture(): Promise<{
  fixtureRoot: string;
  server: Server;
  app: ProductionApp;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-default-error-"));
  const pagesDir = path.join(fixtureRoot, "pages");

  await fs.symlink(
    path.resolve(process.cwd(), "tests/fixtures/pages-basic/node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    `export default function Home() { return <main>Home</main>; }\n`,
  );
  await fs.writeFile(
    path.join(pagesDir, "server-error.tsx"),
    `export async function getServerSideProps() {
  throw new Error("intentional production error");
}

export default function ServerError() {
  return <main>unreachable</main>;
}
`,
  );

  const configFile = path.join(fixtureRoot, "vite.config.ts");
  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    configFile,
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [vinext()],
});
`,
  );

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile,
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

  return {
    fixtureRoot,
    server: started.server,
    app: { baseUrl: `http://127.0.0.1:${started.port}` },
  };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- Playwright fixture `use`, not a React hook */
const test = base.extend<{ productionApp: ProductionApp }>({
  productionApp: async ({ page }, use) => {
    const { fixtureRoot, server, app } = await buildAndServeProductionFixture();

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

test.setTimeout(60_000);

test.describe("Pages Router framework error page production fallback", () => {
  test("renders and hydrates the framework error page without custom error files", async ({
    page,
    productionApp,
    consoleErrors,
  }) => {
    const notFoundResponse = await page.goto(`${productionApp.baseUrl}/missing`, {
      waitUntil: "load",
    });

    expect(notFoundResponse?.status()).toBe(404);
    await expect(page.locator("h1")).toHaveText("404");
    await expect(page.locator("h2")).toHaveText("This page could not be found.");
    await expect(page).toHaveTitle("404: This page could not be found");
    await waitForHydration(page);

    const errorResponse = await page.goto(`${productionApp.baseUrl}/server-error`, {
      waitUntil: "load",
    });

    expect(errorResponse?.status()).toBe(500);
    await expect(page.locator("h1")).toHaveText("500");
    await expect(page.locator("h2")).toHaveText("Internal Server Error.");
    await expect(page).toHaveTitle("500: Internal Server Error");
    await waitForHydration(page);

    const unexpectedErrors = consoleErrors.filter(
      (message) =>
        !/^Failed to load resource: the server responded with a status of (404|500) \(.+\)$/.test(
          message,
        ),
    );
    expect(unexpectedErrors).toEqual([]);
    consoleErrors.length = 0;
  });
});
