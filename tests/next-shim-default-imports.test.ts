// Next.js' public `next/*` entrypoints are CommonJS modules, so
// `import cache from "next/cache"` receives their `module.exports`: the same
// API as the named exports. vinext's ESM shims must provide that default too,
// or Rolldown fails the production build with MISSING_EXPORT.
//
// Ported from Next.js: test/e2e/app-dir/app-esm-js/index.test.ts
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/app-dir/app-esm-js/index.test.ts
// Next.js sources: packages/next/{cache,compat/router,constants,headers,navigation,
// offline,og,server,web-vitals}.js

import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, fetchHtml } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/next-shim-default-imports");

function readDefaults(html: string, layer: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  const pattern = new RegExp(
    `<li data-layer="${layer}" data-api="([^"]+)" data-default="([^"]+)"`,
    "g",
  );
  for (const [, api, shape] of html.matchAll(pattern)) defaults[api] = shape;
  return defaults;
}

describe("default imports of next/* shims (production)", () => {
  let fixtureDir = "";
  let server: Server | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-next-shim-defaults-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("exposes each entry's API on the default export in the App Router", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(readDefaults(html, "react-server")).toEqual({
      cache: "function",
      constants: "string",
      headers: "function",
      og: "function",
      server: "function",
    });
    expect(readDefaults(html, "client")).toEqual({
      cache: "function",
      "compat/router": "function",
      navigation: "function",
      offline: "function",
      "web-vitals": "function",
    });
  });

  it("exposes each entry's API on the default export in the Pages Router", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/pages-defaults");
    expect(res.status).toBe(200);
    expect(readDefaults(html, "pages")).toEqual({
      cache: "function",
      "compat/router": "function",
      constants: "string",
      navigation: "function",
      offline: "function",
      "web-vitals": "function",
    });
  });
});
