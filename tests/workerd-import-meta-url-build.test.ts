import { afterAll, describe, expect, it } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createBuilder } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/workerd-import-meta-url");
const DEPENDENCY_ID = path.join(APP_FIXTURE_DIR, "node_modules/dep-with-guard/index.js");
// Keep the raw source in a non-JS fixture so the formatter cannot relocate the
// pre-parenthesis comment into the argument list and weaken this regression.
const DEPENDENCY_SOURCE = path.join(APP_FIXTURE_DIR, "deps/dep-with-guard/index.fixture.js.txt");

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

async function buildFixture(): Promise<string> {
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
            if (source === "dep-with-guard") return DEPENDENCY_ID;
          },
          async load(id) {
            if (id === DEPENDENCY_ID) return fs.readFile(DEPENDENCY_SOURCE, "utf8");
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

    return rscOutDir;
  } finally {
    await fs.unlink(nodeModulesLink).catch(() => {});
  }
}

describe("bundled dependency import.meta.url regression", () => {
  let serverDir: string | null = null;

  afterAll(async () => {
    if (serverDir) {
      await fs.rm(path.dirname(serverDir), { recursive: true, force: true });
    }
  });

  it("preserves fileURLToPath module identity across an annotated call", async () => {
    serverDir = await buildFixture();
    const code = await readJavaScriptTree(serverDir);

    expect(code).toContain("fileURLToPath");
    // No bare unguarded call may remain, including minified forms.
    expect(code).not.toMatch(/fileURLToPath\(\s*import\.meta\.url\s*\)/);
  });
});
