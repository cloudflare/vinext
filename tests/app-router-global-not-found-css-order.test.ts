/**
 * Regression test for issue #1549 — production CSS ordering for
 * `app/global-not-found.tsx`.
 *
 * Ported from Next.js:
 * test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
 * (the `should serve styles in the correct order for global-not-found` case)
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
 *
 * Why a *production* build test (not the dev-server SSR test in
 * tests/nextjs-compat/global-not-found.test.ts):
 *
 * The bug only manifests in the production RSC build. When the root layout and
 * `app/global-not-found.tsx` import the same stylesheet, Vite/Rolldown can
 * dedupe the shared import into the layout's CSS bundle. The 404 document then
 * links that layout bundle too, where green comes after red and wins the
 * cascade. The fix isolates global-not-found side-effect stylesheet imports
 * with a private query so the 404 document owns its CSS resource separately.
 *
 * Fixture: tests/fixtures/global-not-found-css-order/
 *   - layout.tsx imports red.css then green.css -> green wins (matched routes)
 *   - global-not-found.tsx imports the same red.css -> red must win on
 *     route-miss 404s, including the literal /404 path.
 *
 * Assertions mirror upstream: the 404 document must link ONLY
 * global-not-found's stylesheet and must NOT carry the root layout's green
 * stylesheet.
 *
 * The fixture also includes a lazy `react-dom/server.edge` import for issue
 * #2073. Importing the production RSC entry must not eagerly evaluate React's
 * throwing server-component stub.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/global-not-found-css-order");

/**
 * Extract the contents of every `<link rel="stylesheet">` href in document
 * order. CSS cascade is order-sensitive, so order matters for the assertion.
 */
function extractCssLinks(html: string): string[] {
  const hrefs: string[] = [];
  const linkRe = /<link\b[^>]*\brel="stylesheet"[^>]*>/gi;
  for (const m of html.matchAll(linkRe)) {
    const hrefMatch = /\bhref="([^"]+)"/i.exec(m[0]);
    if (hrefMatch) hrefs.push(hrefMatch[1]);
  }
  return hrefs;
}

/**
 * Read the built CSS bundle for a given stylesheet href so we can assert on
 * the *rule* that wins, independent of hashed filenames. Hrefs look like
 * `/_next/static/<hash>.css`; map them onto the client output tree.
 */
function readCssAsset(clientDir: string, href: string): string {
  const rel = href.replace(/^\//, "");
  const full = path.join(clientDir, rel);
  return fs.readFileSync(full, "utf-8");
}

describe("App Router: global-not-found CSS order (production, #1549)", () => {
  const distDir = path.resolve(FIXTURE_DIR, "dist");
  const clientDir = path.join(distDir, "client");
  let previewServer: Awaited<ReturnType<typeof preview>>;
  let baseUrl: string;
  let startupImportValidated = false;

  beforeAll(async () => {
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      logLevel: "silent",
    });
    await builder.buildApp();
  }, 120_000);

  async function startPreviewServer(): Promise<void> {
    if (!startupImportValidated) {
      throw new Error("The direct RSC entry import assertion must run before preview startup");
    }
    if (previewServer) return;
    previewServer = await preview({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: FIXTURE_DIR })],
      preview: { port: 0 },
      logLevel: "silent",
    });
    const addr = previewServer.httpServer.address();
    baseUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
    expect(baseUrl).not.toBe("");
  }

  afterAll(() => {
    previewServer?.httpServer.close();
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it("does not eagerly evaluate dynamically imported React server stubs", async () => {
    const entryUrl = pathToFileURL(path.join(distDir, "server", "index.js"));
    entryUrl.searchParams.set("test", String(Date.now()));

    await expect(import(entryUrl.href)).resolves.toBeDefined();
    startupImportValidated = true;
  });

  it("matched routes serve the root layout's CSS (green wins)", async () => {
    await startPreviewServer();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const links = extractCssLinks(html);
    // The home page is wrapped by the root layout, so its CSS must be present.
    expect(links.length).toBeGreaterThanOrEqual(1);
    const css = links.map((h) => readCssAsset(clientDir, h)).join("\n");
    expect(css).toContain("green");
  });

  it("route-miss 404 serves global-not-found's CSS with red winning, and no layout CSS leak", async () => {
    await startPreviewServer();
    for (const pathname of ["/does-not-exist", "/404"]) {
      const res = await fetch(`${baseUrl}${pathname}`);
      expect(res.status).toBe(404);
      const html = await res.text();
      // global-not-found.tsx ships its own document.
      expect(html).toContain('data-global-not-found="true"');

      const links = extractCssLinks(html);
      expect(links.length).toBeGreaterThanOrEqual(1);

      const allCss = links.map((h) => readCssAsset(clientDir, h)).join("\n");

      // The literal upstream failure path is /404. The global-not-found module
      // imports the same red.css as the root layout, so production builds must
      // isolate that import instead of linking the layout bundle where green
      // wins the cascade.
      expect(allCss).toContain("background-color:red");
      expect(allCss).not.toContain("green");
    }
  });
});
