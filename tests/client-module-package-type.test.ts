import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startFixtureServer } from "./helpers.js";

type BuiltHandler = (request: Request) => Promise<Response>;

const EXPECTED_ROUTES = new Map([
  ["/import-cjs", "lib-cjs: esm"],
  ["/require-cjs", "lib-cjs: cjs"],
  ["/import-esm", "lib-esm: esm"],
  ["/require-esm", "lib-esm: cjs"],
]);

function writeFile(root: string, filePath: string, contents: string): void {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function linkWorkspaceDependencies(root: string): void {
  const source = path.resolve(import.meta.dirname, "../node_modules");
  const target = path.join(root, "node_modules");
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".vite") continue;
    const sourceEntry = path.join(source, entry.name);
    fs.symlinkSync(
      sourceEntry,
      path.join(target, entry.name),
      fs.statSync(sourceEntry).isDirectory() ? "junction" : "file",
    );
  }
}

function createFixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-package-type-")));
  linkWorkspaceDependencies(root);
  writeFile(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  writeFile(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}`,
  );

  writeFile(
    root,
    "node_modules/lib-cjs/package.json",
    JSON.stringify({
      name: "lib-cjs",
      type: "commonjs",
      exports: { ".": { import: "./index.mjs", default: "./index.js" } },
    }),
  );
  writeFile(
    root,
    "node_modules/lib-cjs/index.js",
    `'use client';
module.exports = () => 'cjs';`,
  );
  writeFile(
    root,
    "node_modules/lib-cjs/index.mjs",
    `'use client';
export default () => 'esm';`,
  );

  writeFile(
    root,
    "node_modules/lib-esm/package.json",
    JSON.stringify({
      name: "lib-esm",
      type: "module",
      exports: { ".": { require: "./index.cjs", default: "./index.js" } },
    }),
  );
  writeFile(
    root,
    "node_modules/lib-esm/index.cjs",
    `'use client';
module.exports = () => 'cjs';`,
  );
  writeFile(
    root,
    "node_modules/lib-esm/index.js",
    `'use client';
export default () => 'esm';`,
  );

  writeFile(
    root,
    "app/import-cjs/page.tsx",
    `import Component from "lib-cjs";
export default function Page() { return <p>lib-cjs: <Component /></p>; }`,
  );
  writeFile(
    root,
    "app/require-cjs/page.tsx",
    `const Component = require("lib-cjs");
export default function Page() { return <p>lib-cjs: <Component /></p>; }`,
  );
  writeFile(
    root,
    "app/import-esm/page.tsx",
    `import Component from "lib-esm";
export default function Page() { return <p>lib-esm: <Component /></p>; }`,
  );
  writeFile(
    root,
    "app/require-esm/page.tsx",
    `const Component = require("lib-esm");
export default function Page() { return <p>lib-esm: <Component /></p>; }`,
  );

  return root;
}

describe("App Router client module package type resolution", () => {
  let root = "";
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = "";
  });

  // Ported from Next.js:
  // test/e2e/app-dir/client-module-with-package-type/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts
  it("respects package type and conditional exports during development", async () => {
    root = createFixture();
    const started = await startFixtureServer(root, { appDir: root });
    server = started.server;

    for (const [pathname, text] of EXPECTED_ROUTES) {
      const response = await fetch(`${started.baseUrl}${pathname}`);
      expect(response.status).toBe(200);
      expect((await response.text()).replaceAll("<!-- -->", "")).toContain(text);
    }
  }, 120_000);

  it("respects package type and conditional exports in production", async () => {
    root = createFixture();
    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const built = (await import(
      `${pathToFileURL(path.join(root, "dist", "server", "index.js")).href}?t=${Date.now()}`
    )) as { default: BuiltHandler };

    for (const [pathname, text] of EXPECTED_ROUTES) {
      const response = await built.default(new Request(`http://localhost${pathname}`));
      expect(response.status).toBe(200);
      expect((await response.text()).replaceAll("<!-- -->", "")).toContain(text);
    }
  }, 120_000);
});
