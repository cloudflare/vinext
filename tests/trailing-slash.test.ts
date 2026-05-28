/**
 * Regression coverage for issue #1332 — trailing slash configuration not
 * enforced. These tests cover the core enforcement contract documented in
 * Next.js test/e2e/trailing-slashes/* and test/e2e/app-dir/trailingslash/*:
 *
 *   - With `trailingSlash: true`, a request to `/foo` returns 308 → `/foo/`
 *   - With `trailingSlash: false`, a request to `/foo/` returns 308 → `/foo`
 *   - App Router pages obey the redirect
 *   - <Link href="/foo"> renders as href="/foo/" when trailingSlash is true
 *
 * Refs cloudflare/vinext#1332
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

/**
 * Copy the app-basic fixture and overwrite next.config.ts to set only
 * `trailingSlash`. We use `fs.cpSync({ recursive: true })` (not
 * `createIsolatedFixture`) for two reasons:
 *  1. app-basic's node_modules contains symlinks to fixture-local packages
 *     (`fake-context-lib`, etc.). `createIsolatedFixture` replaces
 *     node_modules with a workspace symlink and would break those.
 *  2. Each isolated copy gets its own `.vite` dep-optimizer cache, so
 *     concurrent test runs cannot race on a shared optimization output.
 * See `tests/favicon-short-circuit.test.ts` for the same rationale.
 */
function copyAppFixtureWithTrailingSlash(prefix: string, trailingSlash: boolean): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(APP_FIXTURE_DIR, tmpDir, { recursive: true });
  fs.rmSync(path.join(tmpDir, "node_modules", ".vite"), { recursive: true, force: true });
  // Replace the default app-basic next.config.ts. It carries a long list of
  // redirects/rewrites/headers used by other suites; we want a clean slate so
  // behaviour under test is exactly the trailingSlash policy.
  fs.writeFileSync(
    path.join(tmpDir, "next.config.ts"),
    `import type { NextConfig } from "vinext";
const nextConfig: NextConfig = { trailingSlash: ${trailingSlash} };
export default nextConfig;
`,
  );
  return tmpDir;
}

describe("App Router trailingSlash: true (#1332)", () => {
  let tmpDir: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = copyAppFixtureWithTrailingSlash("vinext-ts-true-", true);
    ({ server, baseUrl } = await startFixtureServer(tmpDir));
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("redirects /about → /about/ with 308", async () => {
    const res = await fetch(`${baseUrl}/about`, { redirect: "manual" });
    expect(res.status).toBe(308);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(new URL(location!, baseUrl).pathname).toBe("/about/");
  });

  // First hit triggers a dev-mode compile of the /about route; on CI this
  // routinely exceeds the 5s default. Mirrors the headroom used elsewhere
  // (see tests/app-router.test.ts).
  it("serves /about/ with 200 (no redirect)", async () => {
    const res = await fetch(`${baseUrl}/about/`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  }, 30000);

  it("home page <Link> renders href with a trailing slash", async () => {
    // app-basic's homepage has <Link href="/about">. Under trailingSlash: true
    // the rendered href should be normalised to "/about/".
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/href="\/about\/"/);
  });
});

describe("App Router trailingSlash: false (#1332)", () => {
  let tmpDir: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = copyAppFixtureWithTrailingSlash("vinext-ts-false-", false);
    ({ server, baseUrl } = await startFixtureServer(tmpDir));
  }, 60000);

  afterAll(async () => {
    await server?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("redirects /about/ → /about with 308", async () => {
    const res = await fetch(`${baseUrl}/about/`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get("location")!, baseUrl).pathname).toBe("/about");
  });

  it("serves /about with 200", async () => {
    const res = await fetch(`${baseUrl}/about`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  }, 30000);

  it("home page <Link> renders href without a trailing slash", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/href="\/about(?!\/)"/);
  });
});
