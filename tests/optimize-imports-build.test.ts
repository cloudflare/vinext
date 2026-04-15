import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

async function withTempDir<T>(prefix: string, run: (tmpDir: string) => Promise<T>): Promise<T> {
  const tempParent = path.resolve(import.meta.dirname, "../.sisyphus/tmp");
  fs.mkdirSync(tempParent, { recursive: true });

  const tmpDir = await mkdtemp(path.join(tempParent, prefix));
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

describe("optimizePackageImports production builds", () => {
  it("builds an App Router app when an optimized antd barrel resolves through a use-client export-star boundary", async () => {
    // issue-845 repro scaffold and package pins are recorded in:
    // .sisyphus/evidence/task-1-parity-matrix.md
    await withTempDir("vinext-optimize-imports-build-", async (root) => {
      writeFixtureFile(
        root,
        "package.json",
        JSON.stringify(
          { name: "vinext-optimize-imports-build", private: true, type: "module" },
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
        `import AntdDemo from "./components/AntdDemo";

export default function HomePage() {
  return <AntdDemo />;
}
`,
      );
      writeFixtureFile(
        root,
        "app/components/AntdDemo.tsx",
        `"use client";

import { Button } from "antd";

export default function AntdDemo() {
  return <Button />;
}
`,
      );

      writeFixtureFile(
        root,
        "node_modules/antd/package.json",
        JSON.stringify(
          {
            name: "antd",
            version: "6.3.5",
            type: "module",
            main: "./index.js",
          },
          null,
          2,
        ),
      );
      writeFixtureFile(
        root,
        "node_modules/antd/index.js",
        `export { Button } from "./es/button/index.js";
`,
      );
      writeFixtureFile(
        root,
        "node_modules/antd/es/button/index.js",
        `"use client";

export * from "./button.js";
export { default } from "./button.js";
`,
      );
      writeFixtureFile(
        root,
        "node_modules/antd/es/button/button.js",
        `export function Button() {
  return null;
}

export default Button;
`,
      );

      await buildApp(root);

      expect(fs.existsSync(path.join(root, "dist", "server", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(root, "dist", "server", "ssr", "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(root, "dist", "client"))).toBe(true);
    });
  }, 60_000);
});
