import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder, createServer, type InlineConfig } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

// Ported from Next.js v16.2.6:
// test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinext-client-package-type-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeFixtureFile(root: string, filePath: string, content: string): void {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function linkDependency(root: string, dependency: string): void {
  const source = path.resolve(import.meta.dirname, "../node_modules", dependency);
  const destination = path.join(root, "node_modules", dependency);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, "junction");
}

function extractHtmlText(html: string): string {
  let text = "";
  let index = 0;
  let skippedElement: string | null = null;

  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index] === "<") {
      const end = html.indexOf(">", index + 1);
      if (end === -1) break;
      const rawTag = html
        .slice(index + 1, end)
        .trim()
        .toLowerCase();
      const closing = rawTag.startsWith("/");
      const tagName = rawTag.slice(closing ? 1 : 0).split(/[\s/]/, 1)[0];
      if (closing && tagName === skippedElement) skippedElement = null;
      if (!closing && (tagName === "script" || tagName === "style")) skippedElement = tagName;
      index = end + 1;
      continue;
    }
    if (!skippedElement) text += html[index];
    index++;
  }

  return text.split(/\s+/).filter(Boolean).join(" ");
}

async function expectRoutes(baseUrl: string, routes: readonly (readonly [string, string])[]) {
  for (const [route, expected] of routes) {
    const response = await fetch(`${baseUrl}/${route}`);
    const html = await response.text();
    expect(response.status, `${route}: ${html}`).toBe(200);
    expect(extractHtmlText(html)).toContain(expected);
  }
}

async function withDevServer(
  createConfig: () => InlineConfig,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = await createServer({
    ...createConfig(),
    server: { port: 0 },
    optimizeDeps: { holdUntilCrawlEnd: true },
  });
  await server.listen();
  try {
    const address = server.httpServer?.address();
    expect(address && typeof address === "object").toBe(true);
    await run(`http://localhost:${typeof address === "object" && address ? address.port : 0}`);
  } finally {
    await server.close();
  }
}

async function withProdServer(
  createConfig: () => InlineConfig,
  outDir: string,
  run: (baseUrl: string) => Promise<void>,
) {
  const builder = await createBuilder(createConfig());
  await builder.buildApp();
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({ port: 0, outDir, noCompression: true });
  try {
    const address = server.address();
    expect(address && typeof address === "object").toBe(true);
    await run(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("App Router client module package type parity", () => {
  it("uses package exports and type for import and require client modules", async () => {
    await withTempDir(async (root) => {
      for (const dependency of [
        "@vitejs/plugin-rsc",
        "react",
        "react-dom",
        "react-server-dom-webpack",
        "scheduler",
      ]) {
        linkDependency(root, dependency);
      }

      writeFixtureFile(
        root,
        "package.json",
        JSON.stringify({ name: "client-package-type", private: true, type: "module" }, null, 2),
      );
      writeFixtureFile(
        root,
        "app/layout.tsx",
        `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );

      const clientRoutes = [
        ["import-cjs", 'import Component from "lib-cjs";', "lib-cjs"],
        ["require-cjs", 'const Component = require("lib-cjs");', "lib-cjs"],
        ["import-esm", 'import Component from "lib-esm";', "lib-esm"],
        ["require-esm", 'const Component = require("lib-esm");', "lib-esm"],
      ] as const;

      for (const [route, moduleStatement, label] of clientRoutes) {
        writeFixtureFile(
          root,
          `app/${route}/page.tsx`,
          `${moduleStatement}

export default function Page() {
  return <p>${label}: <Component /></p>;
}
`,
        );
      }

      writeFixtureFile(
        root,
        "node_modules/lib-cjs/package.json",
        JSON.stringify(
          {
            name: "lib-cjs",
            type: "commonjs",
            exports: { ".": { import: "./index.mjs", default: "./index.js" } },
          },
          null,
          2,
        ),
      );
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.js",
        `'use client'; module.exports = () => 'cjs';`,
      );
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.mjs",
        `'use client'; export default () => 'esm';`,
      );
      writeFixtureFile(
        root,
        "node_modules/lib-esm/package.json",
        JSON.stringify(
          {
            name: "lib-esm",
            type: "module",
            exports: { ".": { require: "./index.cjs", default: "./index.js" } },
          },
          null,
          2,
        ),
      );
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.js",
        `'use client'; export default () => 'esm';`,
      );
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.cjs",
        `'use client'; module.exports = () => 'cjs';`,
      );

      writeFixtureFile(
        root,
        "app/server-data/page.tsx",
        `const data = require("server-data");
export default function Page() { return <p>server-data: {data.value}</p>; }
`,
      );
      writeFixtureFile(
        root,
        "node_modules/server-data/package.json",
        JSON.stringify({ name: "server-data", type: "commonjs", main: "index.js" }, null, 2),
      );
      writeFixtureFile(
        root,
        "node_modules/server-data/index.js",
        `module.exports = { value: "server" };`,
      );
      writeFixtureFile(
        root,
        "app/server-only/page.tsx",
        `require("server-only");
export default function Page() { return <p>server-only: ok</p>; }
`,
      );

      const outDir = path.join(root, "dist");
      const createConfig = (): InlineConfig => ({
        root,
        configFile: false,
        plugins: [vinext({ appDir: root })],
        logLevel: "silent",
      });
      const routes = [
        ["import-cjs", "lib-cjs: esm"],
        ["require-cjs", "lib-cjs: cjs"],
        ["import-esm", "lib-esm: esm"],
        ["require-esm", "lib-esm: cjs"],
        ["server-data", "server-data: server"],
        ["server-only", "server-only: ok"],
      ] as const;

      await withDevServer(createConfig, (baseUrl) => expectRoutes(baseUrl, routes));
      await withProdServer(createConfig, outDir, (baseUrl) => expectRoutes(baseUrl, routes));
    });
  }, 90_000);

  it.each([
    ["serverExternalPackages", "next-config"],
    ["ssr.external", "vite-config"],
  ] as const)(
    "preserves require conditions for %s in dev and production",
    async (_name, kind) => {
      await withTempDir(async (root) => {
        for (const dependency of [
          "@vitejs/plugin-rsc",
          "react",
          "react-dom",
          "react-server-dom-webpack",
          "scheduler",
        ]) {
          linkDependency(root, dependency);
        }
        writeFixtureFile(
          root,
          "package.json",
          JSON.stringify({ name: "external-require-condition", private: true, type: "module" }),
        );
        writeFixtureFile(
          root,
          "app/layout.tsx",
          `import type { ReactNode } from "react";
export default function Layout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}`,
        );
        writeFixtureFile(
          root,
          "app/page.tsx",
          `const value = require("external-condition");
const falsy = require("external-falsy");
export default function Page() { return <p>external: {value}; falsy: {String(falsy)}</p>; }`,
        );
        writeFixtureFile(
          root,
          "node_modules/external-condition/package.json",
          JSON.stringify({
            name: "external-condition",
            type: "module",
            exports: { ".": { require: "./require.cjs", import: "./import.js" } },
          }),
        );
        writeFixtureFile(
          root,
          "node_modules/external-condition/require.cjs",
          `module.exports = "require";`,
        );
        writeFixtureFile(
          root,
          "node_modules/external-condition/import.js",
          `export default "import";`,
        );
        writeFixtureFile(
          root,
          "node_modules/external-falsy/package.json",
          JSON.stringify({ name: "external-falsy", type: "commonjs", main: "index.cjs" }),
        );
        writeFixtureFile(root, "node_modules/external-falsy/index.cjs", `module.exports = false;`);

        const createConfig = (): InlineConfig => ({
          root,
          configFile: false,
          plugins: [
            vinext({
              appDir: root,
              ...(kind === "next-config"
                ? {
                    nextConfig: {
                      serverExternalPackages: ["external-condition", "external-falsy"],
                    },
                  }
                : {}),
            }),
          ],
          ...(kind === "vite-config"
            ? { ssr: { external: ["external-condition", "external-falsy"] } }
            : {}),
          logLevel: "silent",
        });
        const routes = [["", "external: require; falsy: false"]] as const;
        const outDir = path.join(root, "dist");

        await withDevServer(createConfig, (baseUrl) => expectRoutes(baseUrl, routes));
        await withProdServer(createConfig, outDir, (baseUrl) => expectRoutes(baseUrl, routes));
        const manifest = JSON.parse(
          fs.readFileSync(path.join(outDir, "server", "vinext-externals.json"), "utf-8"),
        ) as string[];
        expect(manifest).toContain("external-condition");
        expect(manifest).toContain("external-falsy");
      });
    },
    90_000,
  );
});
