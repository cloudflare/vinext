/**
 * Tests for SCSS / Sass preprocessing in vinext (Pages Router).
 *
 * Mirrors Next.js's SCSS support: when a page imports a `.scss` file,
 * the file is preprocessed (Sass variables resolved, partials inlined)
 * before reaching the browser. The resolved CSS — not the raw SCSS —
 * is what should be served, and crucially the served HTML must include
 * a `<link rel="stylesheet">` so the browser actually loads it.
 *
 * Vite has built-in SCSS support when the user installs `sass` (or
 * `sass-embedded`). vinext relies on that built-in handling; this test
 * verifies vinext does not interfere with the pipeline, and that a
 * stylesheet imported via `pages/_app.tsx` reaches the rendered HTML.
 * `sass` is a root devDependency, so the suite always runs.
 *
 * Uses a per-test tmpdir fixture rather than adding files to a shared
 * `tests/fixtures/*` tree, keeping the SCSS toolchain requirement out
 * of fixtures shared with non-SCSS tests.
 *
 * Ported from Next.js: test/e2e/app-dir/scss/single-global/single-global.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/single-global/single-global.test.ts
 *
 * Relates to LHF-5 in the deploy-suite e2e review
 * (https://github.com/cloudflare/vinext/actions/runs/25897889733).
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { build, createServer, type ViteDevServer } from "vite-plus";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";
import { fetchHtml } from "./helpers.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

// Regex for any CSS representation of rgb(0, 0, 255) — the SCSS variable
// value used across these tests. CSS minifiers in the build pipeline may
// emit any of these forms (rgb(), 6-digit hex, 3-digit hex, named colour).
const RESOLVED_BLUE_REGEX = /rgb\(\s*0\s*,\s*0\s*,\s*255\s*\)|#0000ff\b|#00f\b|\bblue\b/;

function getHtmlAttr(tag: string, attrName: string): string | null {
  const match = tag.match(new RegExp(`\\s${attrName}=(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function getStylesheetHrefs(html: string): string[] {
  return Array.from(html.matchAll(/<link\b[^>]*>/gi), (match) => match[0])
    .filter((tag) => getHtmlAttr(tag, "rel") === "stylesheet")
    .map((tag) => getHtmlAttr(tag, "href"))
    .filter((href): href is string => href !== null);
}

/**
 * Materialize a minimal Pages Router fixture in a fresh tmpdir.
 *
 * Imports the SCSS file via `pages/_app.tsx` to match Next.js's
 * `test/e2e/app-dir/scss/single-global/pages/_app.js` pattern. This
 * exercises the exact code path that fails in the LHF-5 cluster:
 * `_app`-imported CSS reaching the served HTML via `<link rel="stylesheet">`.
 *
 * Symlinks the workspace `node_modules` so the fixture can resolve
 * `react`, `react-dom`, `vinext`, and `sass` without an extra
 * install step.
 */
async function makePagesRouterScssFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-pages-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const stylesDir = path.join(tmpDir, "styles");
  await fs.mkdir(stylesDir, { recursive: true });
  await fs.writeFile(
    path.join(stylesDir, "global.scss"),
    "$var: rgb(0, 0, 255);\n.scss-pages-text {\n  color: $var;\n}\n",
  );

  const pagesDir = path.join(tmpDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(
    path.join(pagesDir, "_app.tsx"),
    'import "../styles/global.scss";\n' +
      "export default function App({ Component, pageProps }: any) {\n" +
      "  return <Component {...pageProps} />;\n" +
      "}\n",
  );
  await fs.writeFile(
    path.join(pagesDir, "index.tsx"),
    "export default function Home() {\n" +
      '  return <div className="scss-pages-text">SCSS Pages Test</div>;\n' +
      "}\n",
  );

  return tmpDir;
}

describe("SCSS preprocessing (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await makePagesRouterScssFixture();

    server = await createServer({
      root: tmpDir,
      configFile: false,
      plugins: [vinext({ appDir: tmpDir })],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    });

    await server.listen();
    const addr = server.httpServer?.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://localhost:${addr.port}`;
    }
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("preprocesses a Pages Router _app.tsx SCSS import in dev", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(html).toContain("SCSS Pages Test");

    // Pages Router dev must emit the _app stylesheet as an initial blocking
    // link, matching Next.js's shared /_app asset handling and avoiding FOUC.
    const stylesheetHref = getStylesheetHrefs(html).find((href) =>
      href.endsWith("/styles/global.scss"),
    );
    expect(stylesheetHref).toBe("/styles/global.scss");

    // Fetch the exact linked stylesheet URL to confirm the browser-facing CSS
    // is served and Sass variables resolved before it reaches the browser.
    const cssRes = await fetch(new URL(stylesheetHref!, baseUrl));
    expect(cssRes.status).toBe(200);
    const css = await cssRes.text();
    expect(css).not.toContain("$var");
    expect(css.toLowerCase()).toMatch(RESOLVED_BLUE_REGEX);
  });

  it("links and serves resolved SCSS through the production Pages Router server", async () => {
    // End-to-end production parity check. Mirrors what a Next.js
    // SCSS deploy test does at runtime: build → start prod server →
    // fetch page → assert the linked stylesheet has the resolved colour.
    // A failure here is what produces `rgb(0, 0, 0)` in the deploy suite
    // (the browser sees `color: $var` which is invalid CSS and falls back
    // to the user-agent default).
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-pages-build-"));
    try {
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
      const { server: prodServer, port } = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir,
        noCompression: true,
      });

      try {
        const prodUrl = `http://127.0.0.1:${port}`;
        const res = await fetch(`${prodUrl}/`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("SCSS Pages Test");

        // The page must reference the compiled stylesheet via a <link>.
        // If the CSS file isn't linked, the browser never loads any
        // styles for the SCSS-defined classes — the exact failure mode
        // of LHF-5 (`rgb(0, 0, 0)` instead of the SCSS colour).
        const stylesheetHref = getStylesheetHrefs(html).find((href) => href.endsWith(".css"));
        expect(stylesheetHref, 'expected <link rel="stylesheet"> in the served HTML').toBeTruthy();

        const cssRes = await fetch(new URL(stylesheetHref!, prodUrl));
        expect(cssRes.status).toBe(200);
        const css = await cssRes.text();
        expect(css).not.toContain("$var");
        expect(css.toLowerCase()).toMatch(RESOLVED_BLUE_REGEX);
      } finally {
        await new Promise<void>((resolve) => prodServer.close(() => resolve()));
      }
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
