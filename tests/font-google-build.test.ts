import { describe, it, expect, afterAll } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/font-google-multiple");

/**
 * Build an App Router fixture's RSC/SSR/client bundles using the actual Vite
 * build pipeline (createBuilder + buildApp). This exercises the full build
 * pipeline for font-google transforms.
 */
async function buildFontGoogleMultipleFixture(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-font-google-multiple-"));

  const rscOutDir = path.join(outDir, "server");
  const ssrOutDir = path.join(outDir, "server", "ssr");
  const clientOutDir = path.join(outDir, "client");

  // Mock fetch before building to avoid network calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes("Geist") && !url.includes("Mono")) {
      return new Response("@font-face { font-family: 'Geist'; src: url(/geist.woff2); }", {
        status: 200,
        headers: { "content-type": "text/css" },
      });
    }
    return new Response("@font-face { font-family: 'Geist Mono'; src: url(/geist-mono.woff2); }", {
      status: 200,
      headers: { "content-type": "text/css" },
    });
  };

  const nodeModulesLink = path.join(APP_FIXTURE_DIR, "node_modules");

  try {
    // Symlink node_modules before building so imports work
    const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(projectNodeModules, nodeModulesLink);

    const builder = await createBuilder({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [
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

    return path.join(outDir, "server", "index.mjs");
  } finally {
    globalThis.fetch = originalFetch;
    // Cleanup symlink
    await fs.unlink(nodeModulesLink).catch(() => {});
  }
}

describe("font-google build integration", () => {
  let buildOutputPath: string;
  let outDir: string;

  afterAll(async () => {
    // Cleanup temp directory
    if (outDir) {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("should build successfully with multiple Google fonts (Geist + Geist_Mono)", async () => {
    // This test validates that the build pipeline can handle multiple
    // Google font imports without errors. It exercises the font transform
    // plugin during the full createBuilder + buildApp() flow.
    buildOutputPath = await buildFontGoogleMultipleFixture();
    outDir = path.dirname(path.dirname(buildOutputPath));

    // Verify the build produced output
    expect(buildOutputPath).toBeTruthy();
    const stats = await fs.stat(buildOutputPath);
    expect(stats.isFile()).toBe(true);
  }, 120000); // 2 minute timeout for full build
});
