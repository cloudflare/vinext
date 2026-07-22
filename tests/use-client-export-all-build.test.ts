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

function writeBaseProject(root: string) {
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  writeFixtureFile(
    root,
    "package.json",
    JSON.stringify(
      { name: "vinext-use-client-export-all", private: true, type: "module" },
      null,
      2,
    ),
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
        include: ["app", "components", "*.ts", "*.tsx"],
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
}

describe("App Router 'use client' modules with `export * from`", () => {
  // Mirrors Next.js's e2e fixture:
  // test/e2e/app-dir/rsc-basic/components/export-all/*
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/components/export-all/index.js
  it("builds a 'use client' module that re-exports another module with `export *`", async () => {
    await withTempDir("vinext-export-all-build-", async (root) => {
      writeBaseProject(root);

      // The 'use client' file has `export * from './one'` — this used to fail with
      // "unsupported ExportAllDeclaration" from @vitejs/plugin-rsc's `rsc:use-client`.
      writeFixtureFile(
        root,
        "components/export-all/index.tsx",
        `"use client";

export * from "./one";
`,
      );
      // The re-exported module also contains a nested `export *` plus a renamed
      // re-export, matching the Next.js fixture's structure exactly.
      writeFixtureFile(
        root,
        "components/export-all/one.tsx",
        `"use client";

export function One() {
  return <span data-testid="one">one</span>;
}

export * from "./two";
export { Two as TwoAliased } from "./two";
`,
      );
      writeFixtureFile(
        root,
        "components/export-all/two.tsx",
        `"use client";

export function Two() {
  return <span data-testid="two">two</span>;
}
`,
      );
      writeFixtureFile(
        root,
        "app/page.tsx",
        `import { One, Two, TwoAliased } from "../components/export-all";

export default function HomePage() {
  return (
    <main>
      <One />
      <Two />
      <TwoAliased />
    </main>
  );
}
`,
      );

      await buildApp(root);

      expect(fs.existsSync(path.join(root, "dist", "server", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(root, "dist", "server", "ssr", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(root, "dist", "client"))).toBe(true);
    });
  }, 60_000);

  it("builds a 'use client' module that uses `export * as Namespace from`", async () => {
    await withTempDir("vinext-export-all-ns-build-", async (root) => {
      writeBaseProject(root);

      writeFixtureFile(
        root,
        "components/export-ns/inner.tsx",
        `"use client";

export function Hello() {
  return <span data-testid="hello">hello</span>;
}
`,
      );
      writeFixtureFile(
        root,
        "components/export-ns/index.tsx",
        `"use client";

export * as Inner from "./inner";
`,
      );
      writeFixtureFile(
        root,
        "app/page.tsx",
        `import { Inner } from "../components/export-ns";

export default function HomePage() {
  return (
    <main>
      <Inner.Hello />
    </main>
  );
}
`,
      );

      await buildApp(root);

      expect(fs.existsSync(path.join(root, "dist", "server", "index.js"))).toBe(true);
    });
  }, 60_000);

  // Regression: destructured `export const { ... } = ...` declarations in the
  // re-exported module produce ObjectPattern / ArrayPattern declarator ids
  // rather than Identifier. The export collector must walk those patterns,
  // otherwise the rewritten `export { ... } from` clause silently drops
  // names and consumers see `undefined` at runtime.
  it("builds a 'use client' barrel that re-exports destructured bindings", async () => {
    await withTempDir("vinext-export-all-destructure-", async (root) => {
      writeBaseProject(root);

      writeFixtureFile(
        root,
        "components/export-destructure/inner.tsx",
        `"use client";

function makePair() {
  const First = () => <span data-testid="first">first</span>;
  const Second = () => <span data-testid="second">second</span>;
  return { First, Second } as const;
}

function makeTuple() {
  const Third = () => <span data-testid="third">third</span>;
  return [Third] as const;
}

export const { First, Second } = makePair();
export const [Third] = makeTuple();
`,
      );
      writeFixtureFile(
        root,
        "components/export-destructure/index.tsx",
        `"use client";

export * from "./inner";
`,
      );
      writeFixtureFile(
        root,
        "app/page.tsx",
        `import { First, Second, Third } from "../components/export-destructure";

export default function HomePage() {
  return (
    <main>
      <First />
      <Second />
      <Third />
    </main>
  );
}
`,
      );

      await buildApp(root);

      expect(fs.existsSync(path.join(root, "dist", "server", "index.js"))).toBe(true);
    });
  }, 60_000);
});
