import { describe, it, expect, afterAll } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic");

/**
 * Build an App Router fixture's RSC/SSR/client bundles using the actual Vite
 * build pipeline (createBuilder + buildApp). This exercises the full build
 * pipeline where issue #751 occurs, not just the transform hook in isolation.
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

  try {
    const builder = await createBuilder({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: APP_FIXTURE_DIR, rscOutDir, ssrOutDir, clientOutDir })],
      logLevel: "silent",
    });

    // This is where issue #751 occurs - during [1/5] analyze client references
    await builder.buildApp();

    // Symlink node_modules for external imports
    const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(projectNodeModules, path.join(outDir, "node_modules"));

    return path.join(outDir, "server", "index.js");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("font-google build integration (issue #751)", () => {
  let buildOutputPath: string;
  let outDir: string;

  afterAll(async () => {
    // Cleanup temp directory
    if (outDir) {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("should build successfully with multiple Google fonts (Geist + Geist_Mono)", async () => {
    // This test reproduces issue #751:
    // Build fails during [1/5] analyze client references... with:
    // Error: Unexpected token in app/layout.tsx at 234..235
    //
    // The issue occurs when using multiple fonts with the same options pattern:
    // const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
    // const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
    buildOutputPath = await buildFontGoogleMultipleFixture();
    outDir = path.dirname(path.dirname(buildOutputPath));

    // Verify the build produced output
    expect(buildOutputPath).toBeTruthy();
    const stats = await fs.stat(buildOutputPath);
    expect(stats.isFile()).toBe(true);
  }, 120000); // 2 minute timeout for full build
});
