/**
 * Tests that CSS imports from node_modules packages don't crash SSR.
 *
 * When a node_modules package imports a `.css` file, Vite must process it
 * through its transform pipeline (not Node's native ESM loader, which can't
 * handle non-JS extensions). The `noExternal: true` config ensures this.
 *
 * Relates to: https://github.com/nicepkg/vinext/issues/270
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

    // Symlink node_modules from repo root
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    // Create a fake package that imports .css
    const fakePkgDir = path.join(tmpDir, "node_modules", "fake-css-lib");
    await fs.mkdir(fakePkgDir, { recursive: true });
    await fs.writeFile(
      path.join(fakePkgDir, "package.json"),
      JSON.stringify({ name: "fake-css-lib", version: "1.0.0", type: "module", main: "index.js" }),
    );
    await fs.writeFile(
      path.join(fakePkgDir, "styles.css"),
      `.fake-css-lib { color: red; }`,
    );
    await fs.writeFile(
      path.join(fakePkgDir, "index.js"),
      `import "./styles.css";\nexport function FakeComponent() { return "fake-css-lib-rendered"; }\n`,
    );

    // Pages Router structure
    const pagesDir = path.join(tmpDir, "pages");
    await fs.mkdir(pagesDir, { recursive: true });

    await fs.writeFile(
      path.join(pagesDir, "index.tsx"),
      `import { FakeComponent } from "fake-css-lib";

export default function Page() {
  return (
    <div>
      <h1 id="nm-css-test">node-modules-css-pages-works</h1>
      <p>{FakeComponent()}</p>
    </div>
  );
}`,
    );

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

  it("renders page that imports CSS from node_modules without crashing", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("node-modules-css-pages-works");
    expect(html).toContain("fake-css-lib-rendered");
  });
});
