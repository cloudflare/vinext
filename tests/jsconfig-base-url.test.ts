/**
 * jsconfig.json `compilerOptions.baseUrl` resolution.
 *
 * Ported from Next.js: test/e2e/jsconfig-baseurl/jsconfig-baseurl.test.ts
 * https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/jsconfig-baseurl/jsconfig-baseurl.test.ts
 *
 * Next.js reads `jsconfig.json` when there is no `tsconfig.json`
 * (build/load-jsconfig.ts) and resolves bare imports against an explicit
 * `baseUrl` (webpack-config.ts `resolve.modules`; Turbopack's
 * turbopack-resolve/src/typescript.rs). Vite's native `resolve.tsconfigPaths`
 * only reads `tsconfig.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { buildPagesFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/jsconfig-base-url");
const buildDirs: string[] = [];

afterAll(() => {
  for (const dir of buildDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("jsconfig.json baseUrl", () => {
  it("resolves bare imports against baseUrl in dev", async () => {
    const { server, baseUrl } = await startFixtureServer(FIXTURE);
    try {
      const { res, html } = await fetchHtml(baseUrl, "/hello");
      expect(res.status).toBe(200);
      expect(html).toContain("World");
    } finally {
      await server.close();
    }
  }, 60_000);

  it("resolves bare imports against baseUrl in a production build", async () => {
    const entryPath = await buildPagesFixture(FIXTURE);
    buildDirs.push(path.dirname(path.dirname(entryPath)));
    const entry = fs.readFileSync(entryPath, "utf-8");
    expect(entry).toContain("World");
    expect(entry).not.toContain("Custom base world");
  }, 120_000);

  // Next.js reads compiler options from `typescript.tsconfigPath` when set
  // (build/load-jsconfig.ts); Vite's native discovery is off then.
  it("resolves bare imports against the baseUrl of typescript.tsconfigPath", async () => {
    const entryPath = await buildPagesFixture(FIXTURE, {
      typescript: { tsconfigPath: "tsconfig.custom.json" },
    });
    buildDirs.push(path.dirname(path.dirname(entryPath)));
    expect(fs.readFileSync(entryPath, "utf-8")).toContain("Custom base world");
  }, 120_000);
});
