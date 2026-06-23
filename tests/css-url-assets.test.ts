/**
 * CSS url() asset dependencies must be emitted as static files (Next.js
 * `asset/resource` parity), and byte-identical sources must keep distinct
 * output filenames instead of collapsing under Vite/Rolldown content dedupe.
 *
 * Ported from Next.js test/e2e/app-dir/scss/url-global/url-global.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/url-global/url-global.test.ts
 *
 * The upstream fixture is SCSS, but the parity contract lives one layer lower
 * (once CSS reaches the bundler), so these exercise plain CSS against dedicated
 * minimal committed fixtures:
 *
 *   - tests/fixtures/css-url-assets-pages — Pages Router. styles/global.module.css
 *     references dark.svg and the byte-identical dark2.svg from one stylesheet
 *     (pages/index.tsx, the ported index page); split-{a,b}.module.css reference
 *     them from separate page chunks (pages/split-{a,b}.tsx).
 *   - tests/fixtures/css-url-assets-app — App Router. app/page.module.css is the
 *     counterpart referenced from a client-component page (app/page.tsx).
 *
 * Both svg sources have identical bytes, which is what makes the dedupe
 * collapse observable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { build, createBuilder } from "vite";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vinext from "../packages/vinext/src/index.js";
import { restoreDedupedCssAssetReferences } from "../packages/vinext/src/build/css-url-assets.js";
import { createIsolatedFixture } from "./helpers.js";

// Dedicated, minimal committed fixtures (not the large app-basic/pages-basic):
// these build in ~1-2s, so the suite stays fast and these tests don't contend
// for CPU with the heavyweight fixture builds running in parallel under CI.
const PAGES_CSS_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/css-url-assets-pages");
const APP_CSS_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/css-url-assets-app");
const CLOUDFLARE_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_PLUGIN_PATH = path.join(
  CLOUDFLARE_FIXTURE_DIR,
  "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
);
const WORKER_ENTRY_PATH = path
  .resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts")
  .replaceAll("\\", "/");

type CloudflarePluginFactory = (options?: {
  viteEnvironment?: { name: string; childEnvironments?: string[] };
}) => import("vite").Plugin;

const MEDIA_SVG_RE = (name: string) =>
  new RegExp(`^/_next/static/media/${name}\\.[A-Za-z0-9_-]+\\.svg$`);

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function extractStylesheetHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const hrefRe = /<link\s+rel="stylesheet"[^>]*\shref="([^"]+\.css)"/g;
  for (const match of html.matchAll(hrefRe)) {
    if (match[1]) hrefs.push(match[1]);
  }
  return hrefs;
}

function extractCssUrls(css: string): string[] {
  const urls: string[] = [];
  const urlRe = /url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/g;
  for (const match of css.matchAll(urlRe)) {
    const url = match[1] ?? match[2] ?? match[3];
    if (url) urls.push(url.trim());
  }
  return urls;
}

function svgUrls(css: string): string[] {
  return extractCssUrls(css).filter((url) => url.includes(".svg"));
}

function extractRedTextClassNames(code: string): string[] {
  return [...new Set(code.match(/_redText_[A-Za-z0-9_-]+_\d+/g) ?? [])];
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ── Unit: plugin phase metadata + inlined-chunk marker stripping ─────────────

function isPluginNamed(plugin: unknown, name: string): plugin is { name: string; apply?: unknown } {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    !Array.isArray(plugin) &&
    "name" in plugin &&
    plugin.name === name
  );
}

describe("CSS url() asset plugins", () => {
  it("marks and restores CSS URL assets only during build", () => {
    const plugins = vinext({ disableAppRouter: true });
    const markPlugin = plugins.find((plugin) =>
      isPluginNamed(plugin, "vinext:css-url-assets-mark"),
    );
    const restorePlugin = plugins.find((plugin) =>
      isPluginNamed(plugin, "vinext:css-url-assets-restore"),
    );

    expect(markPlugin).toMatchObject({ apply: "build" });
    expect(restorePlugin).toMatchObject({ apply: "build" });
  });
});

function makeChunkBundle(code: string) {
  return {
    "main.js": { type: "chunk" as const, fileName: "main.js", code },
  } as unknown as Parameters<typeof restoreDedupedCssAssetReferences>[0];
}

function stripChunk(code: string): string {
  const bundle = makeChunkBundle(code);
  restoreDedupedCssAssetReferences(bundle, () => {});
  return (bundle["main.js"] as { code: string }).code;
}

describe("restoreDedupedCssAssetReferences chunk handling", () => {
  it("strips the marker from CSS inlined into a JS chunk (Vite's escaped-quote layout)", () => {
    // `cssCodeSplit: false` / `?inline`: Vite JSON-stringifies the CSS into a JS
    // string, so a quoted `url("...")` becomes `url(\"...\")` with escaped
    // double quotes. The strip must be agnostic to that escaping.
    const css =
      '.x{background:url("/_next/static/media/dark.abc123.svg?vinext_css_url_asset=dark.svg")}';
    const code = `const css = ${JSON.stringify(css)};`;
    expect(code).toContain('\\"'); // sanity: realistic escaped-quote layout

    const bundle = makeChunkBundle(code);
    const emitted: unknown[] = [];
    restoreDedupedCssAssetReferences(bundle, (asset) => emitted.push(asset));

    const out = (bundle["main.js"] as { code: string }).code;
    expect(out).not.toContain("vinext_css_url_asset");
    expect(out).toContain("/_next/static/media/dark.abc123.svg");
    // The escaped quotes and surrounding URL are preserved.
    expect(out).toContain('url(\\"/_next/static/media/dark.abc123.svg\\")');
    // Inlined CSS URLs are already final; no sibling media files are emitted.
    expect(emitted).toHaveLength(0);
  });

  it("strips the marker from unquoted and single-quoted inlined url()", () => {
    expect(stripChunk("url(/m/dark.svg?vinext_css_url_asset=dark.svg)")).toBe("url(/m/dark.svg)");
    expect(stripChunk("url('/m/dark.svg?vinext_css_url_asset=dark.svg')")).toBe(
      "url('/m/dark.svg')",
    );
  });

  it("preserves other query params and fragments when stripping the marker", () => {
    expect(stripChunk("url(/m/dark.svg?vinext_css_url_asset=dark.svg&v=2)")).toBe(
      "url(/m/dark.svg?v=2)",
    );
    expect(stripChunk("url(/m/dark.svg?v=2&vinext_css_url_asset=dark.svg)")).toBe(
      "url(/m/dark.svg?v=2)",
    );
    expect(stripChunk("url(/m/dark.svg?v=2&vinext_css_url_asset=dark.svg&w=3)")).toBe(
      "url(/m/dark.svg?v=2&w=3)",
    );
    expect(stripChunk("url(/m/dark.svg?vinext_css_url_asset=dark.svg#f)")).toBe(
      "url(/m/dark.svg#f)",
    );
  });

  it("leaves chunks without the marker untouched", () => {
    const original = 'const css = ".x{background:url(/_next/static/media/dark.abc123.svg)}";';
    expect(stripChunk(original)).toBe(original);
  });
});

// ── Integration (Pages Router): build + serve the committed pages-basic ──────

describe("Pages Router CSS url() asset emission", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = await createIsolatedFixture(PAGES_CSS_FIXTURE, "vinext-css-url-pages-");
    const outDir = path.join(tmpDir, "dist");

    // Pages Router only — no RSC pipeline, so separate build() calls work.
    await build({
      root: tmpDir,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rollupOptions: { output: { entryFileNames: "entry.js" } },
      },
    });
    await build({
      root: tmpDir,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "client"),
        manifest: true,
        ssrManifest: true,
        rollupOptions: { input: "virtual:vinext-client-entry" },
      },
    });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    }));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 180_000);

  afterAll(async () => {
    if (server) await closeServer(server);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function fetchPageStylesheets(route: string): Promise<string> {
    const pageRes = await fetch(`${baseUrl}${route}`);
    expect(pageRes.status, `page ${route} should render`).toBe(200);
    const html = await pageRes.text();

    const hrefs = extractStylesheetHrefs(html);
    expect(hrefs.length, `expected a stylesheet link for ${route}:\n${html}`).toBeGreaterThan(0);

    const cssTexts: string[] = [];
    for (const href of hrefs) {
      const cssRes = await fetch(new URL(href, baseUrl));
      expect(cssRes.status, `stylesheet ${href} should be served`).toBe(200);
      cssTexts.push(await cssRes.text());
    }
    return cssTexts.join("\n");
  }

  async function expectServedSvg(assetUrl: string): Promise<void> {
    const res = await fetch(new URL(assetUrl, baseUrl));
    expect(res.status, `expected ${assetUrl} to be served`).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(await res.text()).toContain("<svg");
  }

  it("emits both byte-identical url() svgs from one stylesheet (url-global parity)", async () => {
    const css = await fetchPageStylesheets("/");
    expect(css).toContain("redText");

    const assetUrls = svgUrls(css);
    expect(assetUrls).toEqual([
      expect.stringMatching(MEDIA_SVG_RE("dark")),
      expect.stringMatching(MEDIA_SVG_RE("dark2")),
    ]);
    expect(new Set(assetUrls).size, "asset URLs should be unique").toBe(assetUrls.length);

    for (const assetUrl of assetUrls) await expectServedSvg(assetUrl);
  });

  it("preserves url() asset provenance across separate page CSS chunks", async () => {
    const cssA = await fetchPageStylesheets("/split-a");
    const cssB = await fetchPageStylesheets("/split-b");

    const aSvgs = svgUrls(cssA);
    const bSvgs = svgUrls(cssB);
    expect(aSvgs).toEqual([expect.stringMatching(MEDIA_SVG_RE("dark"))]);
    expect(bSvgs).toEqual([expect.stringMatching(MEDIA_SVG_RE("dark2"))]);
    expect(new Set([...aSvgs, ...bSvgs]).size, "split chunk URLs should be unique").toBe(
      aSvgs.length + bSvgs.length,
    );

    for (const assetUrl of [...aSvgs, ...bSvgs]) await expectServedSvg(assetUrl);
  });
});

// ── Integration (App Router): inspect plain and Cloudflare build output ──────

describe.each(["plain", "cloudflare"] as const)(
  "App Router CSS url() asset emission (%s build)",
  (buildTarget) => {
    let tmpDir: string;
    let clientDir: string;
    let serverDir: string;

    beforeAll(async () => {
      // Build an isolated copy so the client output (which vinext writes to
      // <root>/dist/client) lands in a temp dir instead of the committed fixture.
      // Borrow app-basic's node_modules for the RSC/React-server deps the App
      // Router build needs (@vitejs/plugin-rsc, react-server-dom-webpack, …).
      tmpDir = await createIsolatedFixture(
        APP_CSS_FIXTURE,
        "vinext-css-url-app-",
        undefined,
        path.join(CLOUDFLARE_FIXTURE_DIR, "node_modules"),
      );
      const plugins: import("vite").PluginOption[] = [vinext({ appDir: tmpDir })];
      if (buildTarget === "cloudflare") {
        await fs.mkdir(path.join(tmpDir, "worker"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, "wrangler.jsonc"),
          `{
  "name": "vinext-css-url-assets",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts",
  "assets": { "not_found_handling": "none", "binding": "ASSETS" }
}\n`,
        );
        await fs.writeFile(
          path.join(tmpDir, "worker/index.ts"),
          `import handler from ${JSON.stringify(WORKER_ENTRY_PATH)};\nexport default handler;\n`,
        );
        const { cloudflare } = (await import(pathToFileURL(CLOUDFLARE_PLUGIN_PATH).href)) as {
          cloudflare: CloudflarePluginFactory;
        };
        plugins.push(cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }));
      }
      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins,
        logLevel: "silent",
        build: { assetsInlineLimit: 0 },
      });
      await builder.buildApp();
      clientDir = path.join(tmpDir, "dist", "client");
      serverDir = path.join(tmpDir, "dist", "server");
    }, 180_000);

    afterAll(async () => {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it("emits both byte-identical page CSS module url() svgs under /_next/static/media/", async () => {
      const cssFiles = (await listFiles(clientDir)).filter((file) => file.endsWith(".css"));
      const cssTexts = await Promise.all(cssFiles.map((file) => fs.readFile(file, "utf-8")));
      const routeCss = cssTexts.find((text) => text.includes("redText"));
      expect(
        routeCss,
        "expected emitted client CSS containing the url-assets route class",
      ).toBeDefined();

      const assetUrls = svgUrls(routeCss ?? "");
      expect(assetUrls).toEqual([
        expect.stringMatching(MEDIA_SVG_RE("dark")),
        expect.stringMatching(MEDIA_SVG_RE("dark2")),
      ]);
      expect(new Set(assetUrls).size, "App Router asset URLs should be unique").toBe(
        assetUrls.length,
      );

      // Marker must not leak into emitted CSS.
      expect(routeCss).not.toContain("vinext_css_url_asset");

      // Each referenced media file must exist on disk in the client output.
      for (const assetUrl of assetUrls) {
        const stat = await fs.stat(path.join(clientDir, assetUrl));
        expect(stat.isFile(), `expected emitted asset ${assetUrl}`).toBe(true);
      }
    });

    it("uses the same CSS Module class name in server, client JS, and client CSS", async () => {
      const serverFiles = (await listFiles(serverDir)).filter((file) => file.endsWith(".js"));
      const serverCssFiles = (await listFiles(serverDir)).filter((file) => file.endsWith(".css"));
      const clientFiles = (await listFiles(clientDir)).filter((file) => file.endsWith(".js"));
      const cssFiles = (await listFiles(clientDir)).filter((file) => file.endsWith(".css"));

      const serverCode = (
        await Promise.all(serverFiles.map((file) => fs.readFile(file, "utf-8")))
      ).join("\n");
      const serverCss = (
        await Promise.all(serverCssFiles.map((file) => fs.readFile(file, "utf-8")))
      ).join("\n");
      const clientCode = (
        await Promise.all(clientFiles.map((file) => fs.readFile(file, "utf-8")))
      ).join("\n");
      const clientCss = (
        await Promise.all(cssFiles.map((file) => fs.readFile(file, "utf-8")))
      ).join("\n");

      const serverClassNames = extractRedTextClassNames(serverCode);
      const clientClassNames = extractRedTextClassNames(clientCode);
      const cssClassNames = extractRedTextClassNames(clientCss);

      expect(serverClassNames).toHaveLength(1);
      expect(clientClassNames).toEqual(serverClassNames);
      expect(cssClassNames).toEqual(serverClassNames);
      expect(serverCode).not.toContain("vinext_css_url_asset");
      expect(serverCss).not.toContain("vinext_css_url_asset");
      expect(clientCode).not.toContain("vinext_css_url_asset");
      expect(clientCss).not.toContain("vinext_css_url_asset");

      const serverAssetUrls = svgUrls(serverCss);
      const clientAssetUrls = svgUrls(clientCss);
      expect(serverAssetUrls).toEqual(clientAssetUrls);
      for (const assetUrl of serverAssetUrls) {
        const stat = await fs.stat(path.join(clientDir, assetUrl));
        expect(stat.isFile(), `expected SSR CSS asset ${assetUrl} in client output`).toBe(true);
      }
    });
  },
);
