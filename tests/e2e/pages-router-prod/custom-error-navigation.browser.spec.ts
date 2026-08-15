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
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-custom-error-"));
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
    `import Link from "next/link";

export default function Home() {
  return <Link href="/missing" data-testid="missing-link">Missing</Link>;
}
`,
  );
  await fs.writeFile(
    path.join(pagesDir, "_error.tsx"),
    `export default function CustomError({ statusCode }) {
  return <main data-testid="custom-error">Custom error {statusCode}</main>;
}

CustomError.getInitialProps = ({ res, err }) => ({
  statusCode: res?.statusCode ?? err?.statusCode ?? 404,
});
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

// Ported from Next.js: test/e2e/no-page-props/no-page-props.test.ts
// https://github.com/vercel/next.js/blob/v16.3.0-canary.80/test/e2e/no-page-props/no-page-props.test.ts
test("client navigation loads the custom pages/_error component", async ({
  page,
  productionApp,
}) => {
  await page.goto(productionApp.baseUrl, { waitUntil: "load" });
  await waitForHydration(page);

  await page.getByTestId("missing-link").click();

  await expect(page.getByTestId("custom-error")).toHaveText("Custom error 404");
  await expect(page).toHaveURL(`${productionApp.baseUrl}/missing`);
});
