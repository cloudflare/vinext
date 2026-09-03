import { afterAll, describe, expect, it } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createBuilder } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/workerd-import-meta-url");
const GUARDED_DEP_ID = path.join(APP_FIXTURE_DIR, "node_modules/dep-with-guard/index.js");
// Keep the raw source in a non-JS fixture so the formatter cannot relocate the
// pre-parenthesis comment into the argument list and weaken this regression.
const GUARDED_DEP_SOURCE = path.join(APP_FIXTURE_DIR, "deps/dep-with-guard/index.fixture.js.txt");

async function readJavaScriptTree(dir: string): Promise<string> {
  const files = await fs.readdir(dir, { recursive: true });
  let code = "";
  for (const file of files) {
    const full = path.join(dir, file);
    if ((await fs.stat(full)).isFile() && /\.(?:js|mjs)$/.test(file)) {
      code += await fs.readFile(full, "utf8");
    }
  }
  return code;
}

async function buildFixture(): Promise<{ serverDir: string; clientDir: string }> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-workerd-import-meta-url-"));

  const rscOutDir = path.join(outDir, "server");
  const ssrOutDir = path.join(outDir, "server", "ssr");
  const clientOutDir = path.join(outDir, "client");

  const nodeModulesLink = path.join(APP_FIXTURE_DIR, "node_modules");
  const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");

  await fs.rm(nodeModulesLink, { recursive: true, force: true });
  // Windows needs a junction (no admin rights); other platforms use symlink.
  await fs.symlink(
    projectNodeModules,
    nodeModulesLink,
    process.platform === "win32" ? "junction" : undefined,
  );

  try {
    const builder = await createBuilder({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [
        {
          name: "test:dep-with-guard",
          resolveId(source) {
            if (source === "dep-with-guard") return GUARDED_DEP_ID;
          },
          async load(id) {
            if (id === GUARDED_DEP_ID) return fs.readFile(GUARDED_DEP_SOURCE, "utf8");
          },
        },
        vinext({
          appDir: APP_FIXTURE_DIR,
          rscOutDir,
          ssrOutDir,
          clientOutDir,
        }),
      ],
      logLevel: "silent",
    });

    await builder.buildApp();

    return {
      serverDir: rscOutDir,
      clientDir: clientOutDir,
    };
  } finally {
    await fs.unlink(nodeModulesLink).catch(() => {});
  }
}

describe("vinext:workerd-import-meta-url-guard (build integration)", () => {
  let output: { serverDir: string; clientDir: string } | null = null;

  afterAll(async () => {
    if (output) {
      await fs.rm(path.dirname(output.serverDir), { recursive: true, force: true });
    }
  });

  it("guards fileURLToPath(import.meta.url) in the built server bundle", async () => {
    output = await buildFixture();
    const code = await readJavaScriptTree(output.serverDir);

    // The long-comment dependency call must be guarded in the final output.
    // Rolldown may minify whitespace and quote style in production chunks.
    expect(code).toMatch(/import\.meta\.url\?\.startsWith\(["'`]file:["'`]\)/);
    // No bare unguarded call may remain, including minified forms.
    expect(code).not.toMatch(/fileURLToPath\(\s*import\.meta\.url\s*\)/);
  });

  it("does not leak the guard into the client bundle", async () => {
    output ??= await buildFixture();
    // The minimal fixture config may not emit a client build; only assert
    // when one exists.
    if (!(await fs.stat(output.clientDir).catch(() => null))) return;
    const clientCode = await readJavaScriptTree(output.clientDir);
    expect(clientCode).not.toContain('import.meta.url?.startsWith("file:")');
  });
});
