/**
 * Favicon short-circuit tests
 *
 * Ported from Next.js: test/e2e/favicon-short-circuit/favicon-short-circuit.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/favicon-short-circuit/favicon-short-circuit.test.ts
 *
 * Issue: #1550
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder, createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR } from "./helpers.js";

/**
 * Copy the app-basic fixture to a temp directory.
 *
 * `fs.cpSync` preserves symlinks as absolute paths, which keeps the
 * fixture-local packages (`fake-context-lib`, `fake-css-lib`, etc.)
 * usable. `createIsolatedFixture` drops node_modules and replaces it
 * with a workspace symlink, which breaks those fixture-local links.
 *
 * We also clear `.vite/deps*` cache so dev starts from a clean slate
 * and doesn't hit "outdated pre-bundle" 500s.
 */
function copyAppFixture(prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(APP_FIXTURE_DIR, tmpDir, { recursive: true });
  // Wipe any stale Vite dep-optimizer cache
  const viteCacheDir = path.join(tmpDir, "node_modules", ".vite");
  fs.rmSync(viteCacheDir, { recursive: true, force: true });
  return tmpDir;
}

describe("favicon short-circuit", () => {
  describe("dev server - no user favicon route", () => {
    let tmpDir: string;
    let server: Awaited<ReturnType<typeof createServer>>;
    let baseUrl: string;

    beforeAll(async () => {
      tmpDir = copyAppFixture("vinext-favicon-dev-");
      // Remove metadata favicon so the short-circuit fires
      fs.rmSync(path.join(tmpDir, "app", "favicon.ico"));

      server = await createServer({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        server: { port: 0 },
        logLevel: "silent",
        optimizeDeps: { holdUntilCrawlEnd: true },
      });
      await server.listen();
      const addr = server.httpServer?.address();
      baseUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
    }, 30000);

    afterAll(async () => {
      await server?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty 404 for missing /favicon.ico in dev", async () => {
      const res = await fetch(`${baseUrl}/favicon.ico`);
      expect(res.status).toBe(404);
      // Next.js dev behavior: no content-type header, empty body.
      // Vite dev pipeline may inject `text/plain; charset=UTF-8` on an empty body.
      const ct = res.headers.get("content-type");
      expect(ct === null || ct.includes("text/plain")).toBe(true);
      expect(await res.text()).toBe("");
    });
  });

  describe("dev server - user has app/favicon.ico/route.ts", () => {
    let tmpDir: string;
    let server: Awaited<ReturnType<typeof createServer>>;
    let baseUrl: string;

    beforeAll(async () => {
      tmpDir = copyAppFixture("vinext-favicon-user-dev-");
      // Remove original metadata favicon and replace with route handler
      fs.rmSync(path.join(tmpDir, "app", "favicon.ico"));
      const routeDir = path.join(tmpDir, "app", "favicon.ico");
      fs.mkdirSync(routeDir, { recursive: true });
      fs.writeFileSync(
        path.join(routeDir, "route.ts"),
        `export async function GET() {\n  return new Response("<html><body>custom favicon</body></html>", {\n    status: 200,\n    headers: { "Content-Type": "text/html; charset=utf-8" },\n  });\n}\n`,
      );

      server = await createServer({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        server: { port: 0 },
        logLevel: "silent",
        optimizeDeps: { holdUntilCrawlEnd: true },
      });
      await server.listen();
      const addr = server.httpServer?.address();
      baseUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
    }, 30000);

    afterAll(async () => {
      await server?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("serves the user route handler HTML, not text/plain", async () => {
      const res = await fetch(`${baseUrl}/favicon.ico`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("custom favicon");
    });
  });

  describe("dev server - existing metadata favicon.ico file takes priority", () => {
    let tmpDir: string;
    let server: Awaited<ReturnType<typeof createServer>>;
    let baseUrl: string;

    beforeAll(async () => {
      // Keep the original app-basic fixture with its real favicon.ico metadata file
      tmpDir = copyAppFixture("vinext-favicon-meta-dev-");

      server = await createServer({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        server: { port: 0 },
        logLevel: "silent",
        optimizeDeps: { holdUntilCrawlEnd: true },
      });
      await server.listen();
      const addr = server.httpServer?.address();
      baseUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
    }, 30000);

    afterAll(async () => {
      await server?.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("serves the static favicon.ico metadata file", async () => {
      const res = await fetch(`${baseUrl}/favicon.ico`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/x-icon");
    });
  });

  describe("production - no user favicon route", () => {
    let tmpDir: string;
    let previewServer: Awaited<ReturnType<typeof import("vite").preview>>;
    let previewUrl: string;

    beforeAll(async () => {
      tmpDir = copyAppFixture("vinext-favicon-prod-");
      fs.rmSync(path.join(tmpDir, "app", "favicon.ico"));
      // Ensure any previous dist is gone
      fs.rmSync(path.join(tmpDir, "dist"), { recursive: true, force: true });

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { preview } = await import("vite");
      previewServer = await preview({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        preview: { port: 0 },
        logLevel: "silent",
      });
      const addr = previewServer.httpServer.address();
      previewUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
    }, 60000);

    afterAll(async () => {
      if (previewServer?.httpServer) {
        await new Promise<void>((resolve) => previewServer.httpServer.close(() => resolve()));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns HTML 404 for missing /favicon.ico in production", async () => {
      const res = await fetch(`${previewUrl}/favicon.ico`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("<html");
    });
  });

  describe("production - user has app/favicon.ico/route.ts", () => {
    let tmpDir: string;
    let previewServer: Awaited<ReturnType<typeof import("vite").preview>>;
    let previewUrl: string;

    beforeAll(async () => {
      tmpDir = copyAppFixture("vinext-favicon-user-prod-");
      fs.rmSync(path.join(tmpDir, "app", "favicon.ico"));
      fs.rmSync(path.join(tmpDir, "dist"), { recursive: true, force: true });

      const routeDir = path.join(tmpDir, "app", "favicon.ico");
      fs.mkdirSync(routeDir, { recursive: true });
      fs.writeFileSync(
        path.join(routeDir, "route.ts"),
        `export async function GET() {\n  return new Response("<html><body>prod favicon</body></html>", {\n    status: 200,\n    headers: { "Content-Type": "text/html; charset=utf-8" },\n  });\n}\n`,
      );

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { preview } = await import("vite");
      previewServer = await preview({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        preview: { port: 0 },
        logLevel: "silent",
      });
      const addr = previewServer.httpServer.address();
      previewUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
    }, 60000);

    afterAll(async () => {
      if (previewServer?.httpServer) {
        await new Promise<void>((resolve) => previewServer.httpServer.close(() => resolve()));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("serves the user production route handler HTML", async () => {
      const res = await fetch(`${previewUrl}/favicon.ico`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain("prod favicon");
    });
  });

  describe("production - existing metadata favicon.ico file takes priority", () => {
    let tmpDir: string;
    let previewServer: Awaited<ReturnType<typeof import("vite").preview>>;
    let previewUrl: string;

    beforeAll(async () => {
      tmpDir = copyAppFixture("vinext-favicon-meta-prod-");
      fs.rmSync(path.join(tmpDir, "dist"), { recursive: true, force: true });

      const builder = await createBuilder({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        logLevel: "silent",
      });
      await builder.buildApp();

      const { preview } = await import("vite");
      previewServer = await preview({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        preview: { port: 0 },
        logLevel: "silent",
      });
      const addr = previewServer.httpServer.address();
      previewUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
    }, 60000);

    afterAll(async () => {
      if (previewServer?.httpServer) {
        await new Promise<void>((resolve) => previewServer.httpServer.close(() => resolve()));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("serves the static favicon.ico metadata file", async () => {
      const res = await fetch(`${previewUrl}/favicon.ico`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/x-icon");
    });
  });
});
