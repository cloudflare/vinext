import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ViteDevServer } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR, fetchHtml, RSC_ENTRIES } from "./helpers.js";

describe("RSC plugin auto-registration", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    // Create a server with ONLY vinext() — no explicit @vitejs/plugin-rsc.
    // The plugin should auto-detect the app/ directory and inject RSC.
    // Note: appDir is passed because process.cwd() differs from root in tests.
    // In real projects, cwd === root so appDir is not needed.
    const { createServer } = await import("vite");
    server = await createServer({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: APP_FIXTURE_DIR })],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    });
    await server.listen();
    const addr = server.httpServer?.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://localhost:${addr.port}`;
    }
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders the home page without explicit RSC plugin", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(html).toContain("Welcome to App Router");
  });

  it("renders dynamic routes without explicit RSC plugin", async () => {
    const res = await fetch(`${baseUrl}/blog/auto-rsc-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Blog Post");
    expect(html).toContain("auto-rsc-test");
  });

  it("does not double-register when RSC plugin is already present", async () => {
    const { createServer } = await import("vite");
    const rsc = (await import("@vitejs/plugin-rsc")).default;

    // Create a server with BOTH vinext({ rsc: false }) and explicit rsc().
    // Should work without errors (no duplicate registration).
    const serverWithExplicitRsc = await createServer({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [vinext({ appDir: APP_FIXTURE_DIR, rsc: false }), rsc({ entries: RSC_ENTRIES })],
      optimizeDeps: { holdUntilCrawlEnd: true },
      server: { port: 0, cors: false },
      logLevel: "silent",
    });
    await serverWithExplicitRsc.listen();

    try {
      const addr = serverWithExplicitRsc.httpServer?.address();
      const url = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
      const res = await fetch(`${url}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Welcome to App Router");
    } finally {
      await serverWithExplicitRsc.close();
    }
  }, 30000);

  it("throws an error when user double-registers rsc() alongside auto-registration", async () => {
    const { createBuilder } = await import("vite");
    const rsc = (await import("@vitejs/plugin-rsc")).default;

    // vinext() auto-registers @vitejs/plugin-rsc when app/ is detected.
    // Manually adding rsc() on top should throw a clear error telling
    // the user to fix their config — not silently double the build time.
    await expect(
      createBuilder({
        root: APP_FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: APP_FIXTURE_DIR }), rsc({ entries: RSC_ENTRIES })],
        logLevel: "silent",
      }),
    ).rejects.toThrow("Duplicate @vitejs/plugin-rsc detected");
  }, 30000);

  it("auto-injects RSC plugin when src/app exists but root-level app/ does not", async () => {
    // Regression test: the early detection path (before config()) must check
    // both {base}/app and {base}/src/app to match the full config() logic.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-src-app-"));
    try {
      // Create only src/app/ — no root-level app/ directory.
      fs.mkdirSync(path.join(tmpDir, "src", "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "src", "app", "page.tsx"),
        "export default function Home() { return <h1>Home</h1>; }",
      );
      // Symlink node_modules so createRequire can find @vitejs/plugin-rsc
      // from the temp directory (resolution is relative to appDir).
      fs.symlinkSync(
        path.resolve(__dirname, "..", "node_modules"),
        path.join(tmpDir, "node_modules"),
        "junction",
      );

      const plugins = vinext({ appDir: tmpDir, react: false });

      const resolvedPlugins = (
        await Promise.all(
          plugins.map(async (plugin) => {
            if (plugin && typeof (plugin as any).then === "function") {
              return await (plugin as Promise<any>);
            }
            return plugin;
          }),
        )
      ).flat();

      const hasRscPlugin = resolvedPlugins.some((p) => p && (p as any).name === "rsc");
      expect(hasRscPlugin).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT auto-inject RSC plugin when neither app/ nor src/app/ exists", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-no-app-"));
    try {
      // Empty directory — no app/ or src/app/.
      const plugins = vinext({ appDir: tmpDir, react: false });

      const resolvedPlugins = (
        await Promise.all(
          plugins.map(async (plugin) => {
            if (plugin && typeof (plugin as any).then === "function") {
              return await (plugin as Promise<any>);
            }
            return plugin;
          }),
        )
      ).flat();

      const hasRscPlugin = resolvedPlugins.some((p) => p && (p as any).name === "rsc");
      expect(hasRscPlugin).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── External rewrite proxy credential forwarding (App Router) ────────────────
// Regression test: the proxyExternalRequest (imported from config-matchers) in the generated RSC entry
// must forward credential headers like Next.js while still stripping
// x-middleware-* headers before forwarding to external rewrite destinations.
