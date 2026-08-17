import { describe, it, expect, afterAll } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createBuilder } from "vite-plus";
import { http, HttpResponse } from "msw";
import { server } from "./_msw/server.js";
import vinext from "../packages/vinext/src/index.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/font-google-multiple");

async function buildFontGoogleMultipleFixture(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-font-google-multiple-"));

  const rscOutDir = path.join(outDir, "server");
  const ssrOutDir = path.join(outDir, "server", "ssr");
  const clientOutDir = path.join(outDir, "client");

  const nodeModulesLink = path.join(APP_FIXTURE_DIR, "node_modules");

  try {
    // Intercept the Google Fonts CSS fetch issued by the in-process Vite build.
    // The server is configured with `FetchInterceptor` only (see `server.ts`),
    // so MSW intercepts `globalThis.fetch` — which is what Vite/vinext uses to
    // pull font CSS. Handlers are reset by the global `afterEach` in
    // `tests/_msw/setup.ts`.
    server.use(
      http.get("https://fonts.googleapis.com/*", ({ request }) => {
        const url = request.url;
        if (url.includes("Geist") && !url.includes("Mono")) {
          return HttpResponse.text(
            "/* latin */\n@font-face { font-family: 'Geist'; src: url(/geist.woff2); }",
            {
              headers: { "content-type": "text/css" },
            },
          );
        }
        return HttpResponse.text(
          "/* latin */\n@font-face { font-family: 'Geist Mono'; src: url(/geist-mono.woff2); }",
          { headers: { "content-type": "text/css" } },
        );
      }),
    );

    const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.rm(nodeModulesLink, { recursive: true, force: true });
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

    return path.join(outDir, "server", "index.js");
  } finally {
    await fs.unlink(nodeModulesLink).catch(() => {});
  }
}

// Concatenate every emitted `.js` file under `dir`. The server build is
// code-split across `_next/static/*` chunks, so the transformed font output is
// no longer guaranteed to live in `index.js` alone — the markers can land in
// any chunk (e.g. the layout/page chunks).
async function readAllJs(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return readAllJs(full);
      if (entry.name.endsWith(".js")) return fs.readFile(full, "utf-8");
      return "";
    }),
  );
  return parts.join("\n");
}

describe("font-google build integration", () => {
  let buildOutputPath: string;
  let outDir: string;

  afterAll(async () => {
    if (outDir) {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it("should build and transform multiple Google fonts (Geist + Geist_Mono)", async () => {
    buildOutputPath = await buildFontGoogleMultipleFixture();
    outDir = path.dirname(path.dirname(buildOutputPath));

    const content = await readAllJs(path.dirname(buildOutputPath));
    expect(content).toContain("Geist");
    expect(content).toContain("_vinext");
    expect(content).toContain("selfHostedCSS");
  }, 120000);
});
