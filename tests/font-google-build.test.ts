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

  await buildFixtureAt(APP_FIXTURE_DIR, outDir);
  return path.join(outDir, "server", "index.js");
}

async function buildFixtureAt(root: string, outDir: string): Promise<void> {
  const rscOutDir = path.join(outDir, "server");
  const ssrOutDir = path.join(outDir, "server", "ssr");
  const clientOutDir = path.join(outDir, "client");

  const nodeModulesLink = path.join(root, "node_modules");

  try {
    const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.rm(nodeModulesLink, { recursive: true, force: true });
    await fs.symlink(projectNodeModules, nodeModulesLink);

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [
        vinext({
          appDir: root,
          rscOutDir,
          ssrOutDir,
          clientOutDir,
        }),
      ],
      logLevel: "silent",
    });

    await builder.buildApp();
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

describe("font-google build from a moved checkout", () => {
  let tmpDir: string | undefined;

  afterAll(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("serves fonts cached by the checkout's previous location from its served URL", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-font-moved-checkout-"));
    const firstRoot = path.join(tmpDir, "project (copy)");
    const movedRoot = path.join(tmpDir, "moved");
    await fs.cp(APP_FIXTURE_DIR, firstRoot, {
      recursive: true,
      filter: (src) => {
        const name = path.basename(src);
        return name !== "node_modules" && name !== ".vinext";
      },
    });

    server.use(
      http.get("https://fonts.googleapis.com/*", ({ request }) => {
        const family = request.url.includes("Mono") ? "geist-mono" : "geist";
        return HttpResponse.text(
          `/* latin */\n@font-face { src: url(https://fonts.gstatic.com/s/${family}/v1/latin.woff2) format('woff2'); }`,
          { headers: { "content-type": "text/css" } },
        );
      }),
      http.get("https://fonts.gstatic.com/*", () =>
        HttpResponse.arrayBuffer(new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer, {
          headers: { "content-type": "font/woff2" },
        }),
      ),
    );
    await buildFixtureAt(firstRoot, path.join(tmpDir, "out-first"));

    await fs.rename(firstRoot, movedRoot);
    // A refetch would write this checkout's own paths and hide the bug, so the
    // second build must be served entirely from the moved `.vinext/fonts/` cache.
    server.use(http.get("https://fonts.googleapis.com/*", () => HttpResponse.error()));
    const movedOutDir = path.join(tmpDir, "out-moved");
    await buildFixtureAt(movedRoot, movedOutDir);

    const serverJs = await readAllJs(path.join(movedOutDir, "server"));
    expect(serverJs).toContain("/_next/static/_vinext_fonts/geist-");
    expect(serverJs).not.toContain("/.vinext/fonts/");
    expect(serverJs).not.toContain("project (copy)");

    // writeBundle copies `.vinext/fonts/<relative>` to `_vinext_fonts/<relative>`,
    // so every served URL must name a file in the moved checkout's cache.
    const servedFiles = [
      ...new Set(
        [...serverJs.matchAll(/\/_next\/static\/_vinext_fonts\/([\w./-]+?\.woff2)/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    expect(servedFiles.length).toBeGreaterThan(0);
    for (const file of servedFiles) {
      await expect(
        fs.access(path.join(movedRoot, ".vinext", "fonts", file)),
      ).resolves.toBeUndefined();
    }
  }, 240000);
});
