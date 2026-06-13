/**
 * Build-driven regression test for cloudflare/vinext#1507.
 *
 * Next.js Turbopack `resolveAlias` (and webpack `resolve.alias`) values can be
 * bare package specifiers, not just relative/absolute file paths. The upstream
 * `esm-externals` deploy suite aliases `preact/compat` -> `react` this way:
 *
 *   turbopack: { resolveAlias: { 'preact/compat': 'react' } }
 *
 * vinext previously resolved every non-absolute alias value against the project
 * root, turning `'react'` into a bogus `<root>/react` filesystem path. The
 * production build then failed with "No such file or directory (os error 2)",
 * which surfaced in the deploy harness as "Custom deploy script failed".
 *
 * This test reproduces the real symptom end-to-end: it builds a Pages Router
 * app that imports `preact/compat` (a package that is NOT installed) and relies
 * solely on `resolveAlias` to redirect it to `react`. Before the fix this build
 * threw; after the fix the bare specifier is left verbatim and Vite resolves it
 * through node_modules.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { build } from "vite";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

async function buildPagesFixture(nextConfigBody: string): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-resolve-alias-"));
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Symlink the workspace node_modules so the fixture can resolve React and
  // vinext. Note: `preact` is intentionally NOT installed — the import below
  // must resolve purely via the configured alias.
  fs.symlinkSync(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(tmpDir, "next.config.mjs"), `export default ${nextConfigBody};\n`);
  fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "pages", "index.tsx"),
    `import React from "preact/compat";
export default function Home() {
  // Touch the aliased import so it cannot be tree-shaken away.
  return <p>{String(typeof React.useState === "function")}</p>;
}
`,
  );

  await build({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true })],
    logLevel: "silent",
    build: {
      outDir: path.join(tmpDir, "dist", "server"),
      ssr: "virtual:vinext-server-entry",
      rollupOptions: { output: { entryFileNames: "entry.js" } },
    },
  });
}

describe("resolveAlias bare-specifier build (#1507)", () => {
  it("builds when turbopack.resolveAlias maps an import to a bare package specifier", async () => {
    await expect(
      buildPagesFixture(
        `{ experimental: { esmExternals: false }, turbopack: { resolveAlias: { "preact/compat": "react" } } }`,
      ),
    ).resolves.toBeUndefined();
  }, 180_000);
});
