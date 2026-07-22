/**
 * Test: JSX in plain `.js` files inside `node_modules`.
 *
 * Many third-party Next.js client libraries ship `.js` files containing
 * `"use client"` + JSX (Next.js's SWC pipeline transparently compiles JSX in
 * plain `.js`, even inside `node_modules`). vinext's pre-existing
 * `vinext:jsx-in-js` plugin only handles user source (`outside node_modules`),
 * so when `@vitejs/plugin-rsc`'s `use-client` analysis pass tries to parse a
 * library file like:
 *
 *   'use client'
 *   export function Hello() {
 *     return <p>hello world</p>
 *   }
 *
 * rolldown/oxc fails with:
 *
 *   RolldownError: Parse failed with 1 error:
 *   Unexpected JSX expression
 *
 * Ported from Next.js:
 *   test/e2e/app-dir/next-dist-client-esm-import/
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-dist-client-esm-import/
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

async function withTempDir<T>(prefix: string, run: (tmpDir: string) => Promise<T>): Promise<T> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function writeFixtureFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

async function buildApp(root: string) {
  const rscOutDir = path.join(root, "dist", "server");
  const ssrOutDir = path.join(root, "dist", "server", "ssr");
  const clientOutDir = path.join(root, "dist", "client");
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("App Router: client modules with JSX in .js files inside node_modules", () => {
  it("builds a 'use client' .js module with JSX shipped from a node_modules dependency", async () => {
    await withTempDir("vinext-jsx-node-modules-", async (root) => {
      // Link top-level node_modules (react, react-dom, etc.) so vinext can resolve them.
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );

      // App-level files.
      writeFixtureFile(
        root,
        "package.json",
        JSON.stringify({ name: "vinext-jsx-node-modules", private: true, type: "module" }, null, 2),
      );
      writeFixtureFile(
        root,
        "tsconfig.json",
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "bundler",
              jsx: "react-jsx",
              strict: true,
              skipLibCheck: true,
              types: ["vite/client", "@vitejs/plugin-rsc/types"],
            },
            include: ["app", "*.ts", "*.tsx"],
          },
          null,
          2,
        ),
      );
      writeFixtureFile(
        root,
        "app/layout.tsx",
        `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      );
      writeFixtureFile(
        root,
        "app/page.tsx",
        `import { Hello } from "@monorepo/adapter-next";

export default function Page() {
  return <Hello />;
}
`,
      );

      // A fake third-party package (ESM `type: "module"`) inside node_modules
      // whose entry is a plain `.js` file containing `"use client"` + JSX.
      // This mirrors the Next.js test fixture verbatim.
      const pkgDir = path.join(root, "node_modules", "@monorepo", "adapter-next");
      writeFixtureFile(
        pkgDir,
        "package.json",
        JSON.stringify(
          {
            name: "@monorepo/adapter-next",
            type: "module",
            exports: {
              ".": {
                default: "./dist/client/index.js",
              },
            },
          },
          null,
          2,
        ),
      );
      writeFixtureFile(
        pkgDir,
        "dist/client/index.js",
        `'use client'

export function Hello() {
  return <p>hello world</p>
}
`,
      );

      // Build. The bug manifests as a RolldownError "Unexpected JSX expression"
      // thrown by rolldown/oxc when @vitejs/plugin-rsc analyses the .js file.
      await expect(buildApp(root)).resolves.not.toThrow();

      // Ensure the build actually produced server + client output.
      expect(fs.existsSync(path.join(root, "dist", "server", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(root, "dist", "client"))).toBe(true);
    });
  }, 90_000);
});
