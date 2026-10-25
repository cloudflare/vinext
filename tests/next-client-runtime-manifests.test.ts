import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

// use-params-app-pages is a hybrid app: App routes plus Pages routes, including
// nested dynamic routes, directory index pages and a Pages API route.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/use-params-app-pages");

function findBuildId(staticDir: string): string {
  for (const entry of fs.readdirSync(staticDir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      fs.existsSync(path.join(staticDir, entry.name, "_buildManifest.js"))
    ) {
      return entry.name;
    }
  }
  throw new Error(`Expected _buildManifest.js under ${staticDir}/<buildId>/`);
}

// Covers the `_buildManifest.js` page-list assertion from Next.js:
// test/integration/custom-routes-catchall/test/index.test.ts ("should rewrite to /_next/static correctly")
// https://github.com/vercel/next.js/blob/canary/test/integration/custom-routes-catchall/test/index.test.ts
describe("Next.js runtime build manifest (production)", () => {
  let fixtureRoot: string;
  let baseUrl: string;
  let buildId: string;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-runtime-build-manifest-");
    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: false,
      plugins: [vinext({ appDir: fixtureRoot })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const outDir = path.join(fixtureRoot, "dist");
    buildId = findBuildId(path.join(outDir, "client", "_next", "static"));

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Runtime build manifest fixture did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
  }, 180_000);

  afterAll(async () => {
    await close?.();
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("lists every Pages route in sortedPages", async () => {
    const res = await fetch(`${baseUrl}/_next/static/${buildId}/_buildManifest.js`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const manifest = JSON.parse(
      body.slice("self.__BUILD_MANIFEST = ".length, body.indexOf(";self.__BUILD_MANIFEST_CB")),
    ) as { sortedPages: string[] };

    // Next.js lists `pages/` page and API routes plus `/_app` and `/_error`
    // (never App routes) in `getSortedRoutes` order. This is the order real
    // Next.js 16 produces for this fixture's `pages/` tree.
    expect(manifest.sortedPages).toEqual([
      "/_app",
      "/_error",
      "/api/edge-url",
      "/form-search",
      "/form-source",
      "/pages-dir/[dynamic]",
      "/skip-trailing-slash",
      "/skip-trailing-slash/another",
      "/skip-trailing-slash/blog/[slug]",
      "/[id]/details",
    ]);
  });
});
