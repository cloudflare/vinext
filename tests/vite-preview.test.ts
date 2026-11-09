import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createBuilder, preview, type InlineConfig, type PreviewServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, PAGES_FIXTURE_DIR } from "./helpers.js";

async function startPreview(
  root: string,
  config: InlineConfig = {},
): Promise<{ server: PreviewServer; port: number }> {
  const server = await preview({
    root,
    configFile: false,
    plugins: [vinext()],
    logLevel: "silent",
    ...config,
    preview: { host: "127.0.0.1", port: 0, ...config.preview },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Preview server has no port");
  return { server, port: address.port };
}

describe("vite preview (Pages Router, Node)", () => {
  let tmpDir: string;
  let server: PreviewServer | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = await createIsolatedFixture(PAGES_FIXTURE_DIR, "vinext-vite-preview-pages-");
    const builder = await createBuilder({
      root: tmpDir,
      configFile: false,
      plugins: [vinext()],
      logLevel: "silent",
      // The isolated build skips the workspace Vite config; keep its source
      // alias for fixture imports of exported vinext internals.
      resolve: {
        alias: {
          "vinext/internal": path.resolve(import.meta.dirname, "../packages/vinext/src"),
        },
      },
    });
    await builder.buildApp();

    let port: number;
    ({ server, port } = await startPreview(tmpDir));
    baseUrl = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("renders pages and API routes", async () => {
    const page = await fetch(`${baseUrl}/about`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title");

    const api = await fetch(`${baseUrl}/api/hello`);
    expect(api.status).toBe(200);
    await api.arrayBuffer();
  });

  it("serves build assets through Vite and 404s unknown paths", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const asset = html.match(/\/_next\/static\/[^"]+\.js/)?.[0];
    expect(asset).toBeDefined();

    const assetResponse = await fetch(`${baseUrl}${asset}`);
    expect(assetResponse.status).toBe(200);
    await assetResponse.arrayBuffer();

    const missing = await fetch(`${baseUrl}/this-page-does-not-exist`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
  });

  it("renders pages below a Vite base without a basePath", async () => {
    const { server: baseServer, port } = await startPreview(tmpDir, { base: "/custom/" });
    try {
      const page = await fetch(`http://127.0.0.1:${port}/custom/about`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title");
    } finally {
      await baseServer.close();
    }
  });

  it("keeps Vite's preview.proxy ahead of the Pages handler", async () => {
    const target = http.createServer((_req, res) => res.end("proxied"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("No target port");
    const { server: proxyServer, port } = await startPreview(tmpDir, {
      preview: {
        proxy: {
          "/api/hello": `http://127.0.0.1:${targetAddress.port}`,
          "/bypass": { target: `http://127.0.0.1:${targetAddress.port}`, bypass: () => "/about" },
        },
      },
    });
    try {
      const proxied = await fetch(`http://127.0.0.1:${port}/api/hello`);
      expect(await proxied.text()).toBe("proxied");

      // A bypass rewrite reaches the Pages handler.
      const bypassed = await fetch(`http://127.0.0.1:${port}/bypass`);
      expect(bypassed.status).toBe(200);
      expect(await bypassed.text()).toContain("<title");

      const page = await fetch(`http://127.0.0.1:${port}/about`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title");
    } finally {
      await proxyServer.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});
