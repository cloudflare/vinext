/**
 * Build-driven regression test for the hashbang e2e fixture.
 *
 * Ported from Next.js: test/e2e/hashbang/src/cases/js.js
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/hashbang/src/cases/js.js
 *
 * A module that starts with a hashbang line (`#!/usr/env node`) and also
 * contains CommonJS syntax (`module.exports = ...`) is routed through
 * vite-plugin-commonjs's CJS->ESM interop transform. That transform prepends
 * a `module`/`exports` runtime facade to the source it receives, which pushes
 * the hashbang line out of byte position 0. `#!` is only valid Hashbang
 * grammar at the very start of a file, so the bundler's parser then throws
 * on the stray `#!` ("Invalid Character '!'"), failing the whole build.
 *
 * This test reproduces the real symptom end-to-end: it builds a Pages Router
 * app whose page imports a hashbang-prefixed CJS module. Before the fix this
 * build throws during the client bundle; after the fix the hashbang is
 * stripped before the CJS transform runs and spliced back onto its output.
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

describe("hashbang-prefixed CommonJS module build", () => {
  it("builds a page that imports a hashbang-prefixed CJS module", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-hashbang-"));
    cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    fs.symlinkSync(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(tmpDir, "next.config.mjs"), "export default {};\n");
    fs.writeFileSync(path.join(tmpDir, "cjs-case.js"), "#!/usr/env node\n\nmodule.exports = 123\n");
    fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "pages", "index.js"),
      `import val from "../cjs-case.js";\nexport default function Home() { return \`JS: \${val}\`; }\n`,
    );

    await expect(
      build({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: {
          outDir: path.join(tmpDir, "dist", "client"),
          rolldownOptions: { output: { entryFileNames: "entry.js" } },
        },
      }),
    ).resolves.toBeDefined();
  }, 180_000);
});
