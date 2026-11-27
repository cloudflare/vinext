import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { build, type ViteDevServer } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

// __NEXT_DATA__.__vinext.routeUrl must hold only the render path. The request
// query string must not be echoed into the HTML through this vinext-only field
// on pages without data fetching, getServerSideProps or getInitialProps.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/pages-route-url-query");

async function buildPagesFixture(root: string, outDir: string): Promise<void> {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ disableAppRouter: true })],
    build: {
      outDir: path.join(outDir, "server"),
      ssr: "virtual:vinext-server-entry",
      rolldownOptions: { output: { entryFileNames: "entry.js" } },
    },
  });
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ disableAppRouter: true })],
    build: {
      outDir: path.join(outDir, "client"),
      manifest: true,
      ssrManifest: true,
      rolldownOptions: { input: "virtual:vinext-client-entry" },
    },
  });
}

function nextData(html: string): any {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]*)<\/script>/);
  if (!match) throw new Error("Missing __NEXT_DATA__");
  return JSON.parse(match[1]);
}

describe("Pages __NEXT_DATA__.__vinext.routeUrl in production", () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    root = await createIsolatedFixture(FIXTURE_DIR, "vinext-pages-route-url-query-");
    const outDir = path.join(root, "dist");
    await buildPagesFixture(root, outDir);
    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const started = await startProdServer({ host: "127.0.0.1", port: 0, outDir });
    server = started.server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Production server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("does not echo the query of a page without data fetching into the HTML", async () => {
    const res = await fetch(`${baseUrl}/cb?code=SECRET_CODE&state=xyz`);
    const html = await res.text();
    const data = nextData(html);
    expect(res.status).toBe(200);
    expect(data.query).toEqual({});
    expect(data.__vinext?.routeUrl).toBe("/cb");
    expect(html).not.toContain("SECRET_CODE");
  });

  it("keeps routeUrl to the pathname for getServerSideProps pages", async () => {
    const res = await fetch(`${baseUrl}/gssp?code=abc`);
    const data = nextData(await res.text());
    expect(data.__vinext?.routeUrl).toBe("/gssp");
  });

  it("keeps routeUrl to the pathname for getInitialProps pages", async () => {
    const res = await fetch(`${baseUrl}/gip?code=abc`);
    const data = nextData(await res.text());
    expect(data.__vinext?.routeUrl).toBe("/gip");
  });
});

describe("Pages __NEXT_DATA__.__vinext.routeUrl in dev", () => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = await createIsolatedFixture(FIXTURE_DIR, "vinext-pages-route-url-query-dev-");
    ({ server, baseUrl } = await startFixtureServer(root, { appDir: root }));
  }, 120_000);

  afterAll(async () => {
    if (server) await server.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("does not echo the query of a page without data fetching into the HTML", async () => {
    const res = await fetch(`${baseUrl}/cb?code=SECRET_CODE&state=xyz`);
    const html = await res.text();
    const data = nextData(html);
    expect(res.status).toBe(200);
    expect(data.query).toEqual({});
    expect(data.__vinext?.routeUrl).toBe("/cb");
    expect(html).not.toContain("SECRET_CODE");
  });

  it("keeps routeUrl to the pathname for getServerSideProps pages", async () => {
    const res = await fetch(`${baseUrl}/gssp?code=abc`);
    const data = nextData(await res.text());
    expect(data.__vinext?.routeUrl).toBe("/gssp");
  });

  it("keeps routeUrl to the pathname for getInitialProps pages", async () => {
    const res = await fetch(`${baseUrl}/gip?code=abc`);
    const data = nextData(await res.text());
    expect(data.__vinext?.routeUrl).toBe("/gip");
  });
});
