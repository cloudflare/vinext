import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import { createIsolatedFixture } from "./helpers.js";

// `app/[slug]/ppr/[id]` sits under the `[slug]` root layout, so with
// cacheComponents an unknown `id` probes the `/en/ppr/[id]` fallback shell.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/multi-stage-http");

describe("PPR fallback shell cache key", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(
      FIXTURE_DIR,
      "vinext-ppr-fallback-shell-key-",
      (src) => !src.includes(`${path.sep}dist`),
    );
    const nodeEnv = process.env.NODE_ENV;
    // Build and prerender for the Node production server and its memory cache,
    // without the fixture's HTTP stage cache adapter.
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();
    // The build switches NODE_ENV to production, but this process already
    // loaded React's development build. Restore it so the `react-dom/static`
    // that fallback shells load later is the matching development build.
    Reflect.set(process.env, "NODE_ENV", nodeEnv);
    // Programmatic builds skip the CLI build lifecycle, so prerender here like
    // the fixture's `prerender: true` does.
    await runPrerender({ root: fixtureDir, concurrency: 1 });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    baseUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("does not serve a literal placeholder path's page as other params' fallback shell", async () => {
    // `/en/ppr/%5Bid%5D` decodes to `/en/ppr/[id]`, the shell's own pathname.
    await expect
      .poll(async () => {
        const response = await fetch(`${baseUrl}/en/ppr/%5Bid%5D`);
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain("fresh pregenerated route:en:%5Bid%5D");
        return response.headers.get("x-vinext-cache");
      })
      .toBe("HIT");

    for (const id of ["other", "another"]) {
      const response = await fetch(`${baseUrl}/en/ppr/${id}`);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain(`fresh pregenerated route:en:${id}`);
      expect(body).not.toContain("%5Bid%5D");
    }
  });

  it("resumes an unknown route's fallback shell from the values it was built with", async () => {
    // Like Next.js, the route resumes on every request instead of storing the
    // concrete page.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${baseUrl}/en/resume/other`);
      const body = await response.text();

      expect(response.status, body).toBe(200);
      expect(body).toContain("resumed route:en:other");
      // The layout's cache entry comes from the shell's resume data cache, so
      // it keeps the build-time value instead of running again at request time.
      expect(body).toContain("stamp:phase-production-build");
      expect(body).not.toContain("stamp:runtime");
      expect(response.headers.get("x-vinext-cache")).toBeNull();
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });
});
