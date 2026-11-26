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
import { toSlash } from "pathslash";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { loadTsconfigBaseUrl } from "../packages/vinext/src/config/tsconfig-paths.js";
import { createTsconfigBaseUrlPlugin } from "../packages/vinext/src/plugins/tsconfig-base-url.js";
import { buildPagesFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/jsconfig-base-url");
const buildDirs: string[] = [];

// The plugin for FIXTURE's jsconfig.json baseUrl, which the native resolver
// (reading tsconfig.json) doesn't handle.
function createResolvedBaseUrlPlugin() {
  const plugin = createTsconfigBaseUrlPlugin({
    load: () => ({
      config: { configPath: path.join(FIXTURE, "jsconfig.json"), baseUrl: FIXTURE },
      watchFiles: [],
    }),
    pathAliasesChanged: () => false,
  });
  (plugin.configResolved as (config: object) => void)({
    root: FIXTURE,
    resolve: { tsconfigPaths: true },
  });
  return plugin.resolveId as {
    handler: (this: unknown, id: string, importer: string, options: object) => Promise<unknown>;
  };
}

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

  // Next.js falls back to jsconfig.json when the configured tsconfigPath does
  // not exist (build/load-jsconfig.ts).
  it("falls back to jsconfig.json when typescript.tsconfigPath is missing", async () => {
    const entryPath = await buildPagesFixture(FIXTURE, {
      typescript: { tsconfigPath: "tsconfig.missing.json" },
    });
    buildDirs.push(path.dirname(path.dirname(entryPath)));
    const entry = fs.readFileSync(entryPath, "utf-8");
    expect(entry).toContain("World");
    expect(entry).not.toContain("Custom base world");
  }, 120_000);

  // A missing relative parent is watched too, so creating it restarts dev.
  it("watches a missing relative extends parent", () => {
    const { watchFiles } = loadTsconfigBaseUrl(FIXTURE, "tsconfig.missing-parent.json");
    expect(watchFiles).toContain(toSlash(path.join(FIXTURE, "tsconfig.not-created.json")));
  });

  // The dev server restarts on a config edit, re-reading baseUrl.
  it("applies a jsconfig.json baseUrl edit in dev", async () => {
    const jsconfigPath = path.join(FIXTURE, "jsconfig.json");
    const original = fs.readFileSync(jsconfigPath, "utf-8");
    const { server, baseUrl } = await startFixtureServer(FIXTURE);
    try {
      expect((await fetchHtml(baseUrl, "/hello")).html).toContain("Tilde import");
      fs.writeFileSync(
        jsconfigPath,
        JSON.stringify({ compilerOptions: { baseUrl: "custom-base" } }, null, 2) + "\n",
      );
      await expect
        .poll(async () => (await fetchHtml(baseUrl, "/hello")).html, { timeout: 15_000 })
        .toContain("Custom base world");
    } finally {
      fs.writeFileSync(jsconfigPath, original);
      await server.close();
    }
  }, 60_000);

  // vinext materializes `paths` aliases at startup, so a paths-only edit
  // restarts dev too, and the restart must not reuse cached aliases.
  it("applies a jsconfig.json paths edit in dev", async () => {
    const jsconfigPath = path.join(FIXTURE, "jsconfig.json");
    const original = fs.readFileSync(jsconfigPath, "utf-8");
    const writeJsconfig = (compilerOptions: object) =>
      fs.writeFileSync(jsconfigPath, JSON.stringify({ compilerOptions }, null, 2) + "\n");
    const { server, baseUrl } = await startFixtureServer(FIXTURE);
    const hello = async () => (await fetchHtml(baseUrl, "/hello")).html;
    try {
      expect(await hello()).toContain("Tilde import");
      writeJsconfig({ baseUrl: ".", paths: { "components/*": ["custom-base/components/*"] } });
      await expect.poll(hello, { timeout: 15_000 }).toContain("Custom base world");
      writeJsconfig({ baseUrl: "." });
      await expect.poll(hello, { timeout: 15_000 }).toContain("Tilde import");
    } finally {
      fs.writeFileSync(jsconfigPath, original);
      await server.close();
    }
  }, 60_000);

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
    const resolveId = createResolvedBaseUrlPlugin();
    const resolve = vi.fn(async (id: string) => ({ id }));
    const importer = path.join(FIXTURE, "pages/hello.js");
    for (const id of ["data.json?raw", "data.json#part"]) {
      expect(await resolveId.handler.call({ resolve }, id, importer, {})).toBeNull();
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  // Like tsconfig `paths` in Next.js webpack, dependencies keep standard
  // resolution. The importer is a native path (backslashes on Windows).
  it("leaves imports from node_modules to standard resolution", async () => {
    const resolveId = createResolvedBaseUrlPlugin();
    const resolve = vi.fn(async (id: string) => ({ id }));
    const importer = path.join(FIXTURE, "node_modules", "pkg", "index.js");
    expect(await resolveId.handler.call({ resolve }, "components/world", importer, {})).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  // Next.js reads tsconfig.json's baseUrl. Vite's native resolver reads its
  // own top-level `tsconfig` option instead when one is set.
  it("resolves baseUrl when Vite's tsconfig option selects another config", async () => {
    const { server, baseUrl } = await startFixtureServer(
      path.resolve(import.meta.dirname, "fixtures/vite-tsconfig-base-url"),
      {
        prependPlugins: [
          {
            // A normal plugin's config hook runs after vinext's pre one.
            name: "test:vite-tsconfig",
            config: () => ({ tsconfig: "tsconfig.vite.json" }),
          },
        ],
      },
    );
    try {
      const { res, html } = await fetchHtml(baseUrl, "/hello");
      expect(res.status).toBe(200);
      expect(html).toContain("World");
    } finally {
      await server.close();
    }
  }, 60_000);
});
