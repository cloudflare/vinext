import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build, type ViteDevServer } from "vite";
import path from "node:path";
import http from "node:http";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, PAGES_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

const CONCURRENCY = 15;

async function fetchConcurrentPages(
  baseUrl: string,
  pagePath: string,
  count: number,
): Promise<string[]> {
  const requests = Array.from({ length: count }, (_, i) =>
    fetch(`${baseUrl}${pagePath}?id=${i}`).then((r) => r.text()),
  );

  return Promise.all(requests);
}

function extractTestId(html: string, testId: string): string | null {
  const pattern = new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`);
  const match = html.match(pattern);

  return match?.[1] ?? null;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/);

  return match?.[1] ?? null;
}

function extractMetaContent(html: string, name: string): string | null {
  const pattern = new RegExp(`<meta(?=[^>]*name="${name}")[^>]+content="([^"]*)"`, "i");
  const match = html.match(pattern);

  return match?.[1] ?? null;
}

describe("Pages Router dev concurrency isolation", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(PAGES_FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("<Head> elements do not leak between concurrent requests", async () => {
    const htmlResults = await fetchConcurrentPages(baseUrl, "/concurrent-head", CONCURRENCY);

    for (let i = 0; i < CONCURRENCY; i++) {
      const title = extractTitle(htmlResults[i]);
      const metaReqId = extractMetaContent(htmlResults[i], "req-id");
      const bodyReqId = extractTestId(htmlResults[i], "req-id");

      expect(bodyReqId, `response ${i} should contain its own req-id`).toBe(String(i));
      expect(title, `response ${i} should have its own <title>`).toBe(`req-${bodyReqId}`);
      expect(metaReqId, `response ${i} meta req-id should match body`).toBe(bodyReqId);
    }
  });

  it("router SSR context does not leak between concurrent requests", async () => {
    const htmlResults = await fetchConcurrentPages(baseUrl, "/concurrent-router", CONCURRENCY);

    for (let i = 0; i < CONCURRENCY; i++) {
      const ssrPathname = extractTestId(htmlResults[i], "ssr-pathname");
      const routerPathname = extractTestId(htmlResults[i], "router-pathname");

      expect(ssrPathname, `response ${i} ssr-pathname`).toBe("/concurrent-router");
      expect(routerPathname, `response ${i} router-pathname`).toBe("/concurrent-router");

      const nextData = htmlResults[i].match(/__NEXT_DATA__\s*=\s*(\{[^<]+\})/);
      if (!nextData) throw new Error(`no __NEXT_DATA__ found in response ${i}`);
      const data = JSON.parse(nextData[1]);
      expect(data.props.pageProps.ssrQuery.id, `response ${i} ssrQuery.id`).toBe(String(i));
    }
  });
});

describe("Pages Router prod concurrency isolation", () => {
  let prodServer: http.Server;
  let prodPort: number;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await createIsolatedFixture(
      PAGES_FIXTURE_DIR,
      "vinext-pages-concurrency-",
      (src) => !src.includes("node_modules") && !src.includes("alias-test"),
    );

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
    prodServer = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
    });

    const addr = prodServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to start production server");
    }
    prodPort = addr.port;
  }, 60000);

  afterAll(async () => {
    if (prodServer) {
      await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    }
    if (tmpDir) {
      const fsp = await import("node:fs/promises");
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // prod does not inject <Head> children into the html <head> section, so we
  // can only verify getServerSideProps data isolation here (not title/meta).
  it("getServerSideProps data does not leak between concurrent requests", async () => {
    const base = `http://127.0.0.1:${prodPort}`;
    const htmlResults = await fetchConcurrentPages(base, "/concurrent-head", CONCURRENCY);

    for (let i = 0; i < CONCURRENCY; i++) {
      const bodyReqId = extractTestId(htmlResults[i], "req-id");
      expect(bodyReqId, `response ${i} should contain its own req-id`).toBe(String(i));

      const nextData = htmlResults[i].match(/__NEXT_DATA__\s*=\s*(\{[^<]+\})/);
      if (!nextData) throw new Error(`no __NEXT_DATA__ found in response ${i}`);
      const data = JSON.parse(nextData[1]);
      expect(data.props.pageProps.reqId, `response ${i} pageProps.reqId`).toBe(String(i));
    }
  });

  it("SSR props do not leak between concurrent requests", async () => {
    const base = `http://127.0.0.1:${prodPort}`;
    const htmlResults = await fetchConcurrentPages(base, "/concurrent-router", CONCURRENCY);

    for (let i = 0; i < CONCURRENCY; i++) {
      const ssrPathname = extractTestId(htmlResults[i], "ssr-pathname");
      expect(ssrPathname, `response ${i} ssr-pathname`).toBe("/concurrent-router");

      const nextData = htmlResults[i].match(/__NEXT_DATA__\s*=\s*(\{[^<]+\})/);
      if (!nextData) throw new Error(`no __NEXT_DATA__ found in response ${i}`);
      const data = JSON.parse(nextData[1]);
      expect(data.props.pageProps.ssrQuery.id, `response ${i} ssrQuery.id`).toBe(String(i));
    }
  });
});
