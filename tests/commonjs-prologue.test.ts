// vite-plugin-commonjs prepends its import and `module`/`exports` polyfill
// blocks to a converted module. Ahead of a hashbang they are a syntax error,
// and ahead of a "use client" directive the directive stops being one, so
// the module is no longer a client reference. Next.js accepts both.
//
// Ported from Next.js: test/e2e/hashbang/hashbang.test.ts
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/hashbang/hashbang.test.ts
// The require() in a Client Component mirrors
// test/e2e/app-dir/app-esm-js/app/app/api-exports/client.js (v16.4.6).

import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createBuilder, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/commonjs-prologue");

function expectRenderedModules(html: string): void {
  expect(html).toMatch(/data-testid="js">JS: (?:<!-- -->)?123</);
  expect(html).toMatch(/data-testid="mjs">MJS: (?:<!-- -->)?456</);
  expect(html).toMatch(/data-testid="cjs">CJS: (?:<!-- -->)?789</);
  expect(html).toMatch(
    /data-testid="require-client">hello from require(?:<!-- -->)? (?:<!-- -->)?1</,
  );
}

describe("CommonJS conversion keeps the module prologue first (dev)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, { appRouter: true }));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it("renders hashbang modules and a Client Component that uses require()", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expectRenderedModules(html);
  });
});

describe("CommonJS conversion keeps the module prologue first (production)", () => {
  let fixtureDir = "";
  let server: Server | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-commonjs-prologue-");
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

  it("renders hashbang modules and a Client Component that uses require()", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expectRenderedModules(html);
  });
});
