/**
 * Invalid `_next/static/*` paths should return a plain-text 404, not the
 * rendered HTML 404 page.
 *
 * Next.js short-circuits requests for invalid static assets with
 * `res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not Found')`
 * BEFORE the page renderer runs. This saves bandwidth on what is almost
 * certainly a misbehaving client requesting a stale chunk, and avoids the
 * cost of rendering a full HTML 404 document with bootstrap scripts and CSS.
 *
 * In vinext this falls out naturally from the static-file layer: the
 * default `assetsDir` is `_next/static/` (matching Next.js), and the prod
 * server's hashed-asset branch returns `404 + "Not Found"` on miss instead
 * of falling through to the RSC/SSR handler. The Cloudflare worker entry
 * applies the same plain-text 404 for misses (the ASSETS binding serves
 * hits before the worker runs).
 *
 * Source: `packages/next/src/server/lib/router-server.ts` in `.nextjs-ref`.
 *
 * Ported from Next.js:
 *   - test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages.test.ts
 *   - test/e2e/invalid-static-asset-404-app/invalid-static-asset-404-app.test.ts
 *   - test/e2e/invalid-static-asset-404-app/invalid-static-asset-404-app-base-path.test.ts
 *   - test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages-base-path.test.ts
 *   - test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages-asset-prefix.test.ts
 *
 * @see https://github.com/vercel/next.js/blob/canary/test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages.test.ts
 */

import { describe, it, expect, afterAll } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic");
const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

// ── App Router (production) ─────────────────────────────────────────────────

async function buildAppFixtureWithConfig(
  extraConfigJson: string,
  registerCleanup: (cleanup: () => void) => void,
): Promise<{ outDir: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-invalid-static-404-app-"));
  registerCleanup(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const fixtureRoot = path.join(tmpDir, "fixture");
  fs.cpSync(APP_FIXTURE_DIR, fixtureRoot, { recursive: true });
  const fixtureNodeModules = path.join(fixtureRoot, "node_modules");
  if (!fs.existsSync(fixtureNodeModules)) {
    fs.symlinkSync(ROOT_NODE_MODULES, fixtureNodeModules, "junction");
  }

  if (extraConfigJson) {
    const nextConfigPath = path.join(fixtureRoot, "next.config.ts");
    const original = fs.readFileSync(nextConfigPath, "utf-8");
    const patched = original.replace(
      "const nextConfig: NextConfig = {",
      `const nextConfig: NextConfig = {\n  ${extraConfigJson}`,
    );
    fs.writeFileSync(nextConfigPath, patched);
  }

  const outDir = path.join(fixtureRoot, "dist");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();
  return { outDir };
}

function findClientRuntimeManifestBuildId(outDir: string, pathPrefix: string): string | undefined {
  const prefixSegments = pathPrefix.split("/").filter(Boolean);
  const staticDir = path.join(outDir, "client", ...prefixSegments, "_next", "static");
  if (!fs.existsSync(staticDir)) return undefined;

  for (const entry of fs.readdirSync(staticDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(staticDir, entry.name, "_buildManifest.js"))) {
      return entry.name;
    }
  }

  return undefined;
}

describe("App Router invalid `_next/static/*` 404", () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });
  const register = (cleanup: () => void) => cleanups.push(cleanup);

  it("returns plain-text `Not Found` 404 for invalid `_next/static/*` (no prefix)", async () => {
    const built = await buildAppFixtureWithConfig("", register);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      const res = await fetch(`${baseUrl}/_next/static/nonexistent-chunk.js`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not Found");
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);

      // Sanity check: an unrelated invalid path still renders the rich HTML
      // 404 — only `_next/static/*` short-circuits to plain text.
      const htmlRes = await fetch(`${baseUrl}/totally-invalid-route`);
      expect(htmlRes.status).toBe(404);
      const htmlBody = await htmlRes.text();
      expect(htmlBody).toContain("<");
    } finally {
      server.close();
    }
  }, 180_000);

  it("serves generated build manifest asset under basePath", async () => {
    // Ported from Next.js: test/e2e/invalid-static-asset-404-app/invalid-static-asset-404-app-base-path.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/invalid-static-asset-404-app/invalid-static-asset-404-app-base-path.test.ts
    const built = await buildAppFixtureWithConfig(`basePath: "/base",`, register);
    const buildId = findClientRuntimeManifestBuildId(built.outDir, "/base");
    if (!buildId) {
      throw new Error("Expected _buildManifest.js under /base/_next/static/<buildId>/");
    }

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      const res = await fetch(`${baseUrl}/base/_next/static/${buildId}/_buildManifest.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("__BUILD_MANIFEST");

      const ssgRes = await fetch(`${baseUrl}/base/_next/static/${buildId}/_ssgManifest.js`);
      expect(ssgRes.status).toBe(200);
      expect(await ssgRes.text()).toContain("__SSG_MANIFEST");
    } finally {
      server.close();
    }
  }, 180_000);

  it("returns plain-text 404 for invalid asset under basePath", async () => {
    const built = await buildAppFixtureWithConfig(`basePath: "/docs",`, register);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      // basePath alone → assetPrefix fallback → `<basePath>/_next/static/...`
      const res = await fetch(`${baseUrl}/docs/_next/static/nonexistent-chunk.js`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not Found");
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    } finally {
      server.close();
    }
  }, 180_000);

  it("returns plain-text 404 for invalid asset under assetPrefix", async () => {
    const built = await buildAppFixtureWithConfig(`assetPrefix: "/cdn",`, register);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      outDir: built.outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://localhost:${port}`;

      const res = await fetch(`${baseUrl}/cdn/_next/static/nonexistent-chunk.js`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not Found");
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    } finally {
      server.close();
    }
  }, 180_000);
});

// ── Pages Router (production) ───────────────────────────────────────────────

function setupPagesRouterFixture(
  configJson: string,
  registerCleanup: (cleanup: () => void) => void,
): { tmpDir: string; outDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-invalid-static-404-pages-"));
  registerCleanup(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.symlinkSync(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(tmpDir, "next.config.mjs"), `export default ${configJson};\n`);
  fs.mkdirSync(path.join(tmpDir, "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "pages", "index.tsx"),
    `export default function HomePage() {
  return <p>Home</p>;
}
`,
  );
  return { tmpDir, outDir: path.join(tmpDir, "dist") };
}

async function buildPagesFixture(tmpDir: string, outDir: string): Promise<void> {
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
}

describe("Pages Router invalid `_next/static/*` 404", () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });
  const register = (cleanup: () => void) => cleanups.push(cleanup);

  it("returns plain-text `Not Found` 404 for invalid `_next/static/*` (no prefix)", async () => {
    const { tmpDir, outDir } = setupPagesRouterFixture("{}", register);
    await buildPagesFixture(tmpDir, outDir);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/_next/static/nonexistent-chunk.js`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not Found");
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    } finally {
      server.close();
    }
  }, 180_000);

  it("returns plain-text 404 for invalid asset under basePath", async () => {
    const { tmpDir, outDir } = setupPagesRouterFixture(`{ basePath: "/docs" }`, register);
    await buildPagesFixture(tmpDir, outDir);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/docs/_next/static/nonexistent-chunk.js`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not Found");
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    } finally {
      server.close();
    }
  }, 180_000);

  it("returns plain-text 404 for invalid asset under assetPrefix", async () => {
    const { tmpDir, outDir } = setupPagesRouterFixture(`{ assetPrefix: "/cdn" }`, register);
    await buildPagesFixture(tmpDir, outDir);

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      const res = await fetch(`${baseUrl}/cdn/_next/static/nonexistent-chunk.js`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toBe("Not Found");
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    } finally {
      server.close();
    }
  }, 180_000);
});
