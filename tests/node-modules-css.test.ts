/**
 * Tests that CSS imports from node_modules packages don't crash SSR.
 *
 * When a node_modules package imports a `.css` file, Vite must process it
 * through its transform pipeline (not Node's native ESM loader, which can't
 * handle non-JS extensions). The `noExternal: true` config ensures this.
 *
 * Relates to: https://github.com/cloudflare/vinext/issues/270
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "./helpers.js";

// ── App Router: node_modules CSS import ─────────────────────

describe("node_modules CSS import (App Router)", () => {
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

  it("renders page that imports CSS from node_modules without crashing", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/node-modules-css");
    expect(res.status).toBe(200);
    expect(html).toContain("node-modules-css-works");
    expect(html).toContain("fake-css-lib-rendered");
    expect(html).toContain("fake-css-module-rendered");
  });
});

// ── Pages Router: node_modules CSS import ────────────────────

describe("node_modules CSS import (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nm-css-pages-"));

    // Create a real node_modules dir (not a symlink, to avoid mutating workspace)
    const nmDir = path.join(tmpDir, "node_modules");
    await fs.mkdir(nmDir, { recursive: true });

    // Symlink only the packages this test actually needs from the repo root.
    // Symlinking only what's needed (rather than all entries) keeps the test
    // hermetic and avoids touching unrelated packages.
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    const requiredPackages = ["react", "react-dom", "vite", "@vitejs", "vinext"];
    for (const pkg of requiredPackages) {
      const src = path.join(rootNodeModules, pkg);
      const dest = path.join(nmDir, pkg);
      await fs.symlink(src, dest, "junction").catch((err) => {
        if (err.code !== "EEXIST") throw err;
      });
    }

    // Create fake packages that import .css and .module.css
    const fakeCssDir = path.join(nmDir, "fake-css-lib");
    await fs.mkdir(fakeCssDir, { recursive: true });
    await fs.writeFile(
      path.join(fakeCssDir, "package.json"),
      JSON.stringify({ name: "fake-css-lib", version: "1.0.0", type: "module", main: "index.js" }),
    );
    await fs.writeFile(path.join(fakeCssDir, "styles.css"), `.fake-css-lib { color: red; }`);
    await fs.writeFile(
      path.join(fakeCssDir, "index.js"),
      `import "./styles.css";\nexport function FakeComponent() { return "fake-css-lib-rendered"; }\n`,
    );

    const fakeCssModuleDir = path.join(nmDir, "fake-css-module-lib");
    await fs.mkdir(fakeCssModuleDir, { recursive: true });
    await fs.writeFile(
      path.join(fakeCssModuleDir, "package.json"),
      JSON.stringify({
        name: "fake-css-module-lib",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    await fs.writeFile(
      path.join(fakeCssModuleDir, "styles.module.css"),
      `.item { font-weight: bold; }`,
    );
    await fs.writeFile(
      path.join(fakeCssModuleDir, "index.js"),
      `import classes from "./styles.module.css";\nexport const styles = classes;\nexport function ModComponent() { return "fake-css-module-rendered"; }\n`,
    );

    // Pages Router structure
    const pagesDir = path.join(tmpDir, "pages");
    await fs.mkdir(pagesDir, { recursive: true });

    await fs.writeFile(
      path.join(pagesDir, "index.tsx"),
      `import { FakeComponent } from "fake-css-lib";
import { ModComponent } from "fake-css-module-lib";

export default function Page() {
  return (
    <div>
      <h1 id="nm-css-test">node-modules-css-pages-works</h1>
      <p>{FakeComponent()}</p>
      <p>{ModComponent()}</p>
    </div>
  );
}`,
    );

    // `appDir` points to the tmp project root. For a Pages Router test (no
    // `app/` directory) this just gives vinext a root to resolve from; the
    // plugin ignores the absence of `app/`.
    const plugins: any[] = [vinext({ appDir: tmpDir })];

    server = await createServer({
      root: tmpDir,
      configFile: false,
      plugins,
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    });

    await server.listen();
    const addr = server.httpServer?.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://localhost:${addr.port}`;
    }

    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("renders page that imports CSS and CSS modules from node_modules without crashing", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("node-modules-css-pages-works");
    expect(html).toContain("fake-css-lib-rendered");
    expect(html).toContain("fake-css-module-rendered");
  });
});
