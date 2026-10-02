import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createLogger, createServer, type ViteDevServer } from "vite-plus";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  APP_FIXTURE_DIR,
  PAGES_FIXTURE_DIR,
  buildAppFixture,
  startFixtureServer,
  fetchHtml,
} from "./helpers.js";
import vinext from "../packages/vinext/src/index.js";

async function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function visibleTextByTestId(html: string, testId: string): string {
  const attribute = `data-testid="${testId}"`;
  const attributeIndex = html.indexOf(attribute);
  if (attributeIndex === -1) throw new Error(`Missing ${attribute}`);
  const contentStart = html.indexOf(">", attributeIndex);
  const contentEnd = html.indexOf("</", contentStart);
  if (contentStart === -1 || contentEnd === -1) {
    throw new Error(`Missing element content for ${attribute}`);
  }
  return html
    .slice(contentStart + 1, contentEnd)
    .replaceAll("<!-- -->", "")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("CJS interop (App Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // React SSR may insert comment nodes between text and expressions
    // (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });

  it("does not add a CommonJS export facade to project-local ESM bundles", async () => {
    // A linked workspace package's dist resolves outside node_modules. When it
    // inlines a CommonJS dependency, its wrapper mentions `exports.t`, which
    // must not become a second `export { t }` next to the bundle's own.
    const { res, html } = await fetchHtml(baseUrl, "/cjs/bundled-esm");
    expect(res.status).toBe(200);
    expect(visibleTextByTestId(html, "cjs-bundled-esm")).toBe("full:1.0.0");
  });

  it("keeps require() but not exports.* in a module that also exports ESM", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/mixed-esm");
    expect(res.status).toBe(200);
    expect(visibleTextByTestId(html, "cjs-mixed-esm")).toBe("esm");
  });

  it("renders page that uses CJS require('server-only')", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/server-only");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-server-only");
    expect(html).toContain("This page uses CJS require");
  });
});

describe("CJS interop (dependency scan)", () => {
  it("does not add a CommonJS export facade to project-local ESM bundles", async () => {
    // vite-plugin-commonjs's optimizer plugin loads and transforms files
    // without vinext's transform wrapper, so the scan must drop the same export
    // facade for app/cjs/bundled-esm and app/cjs/mixed-esm.
    const errors: string[] = [];
    const logger = createLogger("silent");
    logger.error = (message) => {
      errors.push(String(message));
    };
    // A fresh cache dir, so the optimizer always scans.
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "vinext-cjs-scan-"));
    const server = await createServer({
      root: APP_FIXTURE_DIR,
      cacheDir,
      configFile: false,
      customLogger: logger,
      plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      await server.listen();
      for (const environment of Object.values(server.environments)) {
        await (environment as { depsOptimizer?: { scanProcessing?: Promise<void> } }).depsOptimizer
          ?.scanProcessing;
      }
      expect(errors.filter((error) => error.includes("dependency scan"))).toEqual([]);
    } finally {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("CJS interop (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(PAGES_FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // Pages Router SSR inserts React comment nodes between text and
    // expressions (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });

  it("transforms project source that resembles a Nitro service output path", async () => {
    const nitroServer = await createServer({
      root: PAGES_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: PAGES_FIXTURE_DIR })],
      environments: { nitro: { consumer: "server" } },
      server: { middlewareMode: true },
      logLevel: "silent",
    });
    try {
      const module = await nitroServer.environments.nitro.transformRequest(
        "/vite/services/local/entry.js",
      );
      expect(module?.code).toContain("[vite-plugin-commonjs] export-runtime-S");
    } finally {
      await nitroServer.close();
    }
  });
});

// Ported from Next.js: test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts
const CONDITIONAL_EXPORT_CASES = [
  ["/import-cjs", "lib-cjs", "esm"],
  ["/require-cjs", "lib-cjs", "cjs"],
  ["/import-esm", "lib-esm", "esm"],
  ["/require-esm", "lib-esm", "cjs"],
] as const;

async function expectConditionalExport(
  baseUrl: string,
  route: string,
  label: string,
  expected: string,
): Promise<void> {
  const { res, html } = await fetchHtml(baseUrl, route);
  expect(res.status).toBe(200);
  expect(visibleTextByTestId(html, "conditional-result")).toBe(`${label}: ${expected}`);
}

describe("conditional package exports", () => {
  let root: string;
  let server: ViteDevServer;
  let devBaseUrl: string;
  let prodServer: Server;
  let prodBaseUrl: string;
  let buildOutDir: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(import.meta.dirname, ".require-condition-"));
    await Promise.all([
      writeFixtureFile(root, "package.json", JSON.stringify({ private: true, type: "module" })),
      writeFixtureFile(
        root,
        "app/layout.tsx",
        `export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/package.json",
        JSON.stringify({
          name: "lib-cjs",
          type: "commonjs",
          exports: { ".": { import: "./index.mjs", default: "./index.js" } },
        }),
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.mjs",
        `"use client"; export default () => "esm";`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.js",
        `"use client"; module.exports = () => "cjs";`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-esm/package.json",
        JSON.stringify({
          name: "lib-esm",
          type: "module",
          exports: { ".": { require: "./index.cjs", default: "./index.js" } },
        }),
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.js",
        `"use client"; export default () => "esm";`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.cjs",
        `"use client"; module.exports = () => "cjs";`,
      ),
      ...[
        ["import-cjs", `import Library from "lib-cjs";`, "lib-cjs"],
        ["require-cjs", `const Library = require("lib-cjs");`, "lib-cjs"],
        ["import-esm", `import Library from "lib-esm";`, "lib-esm"],
        ["require-esm", `const Library = require("lib-esm");`, "lib-esm"],
      ].map(([route, declaration, label]) =>
        writeFixtureFile(
          root,
          `app/${route}/page.tsx`,
          `${declaration}\nexport default function Page() { return <p data-testid="conditional-result">${label}: <Library /></p>; }`,
        ),
      ),
    ]);
    ({ server, baseUrl: devBaseUrl } = await startFixtureServer(root));

    const rscBundlePath = await buildAppFixture(root);
    buildOutDir = path.dirname(path.dirname(rscBundlePath));
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server: prodServer } = await startProdServer({
      port: 0,
      outDir: buildOutDir,
      noCompression: true,
      silent: true,
    }));
    const address = prodServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Production server did not bind");
    }
    prodBaseUrl = `http://localhost:${address.port}`;
  }, 120000);

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve, reject) => {
      if (!prodServer) return resolve();
      prodServer.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(buildOutDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it.each(CONDITIONAL_EXPORT_CASES)(
    "renders %s from the correct export condition in dev",
    async (route, label, expected) => {
      await expectConditionalExport(devBaseUrl, route, label, expected);
    },
  );

  it.each(CONDITIONAL_EXPORT_CASES)(
    "renders %s from the correct export condition in production",
    async (route, label, expected) => {
      await expectConditionalExport(prodBaseUrl, route, label, expected);
    },
  );
});
