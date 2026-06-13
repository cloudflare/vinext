import fs from "node:fs/promises";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "../../fixtures";

// This is a production-build browser regression test. It intentionally builds
// and serves an isolated temp app instead of using Playwright's shared
// webServer/baseURL, because the WebKit failure only reproduced from the built
// client reference runtime map. It requires packages/vinext/dist to exist.

type ProductionApp = {
  baseUrl: string;
};

const requireFromVinextPackage = createRequire(
  path.resolve(process.cwd(), "packages/vinext/package.json"),
);

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

async function writePackageClientReferenceFixture(fixtureRoot: string): Promise<void> {
  const packageDir = path.join(fixtureRoot, "node_modules", "@vinext-test", "client-package");

  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@vinext-test/client-package",
        type: "module",
        exports: "./index.tsx",
        main: "./index.tsx",
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(packageDir, "index.tsx"),
    `"use client";
import "./style.css";

export function PackageProbe() {
  return <span className="package-probe">package-probe</span>;
}
`,
  );
  await fs.writeFile(
    path.join(packageDir, "style.css"),
    `.package-probe {
  color: rgb(12, 34, 56);
}
`,
  );
}

async function writeWebKitHarnessFixture(fixtureRoot: string): Promise<void> {
  const refCount = 5;
  const appDir = path.join(fixtureRoot, "app");
  const routeDir = path.join(appDir, "client-reference-runtime-map");
  const clientRefsDir = path.join(fixtureRoot, "client-refs");

  await fs.mkdir(routeDir, { recursive: true });
  await fs.mkdir(clientRefsDir, { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <link rel="icon" href="data:," />
      </head>
      <body>{children}</body>
    </html>
  );
}
`,
  );
  for (let index = 0; index < refCount; index++) {
    await fs.writeFile(
      path.join(clientRefsDir, `probe-${index}.tsx`),
      `"use client";
// Top-level await forces async module evaluation and exposes the WebKit timing
// bug where grouped client-reference facade exports can be observed before
// initialization completes.
await Promise.resolve();

export function Probe${index}() {
  return <span data-probe="${index}">probe-${index}</span>;
}
`,
    );
  }

  let page = "";
  for (let index = 0; index < refCount; index++) {
    page += `import { Probe${index} } from "../../client-refs/probe-${index}";\n`;
  }
  page += `import { PackageProbe } from "@vinext-test/client-package";\n`;
  await fs.writeFile(
    path.join(routeDir, "page.tsx"),
    `${page}
export default function WebKitClientReferenceCrashPage() {
  return (
    <main>
      <h1>Client Reference Runtime Harness</h1>
      ${Array.from({ length: refCount }, (_, index) => `<Probe${index} />`).join("\n      ")}
      <PackageProbe />
    </main>
  );
}
`,
  );
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function findCssAssetContaining(directory: string, marker: string): Promise<string> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      try {
        return await findCssAssetContaining(filePath, marker);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "CSS asset not found") throw error;
      }
    } else if (entry.name.endsWith(".css")) {
      const source = await fs.readFile(filePath, "utf8");
      if (source.includes(marker)) return filePath;
    }
  }

  throw new Error("CSS asset not found");
}

async function assertPackageClientReferenceCssDeps(fixtureRoot: string): Promise<void> {
  const cssAsset = await findCssAssetContaining(
    path.join(fixtureRoot, "dist", "client", "_next", "static"),
    "package-probe",
  );
  const manifestUrl =
    pathToFileURL(path.join(fixtureRoot, "dist", "server", "__vite_rsc_assets_manifest.js")).href +
    `?t=${Date.now()}`;
  const manifest = (await import(manifestUrl)).default as {
    clientReferenceDeps: Record<string, { css?: unknown[] }>;
  };
  const cssFileName = path.basename(cssAsset);
  const hasPackageCssDep = Object.values(manifest.clientReferenceDeps).some((deps) =>
    deps.css?.some((href) => String(href).includes(cssFileName)),
  );

  expect(hasPackageCssDep).toBe(true);
}

async function buildAndServeProductionFixture(): Promise<{
  fixtureRoot: string;
  server: Server;
  app: ProductionApp;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-reference-"));

  await linkFixtureNodeModules(fixtureRoot);
  await writePackageClientReferenceFixture(fixtureRoot);
  await writeWebKitHarnessFixture(fixtureRoot);

  const configFile = path.join(fixtureRoot, "vite.config.ts");
  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  const reactPluginSource = requireFromVinextPackage.resolve("@vitejs/plugin-react");
  await fs.writeFile(
    configFile,
    `import { defineConfig } from "vite";
import react from ${JSON.stringify(pathToFileURL(reactPluginSource).href)};
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  optimizeDeps: { exclude: ["@vinext-test/client-package"] },
  plugins: [react(), vinext({ appDir: import.meta.dirname, react: false })],
  ssr: { noExternal: ["@vinext-test/client-package"] },
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
  await assertPackageClientReferenceCssDeps(fixtureRoot);

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
    const { fixtureRoot, server, app } = await buildAndServeProductionFixture();

    try {
      await use(app);
    } finally {
      // Close the page before the server so requests scheduled after the test
      // body (e.g. via requestIdleCallback) can't hit a closed port and log
      // ERR_CONNECTION_REFUSED, which the consoleErrors fixture would turn
      // into a flaky failure.
      await page.close();
      await closeServer(server);
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  },
});
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

test.setTimeout(60_000);

test.describe("App Router client reference runtime map", () => {
  test("serves the production build without undefined RSC client references", async ({
    page,
    productionApp,
    consoleErrors,
  }) => {
    const response = await page.goto(
      `${productionApp.baseUrl}/client-reference-runtime-map?q=${Date.now()}`,
      { waitUntil: "load" },
    );

    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Client Reference Runtime Harness" }),
    ).toBeVisible();
    await expect(page.getByText("package-probe")).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });
});
