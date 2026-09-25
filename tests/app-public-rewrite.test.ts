import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite-plus";
import type { ViteDevServer } from "vite-plus";
import path from "node:path";
import fsp from "node:fs/promises";
import type http from "node:http";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-public-rewrite");

async function startProdFixture(): Promise<{
  baseUrl: string;
  server: http.Server;
  tmpDir: string;
}> {
  const tmpDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-app-public-rewrite-prod-");
  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(tmpDir, "dist"),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start App Router public rewrite production server");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, tmpDir };
}

async function assertPublicFile(baseUrl: string, pathname: string): Promise<void> {
  const response = await fetch(`${baseUrl}${pathname}`);
  expect(response.status, pathname).toBe(200);
  expect(response.headers.get("content-type"), pathname).toContain("text/plain");
  await expect(response.text(), pathname).resolves.toContain("hello from file.txt");
}

function definePublicRewriteTests(getBaseUrl: () => string): void {
  it("serves public files reached through beforeFiles, afterFiles, and fallback rewrites", async () => {
    await assertPublicFile(getBaseUrl(), "/before-files/file.txt");
    await assertPublicFile(getBaseUrl(), "/after-files/file.txt");
    await assertPublicFile(getBaseUrl(), "/fallback-files/file.txt");
  });

  it("keeps applying afterFiles rewrites until one reaches a public file", async () => {
    await assertPublicFile(getBaseUrl(), "/chain/file.txt");
  });

  it("falls through when a rewrite destination is not a public file", async () => {
    const response = await fetch(`${getBaseUrl()}/after-files/missing.txt`);
    expect(response.status).toBe(404);
  });

  it("rejects mutations of public files reached through rewrites", async () => {
    const response = await fetch(`${getBaseUrl()}/after-files/file.txt`, { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
}

// Next.js checks the filesystem (public files first) after beforeFiles and
// again after each afterFiles and fallback rewrite:
// packages/next/src/server/lib/router-utils/resolve-routes.ts
describe("App Router public files reached through rewrites", () => {
  describe("development", () => {
    let server: ViteDevServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, { appRouter: true }));
    }, 30_000);

    afterAll(async () => {
      await server?.close();
    });

    definePublicRewriteTests(() => baseUrl);
  });

  describe("production", () => {
    let server: http.Server;
    let baseUrl: string;
    let tmpDir: string;

    beforeAll(async () => {
      ({ baseUrl, server, tmpDir } = await startProdFixture());
    }, 60_000);

    afterAll(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    definePublicRewriteTests(() => baseUrl);
  });
});
