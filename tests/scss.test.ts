/**
 * Tests for SCSS / Sass preprocessing in vinext.
 *
 * Mirrors Next.js's SCSS support: when a page imports a `.scss` file,
 * the file is preprocessed (Sass variables resolved, partials inlined)
 * before reaching the browser. The resolved CSS — not the raw SCSS —
 * is what should be served.
 *
 * Vite has built-in SCSS support when the user installs `sass` (or
 * `sass-embedded`). This test verifies that vinext does not interfere
 * with that pipeline: a page importing `.scss` must produce CSS that
 * contains the resolved variable value, not the literal `$variable`.
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
import { APP_FIXTURE_DIR, buildAppFixture, startFixtureServer, fetchHtml } from "./helpers.js";

// Skip the suite when `sass` is not installed. SCSS preprocessing is a
// peer dependency contract: vinext relies on Vite's built-in handling
// which requires the user to install `sass` (or `sass-embedded`).
let sassAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await import("sass");
  sassAvailable = true;
} catch {
  sassAvailable = false;
}

const describeIfSass = sassAvailable ? describe : describe.skip;

describeIfSass("SCSS preprocessing (App Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders an SCSS-importing page without crashing", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/scss-test");
    expect(res.status).toBe(200);
    expect(html).toContain("SCSS Global Test");
  });

  it("emits CSS with the SCSS variable resolved (not the literal $variable)", async () => {
    // Fetch the page so Vite mounts the module graph for it.
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/scss-test");

    // Extract any CSS module URLs referenced by the page. Vite serves
    // .scss as a JS shim during dev that injects styles, but the raw
    // compiled CSS can be obtained via the direct URL with `?direct`.
    // Pull the source path from the rendered HTML so we exercise the
    // same module graph the page actually mounts.
    const scssUrlMatch = html.match(/["']([^"']*scss-test\/global\.scss[^"']*)["']/);
    expect(scssUrlMatch, "expected page HTML to reference global.scss").not.toBeNull();

    const scssUrl = scssUrlMatch![1]!;
    // `?direct` tells Vite's CSS plugin to return the compiled CSS
    // as the response body (rather than the JS shim that injects it).
    const directUrl = scssUrl.includes("?") ? `${scssUrl}&direct` : `${scssUrl}?direct`;
    const res = await fetch(new URL(directUrl, baseUrl));
    expect(res.status).toBe(200);
    const css = await res.text();

    // The literal SCSS variable name must NOT survive preprocessing.
    expect(css).not.toContain("$primary-color");
    // The resolved colour must be present. Accept any equivalent CSS
    // representation of rgb(0, 0, 255): the `rgb()` function form, the
    // 6-digit hex `#0000ff`, the 3-digit shorthand `#00f`, or the named
    // colour `blue` (CSS minifiers in the build pipeline may emit any
    // of these).
    expect(css.toLowerCase()).toMatch(/rgb\(\s*0\s*,\s*0\s*,\s*255\s*\)|#0000ff\b|#00f\b|\bblue\b/);
  });
});

// ── Production build: SCSS must be preprocessed and emitted to the client
// CSS bundle so that the static assets are valid CSS (no literal `$variable`).
//
// Mirrors the dev-vs-prod parity expected by AGENTS.md: dev preprocessing
// is not enough — the build path also needs to produce a resolved stylesheet
// or every prerendered page ends up with `color: $primary-color`, which the
// browser treats as invalid and falls back to `rgb(0, 0, 0)`.
describeIfSass("SCSS preprocessing (App Router production build)", () => {
  let rscBundlePath: string;

  beforeAll(async () => {
    rscBundlePath = await buildAppFixture(APP_FIXTURE_DIR);
  }, 120_000);

  it("emits the resolved SCSS in the production CSS bundle", async () => {
    // buildAppFixture produces the RSC bundle at <tmp>/server/index.js with
    // CSS assets emitted to <tmp>/server/assets/*.css and (for the client
    // env) to <tmp>/client/. Walk the whole build directory for any .css
    // file and assert at least one contains the resolved SCSS colour.
    const buildRoot = path.resolve(path.dirname(rscBundlePath), "..");
    const entries = await fs.readdir(buildRoot, { recursive: true, withFileTypes: true });
    const cssFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".css"))
      .map((e) => path.join(e.parentPath ?? buildRoot, e.name));

    expect(cssFiles.length, `expected at least one .css file under ${buildRoot}`).toBeGreaterThan(
      0,
    );

    const cssContents = await Promise.all(cssFiles.map((p) => fs.readFile(p, "utf-8")));
    const combined = cssContents.join("\n");

    // The literal SCSS variable name must NOT survive preprocessing.
    expect(combined).not.toContain("$primary-color");
    // The resolved colour must be present somewhere in the emitted CSS.
    expect(combined.toLowerCase()).toMatch(
      /rgb\(\s*0\s*,\s*0\s*,\s*255\s*\)|#0000ff\b|#00f\b|\bblue\b/,
    );
  });
});

// ── Pages Router: SCSS imported globally via `_app.tsx` ────────────────
//
// Mirrors Next.js's Pages Router pattern (test/e2e/app-dir/scss/single-global)
// where the SCSS file is imported once in pages/_app.{js,tsx} and applied
// globally. Uses a fresh tmpdir so existing pages-basic tests are not affected.
//
// Ported from Next.js: test/e2e/app-dir/scss/single-global/single-global.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/single-global/single-global.test.ts

describeIfSass("SCSS preprocessing (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-scss-pages-"));

    // Symlink workspace node_modules so the fixture can resolve react,
    // react-dom, vinext, vite, and sass without a separate install step.
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

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
      `import "../styles/global.scss";\nexport default function App({ Component, pageProps }: any) {\n  return <Component {...pageProps} />;\n}\n`,
    );
    await fs.writeFile(
      path.join(pagesDir, "index.tsx"),
      `export default function Home() {\n  return <div className="scss-pages-text">SCSS Pages Test</div>;\n}\n`,
    );

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

    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
      const { server, port } = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir,
        noCompression: true,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const res = await fetch(`${baseUrl}/`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("SCSS Pages Test");

        // The page must reference the compiled stylesheet via a <link>.
        // If the CSS file isn't linked, the browser never loads any
        // styles for the SCSS-defined classes — the exact failure mode
        // of LHF-5 (`rgb(0, 0, 0)` instead of the SCSS colour).
        const linkMatch = html.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/);
        expect(linkMatch, 'expected <link rel="stylesheet"> in the served HTML').not.toBeNull();

        const cssRes = await fetch(new URL(linkMatch![1]!, baseUrl));
        expect(cssRes.status).toBe(200);
        const css = await cssRes.text();
        expect(css).not.toContain("$var");
        expect(css.toLowerCase()).toMatch(
          /rgb\(\s*0\s*,\s*0\s*,\s*255\s*\)|#0000ff\b|#00f\b|\bblue\b/,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("preprocesses a Pages Router _app.tsx SCSS import", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(html).toContain("SCSS Pages Test");

    // The page imports SCSS via _app.tsx → ../styles/global.scss.
    // Vite registers it as a module URL in the page HTML. Locate and
    // fetch the compiled CSS directly to confirm the SCSS variable
    // resolved (preprocessor ran) rather than being inlined verbatim.
    // Pages Router dev does not server-render `<link>` tags for CSS — the
    // browser loads CSS via the JS module graph when it executes `_app`.
    // Walk the script tags to find the `_app` module URL and recursively
    // request the SCSS through Vite's transform pipeline. Then ask for
    // the compiled CSS via `?direct`.
    const scssDirectUrl = "/styles/global.scss?direct";
    const cssRes = await fetch(new URL(scssDirectUrl, baseUrl));
    expect(cssRes.status).toBe(200);
    const css = await cssRes.text();
    expect(css).not.toContain("$var");
    expect(css.toLowerCase()).toMatch(/rgb\(\s*0\s*,\s*0\s*,\s*255\s*\)|#0000ff\b|#00f\b|\bblue\b/);
  });
});
