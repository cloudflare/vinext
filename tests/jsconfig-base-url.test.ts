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
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { createTsconfigBaseUrlPlugin } from "../packages/vinext/src/plugins/tsconfig-base-url.js";
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
      // `~shared/tilde` is non-relative too, so it resolves through baseUrl.
      expect(html).toContain("Tilde import");
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

  // TypeScript applies `extends` arrays in order, so the later parent's
  // inherited baseUrl wins even when an earlier parent shares its base config.
  it("takes baseUrl from the later parent when extends parents share a base config", async () => {
    const entryPath = await buildPagesFixture(FIXTURE, {
      typescript: { tsconfigPath: "tsconfig.diamond.json" },
    });
    buildDirs.push(path.dirname(path.dirname(entryPath)));
    const entry = fs.readFileSync(entryPath, "utf-8");
    expect(entry).toContain("Tilde import");
    expect(entry).not.toContain("Custom base world");
  }, 120_000);

  // Turbopack excludes `.json` from baseUrl resolution, keeping the query and
  // fragment apart from the request path.
  it("leaves .json requests with a query or hash to standard resolution", async () => {
    const plugin = createTsconfigBaseUrlPlugin({ getBaseUrl: () => FIXTURE });
    const resolveId = plugin.resolveId as {
      handler: (this: unknown, id: string, importer: string, options: object) => Promise<unknown>;
    };
    const resolve = vi.fn(async (id: string) => ({ id }));
    const importer = path.join(FIXTURE, "pages/hello.js");
    for (const id of ["data.json?raw", "data.json#part"]) {
      expect(await resolveId.handler.call({ resolve }, id, importer, {})).toBeNull();
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
