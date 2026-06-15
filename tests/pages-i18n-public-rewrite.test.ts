import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import type { ViteDevServer } from "vite-plus";
import path from "node:path";
import fsp from "node:fs/promises";
import http from "node:http";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-i18n-public-rewrite");

async function startProdFixture(): Promise<{
  port: number;
  server: http.Server;
  tmpDir: string;
  outDir: string;
}> {
  const tmpDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-pages-i18n-public-rewrite-prod-");
  const outDir = path.join(tmpDir, "dist");
  await build({
    root: tmpDir,
    configFile: false,
    plugins: [vinext()],
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
    plugins: [vinext()],
    logLevel: "silent",
    build: {
      outDir: path.join(outDir, "client"),
      manifest: true,
      ssrManifest: true,
      rollupOptions: { input: "virtual:vinext-client-entry" },
    },
  });

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir,
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start Pages i18n public rewrite production server");
  }

  return { port: address.port, server, tmpDir, outDir };
}

async function findBuiltStaticAsset(clientDir: string): Promise<string> {
  const entries = await fsp.readdir(clientDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(clientDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findBuiltStaticAsset(entryPath);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      return entryPath;
    }
  }
  return "";
}

async function assertPublicRewrite(baseUrl: string, locale: "en" | "sv"): Promise<void> {
  const response = await fetch(`${baseUrl}/${locale}/rewrite-files/file.txt`);
  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toContain("hello from file.txt");
}

// Ported from Next.js: test/e2e/i18n-ignore-rewrite-source-locale/rewrites.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/i18n-ignore-rewrite-source-locale/rewrites.test.ts
describe("Pages i18n locale:false public rewrites", () => {
  describe("development", () => {
    let server: ViteDevServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR));
    }, 30_000);

    afterAll(async () => {
      await server?.close();
    });

    it("serves the rewritten public file for the default locale", async () => {
      await assertPublicRewrite(baseUrl, "en");
    });

    it("serves the rewritten public file for a non-default locale", async () => {
      await assertPublicRewrite(baseUrl, "sv");
    });
  });

  describe("production", () => {
    let prodServer: http.Server;
    let prodBaseUrl: string;
    let tmpDir: string;
    let outDir: string;

    beforeAll(async () => {
      const started = await startProdFixture();
      prodServer = started.server;
      prodBaseUrl = `http://127.0.0.1:${started.port}`;
      tmpDir = started.tmpDir;
      outDir = started.outDir;
    }, 30_000);

    afterAll(async () => {
      if (prodServer) {
        await new Promise<void>((resolve) => prodServer.close(() => resolve()));
      }
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("serves the rewritten public file for the default locale", async () => {
      await assertPublicRewrite(prodBaseUrl, "en");
    });

    it("serves the rewritten public file for a non-default locale", async () => {
      await assertPublicRewrite(prodBaseUrl, "sv");
    });

    it("preserves API, page, and built static destinations", async () => {
      const apiResponse = await fetch(`${prodBaseUrl}/en/rewrite-api/hello`);
      const pageResponse = await fetch(`${prodBaseUrl}/en/rewrite-page`);
      const staticFile = await findBuiltStaticAsset(path.join(outDir, "client", "_next", "static"));
      if (!staticFile) throw new Error("Expected a built static JavaScript asset");
      const staticPath = path
        .relative(path.join(outDir, "client"), staticFile)
        .split(path.sep)
        .join("/");
      const staticResponse = await fetch(`${prodBaseUrl}/en/rewrite-files/${staticPath}`);

      await expect(apiResponse.text()).resolves.toContain("hello from api");
      await expect(pageResponse.text()).resolves.toContain("about page");
      expect(staticResponse.status).toBe(200);
    });
  });
});
