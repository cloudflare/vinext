/**
 * Next.js Compatibility Tests: app-css
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-css
 *
 * Tests CSS handling in the App Router at the SSR level:
 * - CSS module class names are scoped (not literal) in SSR HTML
 * - CSS module page renders content
 * - Global CSS page renders content
 * - Global CSS class names are preserved (not scoped) in SSR HTML
 *
 * NOTE: Full CSS validation (computed styles, visual appearance) requires
 * Playwright. These tests only verify SSR-level class name handling.
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/css-test/
 * - fixtures/app-basic/app/nextjs-compat/css-test/global/
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";
import vinext from "../../packages/vinext/src/index.js";

describe("Next.js compat: app-css", () => {
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

  // ── CSS Modules ─────────────────────────────────────────────
  // Next.js: CSS module class names should be scoped in SSR
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-css

  it("CSS module class name is applied in SSR HTML", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test");
    // The h1 should have a scoped class name, NOT the literal "heading"
    // Vite CSS modules produce class names like `_heading_xxxxx_x`
    // Match an id="css-page" element with a class attribute that is NOT just "heading"
    const classMatch = html.match(/id="css-page"\s+class="([^"]*)"/);
    expect(classMatch).not.toBeNull();
    const className = classMatch![1];
    // The scoped class name should NOT be the literal unscoped name
    expect(className).not.toBe("heading");
    // It should contain some transformation of "heading"
    expect(className.length).toBeGreaterThan(0);
  });

  it("CSS module page renders content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test");
    expect(html).toContain("CSS Module Test");
  });

  // ── Global CSS ──────────────────────────────────────────────
  // Next.js: global CSS class names should be preserved in SSR

  it("global CSS page renders content", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test/global");
    expect(html).toContain("Global CSS Test");
  });

  it("global CSS class name is preserved in SSR", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/css-test/global");
    // Global CSS class names are NOT scoped — should appear as-is
    expect(html).toContain('class="global-heading"');
  });

  // Ported from Next.js: test/e2e/app-dir/app-css-pageextensions/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-css-pageextensions/index.test.ts
  it("loads global CSS imported from src/app/layout", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-src-app-css-"));
    let srcServer: ViteDevServer | undefined;
    try {
      await fs.mkdir(path.join(tmpDir, "src", "app"), { recursive: true });
      await fs.symlink(
        path.resolve(import.meta.dirname, "../../node_modules"),
        path.join(tmpDir, "node_modules"),
        "junction",
      );
      await fs.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ type: "module", dependencies: { react: "*", "react-dom": "*" } }),
      );
      await fs.writeFile(
        path.join(tmpDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "#/*": ["./src/*"] } } }),
      );
      await fs.writeFile(
        path.join(tmpDir, "src", "app", "globals.css"),
        `.src-layout-global { color: rgb(12, 34, 56); }`,
      );
      await fs.writeFile(
        path.join(tmpDir, "src", "app", "layout.tsx"),
        `import "#/app/globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );
      await fs.writeFile(
        path.join(tmpDir, "src", "app", "page.tsx"),
        `export default function Page() {
  return <h1 className="src-layout-global">Layout Global CSS</h1>;
}
`,
      );

      srcServer = await createServer({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: path.join(tmpDir, "src") })],
        logLevel: "silent",
        server: { port: 0 },
      });
      await srcServer.listen();
      const addr = srcServer.httpServer?.address();
      if (!addr || typeof addr !== "object") {
        throw new Error("Expected fixture dev server to listen on a TCP port");
      }
      const srcBaseUrl = `http://localhost:${addr.port}`;
      const { html } = await fetchHtml(srcBaseUrl, "/");
      const cssHrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"[^>]*>/g)].map(
        (match) => match[1],
      );
      expect(cssHrefs.length).toBeGreaterThan(0);

      const cssBodies = await Promise.all(
        cssHrefs.map(async (href) => {
          const response = await fetch(new URL(href, srcBaseUrl));
          return response.text();
        }),
      );
      expect(cssBodies.join("\n")).toContain(".src-layout-global");
    } finally {
      await srcServer?.close();
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  // ── Browser-only tests (documented, not ported) ──────────────
  //
  // The following tests require Playwright and are N/A for HTTP-level testing:
  //
  // N/A: Computed styles (color, font-size, font-weight)
  //   Tests actual CSS property values in the browser
  //
  // N/A: CSS-in-JS (styled-components, emotion, etc.)
  //   Tests client-side CSS injection libraries
  //
  // N/A: CSS HMR (hot module replacement)
  //   Tests live CSS updates during development
  //
  // N/A: Tailwind CSS class application
  //   Tests utility classes resolved at build time
  //
  // N/A: CSS ordering / specificity
  //   Tests style cascade behavior in the browser
});
