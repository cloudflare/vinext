/**
 * Regression coverage for issue #1332 — trailing slash configuration not
 * enforced. These tests cover the core enforcement contract documented in
 * Next.js test/e2e/trailing-slashes/* and test/e2e/app-dir/trailingslash/*:
 *
 *   - With `trailingSlash: true`, a request to `/foo` returns 308 → `/foo/`
 *   - With `trailingSlash: false` (default), a request to `/foo/` returns 308 → `/foo`
 *   - App Router pages and route handlers obey the redirect
 *   - <Link href="/foo"> renders as href="/foo/" when trailingSlash is true
 *
 * Refs cloudflare/vinext#1332
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR } from "./helpers.js";

type Server = Awaited<ReturnType<typeof createServer>>;

/**
 * Copy the app-basic fixture and overwrite next.config.ts to set
 * `trailingSlash`. Keeps fixture-local symlinks (fake-context-lib, …)
 * intact via `fs.cpSync({ recursive: true })`.
 */
function copyAppFixtureWithTrailingSlash(prefix: string, trailingSlash: boolean): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(APP_FIXTURE_DIR, tmpDir, { recursive: true });
  // Wipe Vite's dep-optimizer cache so dev starts clean
  fs.rmSync(path.join(tmpDir, "node_modules", ".vite"), { recursive: true, force: true });
  // Overwrite next.config.ts with a minimal one that sets trailingSlash.
  // The app-basic next.config.ts has a lot of redirects/rewrites — we want a
  // clean slate so behavior under test is exactly the trailingSlash policy.
  fs.writeFileSync(
    path.join(tmpDir, "next.config.ts"),
    `import type { NextConfig } from "vinext";
const nextConfig: NextConfig = { trailingSlash: ${trailingSlash} };
export default nextConfig;
`,
  );
  return tmpDir;
}

async function startServer(tmpDir: string): Promise<{ server: Server; baseUrl: string }> {
  const server = await createServer({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir })],
    server: { port: 0 },
    logLevel: "silent",
    optimizeDeps: { holdUntilCrawlEnd: true },
  });
  await server.listen();
  const addr = server.httpServer?.address();
  const baseUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
  return { server, baseUrl };
}

describe("App Router trailingSlash: true (#1332)", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = copyAppFixtureWithTrailingSlash("vinext-ts-true-", true);
    ({ server, baseUrl } = await startServer(tmpDir));
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

  it("serves /about/ with 200 (no redirect)", async () => {
    const res = await fetch(`${baseUrl}/about/`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("home page <Link> hrefs reflect trailingSlash: true", async () => {
    // app-basic's homepage has <Link href="/about">. Under trailingSlash: true
    // the rendered href should be normalised to "/about/".
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Look for the specific link that points at /about — must include the
    // trailing slash now.
    expect(html).toMatch(/href="\/about\/"/);
  });
});

describe("App Router trailingSlash: false / default (#1332)", () => {
  let tmpDir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = copyAppFixtureWithTrailingSlash("vinext-ts-false-", false);
    ({ server, baseUrl } = await startServer(tmpDir));
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
  });

  it("home page <Link> hrefs lack a trailing slash", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/href="\/about(?!\/)"/);
  });
});
