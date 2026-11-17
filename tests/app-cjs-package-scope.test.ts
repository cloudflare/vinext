/**
 * Test: server build output under a CommonJS package scope.
 *
 * Next.js pins the module type of its build output with a package.json in
 * `.next`, and gives its generated Server Actions entrypoint an `.mjs`
 * extension (vercel/next.js#101164), so the output stays valid when the
 * project's package.json declares `"type": "commonjs"`. A vinext app with the
 * same package.json must still build and serve pages that use inline and
 * exported Server Actions, in dev and in production. The Pages Router server
 * output must load under the same scope.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin, type UserConfig, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext, { type VinextOptions } from "../packages/vinext/src/index.js";
import { createIsolatedFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-cjs-package-scope");
const PAGES_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/pages-cjs-package-scope",
);

const OUTPUT_SCOPE_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-cjs-output-scope",
);

/** Builds a copy of a fixture, keeping its own package.json. */
async function buildIsolatedFixture(
  sourceDir: string,
  prefix: string,
  config: {
    vinextOptions?: Omit<VinextOptions, "appDir">;
    plugins?: Plugin[];
    environments?: UserConfig["environments"];
  } = {},
): Promise<string> {
  const fixtureDir = await createIsolatedFixture(sourceDir, prefix);
  const builder = await createBuilder({
    root: fixtureDir,
    configFile: false,
    plugins: [vinext({ ...config.vinextOptions, appDir: fixtureDir }), ...(config.plugins ?? [])],
    environments: config.environments,
    logLevel: "silent",
  });
  await builder.buildApp();
  return fixtureDir;
}

/** Imports a built server entry with Node's own loader, as `vinext start` does. */
function importWithNode(entry: string, cwd: string) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)});`],
    { encoding: "utf-8", cwd },
  );
}

async function startBuiltServer(fixtureDir: string): Promise<{ server: Server; baseUrl: string }> {
  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: path.join(fixtureDir, "dist"),
    noCompression: true,
    silent: true,
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** Submits each rendered Server Action form without JavaScript. */
async function expectActionsRedirect(baseUrl: string): Promise<void> {
  const { res, html } = await fetchHtml(baseUrl, "/");
  expect(res.status).toBe(200);
  expect(html).toContain("CJS Package Scope");

  const actionFields = [...html.matchAll(/name="(\$ACTION_ID_[^"]+)"/g)].map((match) => match[1]);
  expect(actionFields).toHaveLength(2);
  const locations: string[] = [];
  for (const field of actionFields) {
    const form = new FormData();
    form.append(field, "");
    const action = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: { Origin: baseUrl },
      body: form,
      redirect: "manual",
    });
    expect(action.status).toBe(303);
    locations.push(new URL(action.headers.get("location") ?? "", baseUrl).search);
  }
  expect(locations.sort()).toEqual(["?action=exported", "?action=inline"]);
}

describe('A root package.json with "type": "commonjs"', () => {
  it("fixture declares a CommonJS package scope", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURE_SOURCE_DIR, "package.json"), "utf-8"));
    expect(pkg.type).toBe("commonjs");
  });

  describe("dev", () => {
    let server: ViteDevServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = await startFixtureServer(FIXTURE_SOURCE_DIR, { appRouter: true }));
    }, 60_000);

    afterAll(async () => {
      await server?.close();
    });

    it("runs inline and exported Server Actions", async () => {
      await expectActionsRedirect(baseUrl);
    });
  });

  describe("production", () => {
    let fixtureDir: string;
    let server: Server | undefined;

    beforeAll(async () => {
      fixtureDir = await buildIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-cjs-scope-");
    }, 120_000);

    afterAll(() => {
      server?.close();
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("pins the server output to ESM with a nested package scope", () => {
      const serverDir = path.join(fixtureDir, "dist", "server");
      expect(JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf-8"))).toEqual({
        type: "module",
      });
      // The fixed entry paths the production server and prerender load.
      expect(fs.existsSync(path.join(serverDir, "index.js"))).toBe(true);
      expect(fs.existsSync(path.join(serverDir, "ssr", "index.js"))).toBe(true);
      // The project's own scope stays CommonJS.
      expect(JSON.parse(fs.readFileSync(path.join(fixtureDir, "package.json"), "utf-8")).type).toBe(
        "commonjs",
      );
    });

    it("emits generated server modules that plain Node loads as ESM", () => {
      // Loads the generated Server Actions owner manifest and the other
      // generated modules the RSC entry imports.
      const result = importWithNode(
        path.join(fixtureDir, "dist", "server", "index.js"),
        fixtureDir,
      );
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.status).toBe(0);
    });

    it("runs inline and exported Server Actions", async () => {
      let baseUrl: string;
      ({ server, baseUrl } = await startBuiltServer(fixtureDir));
      await expectActionsRedirect(baseUrl);
    }, 60_000);
  });

  describe("production with custom server output options", () => {
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await buildIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-cjs-scope-output-", {
        environments: {
          // An array-shaped output and an empty assetsDir are both valid.
          rsc: { build: { assetsDir: "" } },
          ssr: { build: { rolldownOptions: { output: [{}] } } },
        },
        plugins: [
          {
            name: "test:emit-commonjs-package-json",
            apply: "build",
            generateBundle() {
              if (this.environment.name !== "rsc") return;
              this.emitFile({
                type: "asset",
                fileName: "package.json",
                source: JSON.stringify({ name: "emitted", type: "commonjs" }),
              });
            },
          },
        ],
      });
    }, 120_000);

    afterAll(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("keeps an emitted package.json, pinned to ESM", () => {
      const serverDir = path.join(fixtureDir, "dist", "server");
      expect(JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf-8"))).toEqual({
        name: "emitted",
        type: "module",
      });
    });

    it("emits .js entries and chunks that plain Node loads as ESM", () => {
      const serverDir = path.join(fixtureDir, "dist", "server");
      const files = fs.readdirSync(serverDir, { recursive: true, encoding: "utf-8" });
      expect(files).toContain("index.js");
      expect(files).toContain(path.join("ssr", "index.js"));
      expect(files.filter((file) => file.endsWith(".mjs"))).toEqual([]);
      const result = importWithNode(path.join(serverDir, "index.js"), fixtureDir);
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.status).toBe(0);
    });
  });

  describe('production with a "type": "module" root and output in a CommonJS package', () => {
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await buildIsolatedFixture(
        OUTPUT_SCOPE_FIXTURE_SOURCE_DIR,
        "vinext-cjs-output-scope-",
        {
          vinextOptions: {
            rscOutDir: "cjs-output/server",
            ssrOutDir: "cjs-output/server/ssr",
            clientOutDir: "cjs-output/client",
          },
        },
      );
    }, 120_000);

    afterAll(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("pins the server output directory to ESM", () => {
      const serverDir = path.join(fixtureDir, "cjs-output", "server");
      expect(JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf-8"))).toEqual({
        type: "module",
      });
      const result = importWithNode(path.join(serverDir, "index.js"), fixtureDir);
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.status).toBe(0);
    });
  });

  describe("Pages Router production with the SSR output beside the sources", () => {
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await buildIsolatedFixture(
        PAGES_FIXTURE_SOURCE_DIR,
        "vinext-pages-cjs-scope-outdir-",
        {
          // The client assets module goes beside the SSR output directory,
          // which is now the project root.
          plugins: [
            {
              name: "test:ssr-out-dir",
              configEnvironment(name) {
                return name === "ssr" ? { build: { outDir: "server" } } : null;
              },
            },
          ],
        },
      );
    }, 120_000);

    afterAll(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("leaves the project's package.json alone", () => {
      expect(fs.readFileSync(path.join(fixtureDir, "package.json"), "utf-8")).toBe(
        fs.readFileSync(path.join(PAGES_FIXTURE_SOURCE_DIR, "package.json"), "utf-8"),
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(fixtureDir, "server", "package.json"), "utf-8")),
      ).toEqual({ type: "module" });
    });
  });

  describe("Pages Router production", () => {
    let fixtureDir: string;
    let server: Server | undefined;

    beforeAll(async () => {
      fixtureDir = await buildIsolatedFixture(PAGES_FIXTURE_SOURCE_DIR, "vinext-pages-cjs-scope-");
    }, 120_000);

    afterAll(() => {
      server?.close();
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("emits a server entry that plain Node loads as ESM", () => {
      // entry.js imports the client assets module written beside dist/server.
      const result = importWithNode(
        path.join(fixtureDir, "dist", "server", "entry.js"),
        fixtureDir,
      );
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.status).toBe(0);
    });

    it("serves a page", async () => {
      let baseUrl: string;
      ({ server, baseUrl } = await startBuiltServer(fixtureDir));
      const { res, html } = await fetchHtml(baseUrl, "/");
      expect(res.status).toBe(200);
      expect(html).toContain("CJS Package Scope Pages");
      expect(html).toContain("getServerSideProps");
    }, 60_000);
  });
});
