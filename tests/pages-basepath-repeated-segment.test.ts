import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

// basePath "/docs" with pages/docs/[slug].jsx, guarded by the matcher
// "/docs/:path*". Its URL /docs/docs/internal/ still starts with the basePath
// once stripped, which must not be stripped a second time for middleware.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/pages-basepath-trailing-slash");

async function startServer(
  fixtureRoot: string,
  mode: "development" | "production",
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  if (mode === "development") {
    const started = await startFixtureServer(fixtureRoot);
    return { baseUrl: started.baseUrl, close: () => started.server.close() };
  }

  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("basePath production fixture did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// Observed against Next.js 16.2.7 (`next build --webpack && next start`) with
// this fixture: every request is denied, and middleware sees the route path.
describe.each(["development", "production"] as const)(
  "Pages route whose first segment repeats the basePath (%s)",
  (mode) => {
    let fixtureRoot: string;
    let baseUrl: string;
    let close: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      fixtureRoot = await createIsolatedFixture(
        FIXTURE_DIR,
        `vinext-pages-basepath-repeated-segment-${mode}-`,
      );
      ({ baseUrl, close } = await startServer(fixtureRoot, mode));
    }, 120000);

    afterAll(async () => {
      await close?.();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    });

    it("runs middleware for the page with the basePath stripped once", async () => {
      const res = await fetch(`${baseUrl}/docs/docs/internal/`, { redirect: "manual" });
      expect(res.status).toBe(403);
      expect(res.headers.get("x-guard-pathname")).toBe("/docs/internal/");
      expect(await res.text()).toBe("blocked by middleware");
    });

    it("runs middleware for a file-looking page path", async () => {
      const res = await fetch(`${baseUrl}/docs/docs/v1.2`, { redirect: "manual" });
      expect(res.status).toBe(403);
      expect(res.headers.get("x-guard-pathname")).toBe("/docs/v1.2");
      expect(await res.text()).toBe("blocked by middleware");
    });

    it("runs middleware for the page's data request", async () => {
      const html = await (await fetch(`${baseUrl}/docs/hello/`)).text();
      const buildId = /"buildId":"([^"]+)"/.exec(html)?.[1];
      expect(buildId).toBeTruthy();

      const res = await fetch(`${baseUrl}/docs/_next/data/${buildId}/docs/internal.json`, {
        headers: { "x-nextjs-data": "1" },
        redirect: "manual",
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("x-guard-pathname")).toBe("/docs/internal/");
      expect(await res.text()).toBe("blocked by middleware");
    });
  },
);
