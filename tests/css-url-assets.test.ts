/**
 * Pages Router global CSS url() assets must be emitted as static files.
 *
 * Ported from Next.js:
 * test/e2e/app-dir/scss/url-global/url-global.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/url-global/url-global.test.ts
 *
 * The upstream fixture uses SCSS, but the parity contract lives one layer
 * lower than Sass preprocessing: once CSS reaches the bundler, url() asset
 * dependencies are webpack `asset/resource` files under `/_next/static/media/`.
 */

import { describe, it, expect } from "vite-plus/test";
import { createBuilder } from "vite";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const DARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path fill="black" d="M0 0h2v2H0z"/></svg>\n`;
// The upstream fixture's two SVG files have identical bytes; that is what
// exposes content-based asset dedupe collapsing the second filename.
const DARK_2_SVG = DARK_SVG;

async function makePagesCssUrlFixture(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-css-url-assets-"));
  await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");

  const stylesDir = path.join(tmpDir, "styles");
  await fs.mkdir(stylesDir, { recursive: true });
  await fs.writeFile(path.join(stylesDir, "dark.svg"), DARK_SVG);
  await fs.writeFile(path.join(stylesDir, "dark2.svg"), DARK_2_SVG);
  await fs.writeFile(
    path.join(stylesDir, "global.css"),
    [
      ".red-text {",
      "  color: red;",
      '  background-image: url("./dark.svg"), url(dark2.svg);',
      "}",
      "",
    ].join("\n"),
  );

  const pagesDir = path.join(tmpDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(
    path.join(pagesDir, "_app.jsx"),
    [
      'import "../styles/global.css";',
      "",
      "export default function App({ Component, pageProps }) {",
      "  return <Component {...pageProps} />;",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(pagesDir, "index.jsx"),
    [
      "export default function Home() {",
      '  return <div className="red-text">This text should be red.</div>;',
      "}",
      "",
    ].join("\n"),
  );

  return tmpDir;
}

function extractStylesheetHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const hrefRe = /<link\s+rel="stylesheet"[^>]*\shref="([^"]+\.css)"/g;
  for (const match of html.matchAll(hrefRe)) {
    const href = match[1];
    if (href) hrefs.push(href);
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe("Pages Router CSS url() asset emission", () => {
  it("emits global CSS svg url() dependencies under /_next/static/media/", async () => {
    const tmpDir = await makePagesCssUrlFixture();
    try {
      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      const { server, port } = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: path.join(tmpDir, "dist"),
        noCompression: true,
      });

      try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const pageRes = await fetch(`${baseUrl}/`);
        expect(pageRes.status).toBe(200);
        const html = await pageRes.text();

        const stylesheetHrefs = extractStylesheetHrefs(html);
        expect(
          stylesheetHrefs.length,
          `expected a linked stylesheet in HTML:\n${html}`,
        ).toBeGreaterThan(0);

        const cssTexts: string[] = [];
        for (const href of stylesheetHrefs) {
          const cssRes = await fetch(new URL(href, baseUrl));
          expect(cssRes.status, `expected stylesheet ${href} to be served`).toBe(200);
          cssTexts.push(await cssRes.text());
        }

        const css = cssTexts.join("\n");
        expect(css).toContain("red-text");

        const assetUrls = extractCssUrls(css).filter((url) => url.includes(".svg"));
        expect(assetUrls).toHaveLength(2);
        expect(assetUrls).toEqual([
          expect.stringMatching(/^\/_next\/static\/media\/dark\.[A-Za-z0-9_-]+\.svg$/),
          expect.stringMatching(/^\/_next\/static\/media\/dark2\.[A-Za-z0-9_-]+\.svg$/),
        ]);

        for (const assetUrl of assetUrls) {
          const assetRes = await fetch(new URL(assetUrl, baseUrl));
          expect(assetRes.status, `expected ${assetUrl} to be served`).toBe(200);
          expect(assetRes.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
          expect(await assetRes.text()).toContain("<svg");
        }
      } finally {
        await closeServer(server);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);
});
