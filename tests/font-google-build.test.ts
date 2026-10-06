import { describe, it, expect, afterAll } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { toSlash } from "pathslash";
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

describe("font-google build with a font cache written elsewhere", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  // Copy the fixture to `<tmp>/project (copy)` (the name macOS gives a
  // duplicated folder) and build it once with Google Fonts reachable, so
  // `.vinext/fonts/` holds a real cache.
  async function buildCopyOnline(): Promise<{ tmpDir: string; root: string }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-font-cache-elsewhere-"));
    tmpDirs.push(tmpDir);
    const root = path.join(tmpDir, "project (copy)");
    await fs.cp(APP_FIXTURE_DIR, root, {
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
    await buildFixtureAt(root, path.join(tmpDir, "out-first"));
    return { tmpDir, root };
  }

  // A refetch would write this checkout's own cache and hide the bug, so
  // the next build must be served entirely from the existing cache.
  function goOffline() {
    server.use(http.get("https://fonts.googleapis.com/*", () => HttpResponse.error()));
  }

  // Assert that the server output self-hosts fonts and that every served URL
  // names a file in `root`'s cache: `writeBundle` copies
  // `.vinext/fonts/<relative>` to `_vinext_fonts/<relative>`.
  async function expectServedFontUrls(outDir: string, root: string): Promise<void> {
    const serverJs = await readAllJs(path.join(outDir, "server"));
    const servedFiles = [
      ...new Set(
        [...serverJs.matchAll(/\/_next\/static\/_vinext_fonts\/([\w./-]+?\.woff2)/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    expect(servedFiles.length).toBeGreaterThan(0);
    for (const file of servedFiles) {
      await expect(fs.access(path.join(root, ".vinext", "fonts", file))).resolves.toBeUndefined();
    }
  }

  it("serves fonts cached by the checkout's previous location", async () => {
    const { tmpDir, root } = await buildCopyOnline();
    const movedRoot = path.join(tmpDir, "moved");
    await fs.rename(root, movedRoot);
    goOffline();

    const outDir = path.join(tmpDir, "out-moved");
    await buildFixtureAt(movedRoot, outDir);

    const serverJs = await readAllJs(path.join(outDir, "server"));
    expect(serverJs).not.toContain("/.vinext/fonts/");
    expect(serverJs).not.toContain("project (copy)");
    expect(serverJs).not.toContain("__VINEXT_FONT_CACHE_DIR__");
    await expectServedFontUrls(outDir, movedRoot);
  }, 240000);

  it("falls back to an earlier version's cache offline only when this checkout wrote it", async () => {
    const { tmpDir, root } = await buildCopyOnline();

    // Rewrite the cache into the format earlier vinext versions wrote:
    // `style.css` holding the absolute path of the checkout that fetched it,
    // as Vite resolved it (through symlinks such as macOS's `/var`).
    const cacheDir = path.join(root, ".vinext", "fonts");
    const writtenCacheDir = toSlash(await fs.realpath(cacheDir));
    const fontDirs = await fs.readdir(cacheDir);
    expect(fontDirs.length).toBeGreaterThan(0);
    for (const fontDirName of fontDirs) {
      const fontDir = path.join(cacheDir, fontDirName);
      const css = await fs.readFile(path.join(fontDir, "style.v2.css"), "utf-8");
      await fs.rm(path.join(fontDir, "style.v2.css"));
      await fs.writeFile(
        path.join(fontDir, "style.css"),
        css.replaceAll("__VINEXT_FONT_CACHE_DIR__", writtenCacheDir),
      );
    }
    goOffline();

    // Written from this checkout: self-hosted from the old cache.
    const fallbackOutDir = path.join(tmpDir, "out-fallback");
    await buildFixtureAt(root, fallbackOutDir);
    await expectServedFontUrls(fallbackOutDir, root);
    expect(await readAllJs(path.join(fallbackOutDir, "server"))).not.toContain("/.vinext/fonts/");

    // Written from another path: its URLs would 404, so the font is treated
    // as uncached and the runtime falls back to the Google Fonts CDN.
    const movedRoot = path.join(tmpDir, "moved");
    await fs.rename(root, movedRoot);
    const movedOutDir = path.join(tmpDir, "out-moved");
    await buildFixtureAt(movedRoot, movedOutDir);
    const movedJs = await readAllJs(path.join(movedOutDir, "server"));
    expect(movedJs).not.toContain("/_next/static/_vinext_fonts/");
    expect(movedJs).not.toContain("/.vinext/fonts/");
    expect(movedJs).not.toContain("project (copy)");
  }, 360000);
});
