/**
 * Regression coverage for issue #1827 — `trailingSlash` not applied to App
 * Router route handlers (`app/**​/route.ts`).
 *
 * Mirrors Next.js test/e2e/app-dir/app-routes-trailing-slash:
 *   - With `trailingSlash: true`, a request to `/runtime/edge` returns
 *     308 → `/runtime/edge/`
 *   - The redirected `/runtime/edge/` request returns 200 and the handler
 *     observes the trailing-slash pathname.
 *
 * Refs cloudflare/vinext#1827
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

function copyAppFixtureWithTrailingSlash(prefix: string, trailingSlash: boolean): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(APP_FIXTURE_DIR, tmpDir, { recursive: true });
  fs.rmSync(path.join(tmpDir, "node_modules", ".vite"), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(tmpDir, "next.config.ts"),
    `import type { NextConfig } from "vinext";
const nextConfig: NextConfig = { trailingSlash: ${trailingSlash} };
export default nextConfig;
`,
  );
  return tmpDir;
}

describe("App Router route-handler trailingSlash: true (#1827)", () => {
  let tmpDir: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = copyAppFixtureWithTrailingSlash("vinext-route-ts-true-", true);
    ({ server, baseUrl } = await startFixtureServer(tmpDir));
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(["edge", "node"])(
    "redirects /runtime/%s with 308 and serves the slashed path",
    async (runtime) => {
      const res = await fetch(`${baseUrl}/runtime/${runtime}`, { redirect: "manual" });
      expect(res.status).toBe(308);
      const location = res.headers.get("location");
      expect(location).not.toBeNull();
      expect(new URL(location!, baseUrl).pathname).toBe(`/runtime/${runtime}/`);

      const slashed = await fetch(`${baseUrl}/runtime/${runtime}/`, { redirect: "manual" });
      expect(slashed.status).toBe(200);
      await expect(slashed.json()).resolves.toEqual({
        url: `/runtime/${runtime}/`,
        nextUrl: `/runtime/${runtime}/`,
      });
    },
    30000,
  );
});

describe("App Router route-handler trailingSlash: false (#1827)", () => {
  let tmpDir: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = copyAppFixtureWithTrailingSlash("vinext-route-ts-false-", false);
    ({ server, baseUrl } = await startFixtureServer(tmpDir));
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(["edge", "node"])(
    "redirects /runtime/%s/ with 308 and serves the unslashed path",
    async (runtime) => {
      const res = await fetch(`${baseUrl}/runtime/${runtime}/`, { redirect: "manual" });
      expect(res.status).toBe(308);
      expect(new URL(res.headers.get("location")!, baseUrl).pathname).toBe(`/runtime/${runtime}`);

      const unslashed = await fetch(`${baseUrl}/runtime/${runtime}`, { redirect: "manual" });
      expect(unslashed.status).toBe(200);
      await expect(unslashed.json()).resolves.toEqual({
        url: `/runtime/${runtime}`,
        nextUrl: `/runtime/${runtime}`,
      });
    },
    30000,
  );
});
