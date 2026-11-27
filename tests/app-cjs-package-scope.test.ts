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
import type { PrerenderRouteResult } from "../packages/vinext/src/build/prerender.js";
import vinext, { type VinextOptions } from "../packages/vinext/src/index.js";
import { createIsolatedFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-cjs-package-scope");
const PAGES_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/pages-cjs-package-scope",
);

const CF_PAGES_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-pages-cjs-package-scope",
);
const CF_APP_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-cjs-package-scope",
);
const OUTPUT_SCOPE_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-cjs-output-scope",
);
const MJS_PAGES_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-cjs-mjs-pages",
);
const NESTED_MODULE_SCOPE_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-cjs-nested-module-scope",
);

/** Builds a copy of a fixture, keeping its own package.json. */
async function buildIsolatedFixture(
  sourceDir: string,
  prefix: string,
  config: {
    vinextOptions?: Omit<VinextOptions, "appDir">;
    plugins?: Plugin[];
    environments?: UserConfig["environments"];
    onFixture?: (fixtureDir: string) => void;
  } = {},
): Promise<string> {
  const fixtureDir = await createIsolatedFixture(sourceDir, prefix);
  config.onFixture?.(fixtureDir);
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

type CloudflarePrerenderBuild = { fixtureDir: string; routes: PrerenderRouteResult[] };

/** Builds a copy of a Cloudflare fixture and prerenders it, as `vinext build` does. */
async function buildCloudflareAndPrerender(
  sourceDir: string,
  workerEnvironment: string,
  childEnvironments?: string[],
): Promise<CloudflarePrerenderBuild> {
  const fixtureDir = await createIsolatedFixture(
    sourceDir,
    "vinext-cf-cjs-scope-",
    undefined,
    path.resolve(import.meta.dirname, "./fixtures/cf-app-basic/node_modules"),
  );
  const { cloudflare } = (await import(
    pathToFileURL(path.join(fixtureDir, "node_modules/@cloudflare/vite-plugin/dist/index.mjs")).href
  )) as {
    cloudflare: (options?: {
      inspectorPort?: false;
      viteEnvironment?: { name: string; childEnvironments?: string[] };
    }) => Plugin;
  };
  const builder = await createBuilder({
    root: fixtureDir,
    configFile: false,
    plugins: [
      vinext({ appDir: fixtureDir }),
      cloudflare({
        inspectorPort: false,
        viteEnvironment: { name: workerEnvironment, childEnvironments },
      }),
    ],
    logLevel: "silent",
  });
  await builder.buildApp();
  const { runPrerender } = await import("../packages/vinext/src/build/run-prerender.js");
  const result = await runPrerender({
    root: fixtureDir,
    routeRootConfig: {
      rscOutDir: builder.environments.rsc?.config.build.outDir,
      ssrOutDir: builder.environments.ssr?.config.build.outDir,
      clientOutDir: builder.environments.client?.config.build.outDir,
    },
  });
  return { fixtureDir, routes: result?.routes ?? [] };
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

  // Ported from Next.js: test/e2e/app-dir/package-json-type-commonjs (vercel/next.js#101164),
  // which runs a Server Action from `.mjs` app files under a CommonJS root.
  describe.each([
    { label: ".mjs app files", sourceDir: MJS_PAGES_FIXTURE_SOURCE_DIR },
    {
      label: 'an app/ directory set back to "type": "module"',
      sourceDir: NESTED_MODULE_SCOPE_FIXTURE_SOURCE_DIR,
    },
  ])("with $label", ({ sourceDir }) => {
    describe("dev", () => {
      let server: ViteDevServer;
      let baseUrl: string;

      beforeAll(async () => {
        ({ server, baseUrl } = await startFixtureServer(sourceDir, { appRouter: true }));
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
        fixtureDir = await buildIsolatedFixture(sourceDir, "vinext-cjs-scope-variant-");
      }, 120_000);

      afterAll(() => {
        server?.close();
        if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
      });

      it("emits a server entry that plain Node loads as ESM", () => {
        const serverDir = path.join(fixtureDir, "dist", "server");
        expect(fs.existsSync(path.join(serverDir, "ssr", "index.js"))).toBe(true);
        const result = importWithNode(path.join(serverDir, "index.js"), fixtureDir);
        expect(result.stderr).not.toContain("SyntaxError");
        expect(result.status).toBe(0);
      });

      it("runs inline and exported Server Actions", async () => {
        let baseUrl: string;
        ({ server, baseUrl } = await startBuiltServer(fixtureDir));
        await expectActionsRedirect(baseUrl);
      }, 60_000);
    });
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
            // Post-ordered and registered after vinext, so it runs after
            // vinext's own generateBundle hook.
            generateBundle: {
              order: "post",
              handler() {
                if (this.environment.name !== "rsc") return;
                this.emitFile({
                  type: "asset",
                  fileName: "package.json",
                  source: JSON.stringify({ name: "emitted", type: "commonjs" }),
                });
              },
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

  describe("production into a directory with a CommonJS package.json", () => {
    let fixtureDir: string | undefined;

    afterAll(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("fails the build instead of emitting a server Node can't load", async () => {
      // `emptyOutDir: false` keeps cjs-output/package.json ("type": "commonjs")
      // in the RSC output directory.
      const build = buildIsolatedFixture(
        OUTPUT_SCOPE_FIXTURE_SOURCE_DIR,
        "vinext-cjs-outdir-pkg-",
        {
          vinextOptions: {
            rscOutDir: "cjs-output",
            ssrOutDir: "cjs-output/ssr",
            clientOutDir: "cjs-output-client",
          },
          environments: { rsc: { build: { emptyOutDir: false } } },
          onFixture: (dir) => {
            fixtureDir = dir;
          },
        },
      );
      await expect(build).rejects.toThrow(/doesn't declare "type": "module"/);
      expect(fs.readFileSync(path.join(fixtureDir!, "cjs-output", "package.json"), "utf-8")).toBe(
        fs.readFileSync(
          path.join(OUTPUT_SCOPE_FIXTURE_SOURCE_DIR, "cjs-output", "package.json"),
          "utf-8",
        ),
      );
    }, 120_000);
  });

  describe("production into a symlink to a directory in a CommonJS package", () => {
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await buildIsolatedFixture(
        OUTPUT_SCOPE_FIXTURE_SOURCE_DIR,
        "vinext-cjs-output-symlink-",
        {
          vinextOptions: { rscOutDir: "linked-server", ssrOutDir: "linked-server/ssr" },
          // linked-server/ looks like part of the "type": "module" root, but
          // Node loads its modules from their real path inside cjs-output/.
          onFixture: (dir) => {
            fs.mkdirSync(path.join(dir, "cjs-output", "server"), { recursive: true });
            fs.symlinkSync(
              path.join(dir, "cjs-output", "server"),
              path.join(dir, "linked-server"),
              "junction",
            );
          },
        },
      );
    }, 120_000);

    afterAll(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("pins the real output directory to ESM", () => {
      const result = importWithNode(path.join(fixtureDir, "linked-server", "index.js"), fixtureDir);
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.status).toBe(0);
    });
  });

  describe("production into a directory with a BOM-prefixed module package.json", () => {
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await buildIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-cjs-scope-bom-", {
        environments: { rsc: { build: { emptyOutDir: false } } },
        onFixture: (dir) => {
          // Node accepts the byte order mark and loads the output as ESM.
          fs.mkdirSync(path.join(dir, "dist", "server"), { recursive: true });
          fs.writeFileSync(
            path.join(dir, "dist", "server", "package.json"),
            `\uFEFF${JSON.stringify({ type: "module" })}`,
          );
        },
      });
    }, 120_000);

    afterAll(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("builds and emits a server entry that plain Node loads", () => {
      const result = importWithNode(
        path.join(fixtureDir, "dist", "server", "index.js"),
        fixtureDir,
      );
      expect(result.stderr).not.toContain("SyntaxError");
      expect(result.status).toBe(0);
    });
  });

  describe("Pages Router production with the SSR output beside the sources", () => {
    let fixtureDir: string | undefined;

    afterAll(() => {
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("fails the build instead of replacing the project's package.json", async () => {
      // The client assets module goes beside the SSR output directory, which
      // is now the project root: its CommonJS scope would make it unloadable.
      const build = buildIsolatedFixture(
        PAGES_FIXTURE_SOURCE_DIR,
        "vinext-pages-cjs-scope-outdir-",
        {
          plugins: [
            {
              name: "test:ssr-out-dir",
              configEnvironment(name) {
                return name === "ssr" ? { build: { outDir: "server" } } : null;
              },
            },
          ],
          onFixture: (dir) => {
            fixtureDir = dir;
          },
        },
      );
      await expect(build).rejects.toThrow(/isn't in a "type": "module" package scope/);
      expect(fs.readFileSync(path.join(fixtureDir!, "package.json"), "utf-8")).toBe(
        fs.readFileSync(path.join(PAGES_FIXTURE_SOURCE_DIR, "package.json"), "utf-8"),
      );
    }, 120_000);
  });

  describe("Cloudflare Pages Router build with prerendering", () => {
    let build: CloudflarePrerenderBuild | undefined;

    beforeAll(async () => {
      build = await buildCloudflareAndPrerender(CF_PAGES_FIXTURE_SOURCE_DIR, "ssr");
    }, 180_000);

    afterAll(() => {
      if (build) fs.rmSync(build.fixtureDir, { recursive: true, force: true });
    });

    it("prerenders from the host-owned index.mjs Worker entry", () => {
      expect(fs.existsSync(path.join(build!.fixtureDir, "dist", "ssr", "index.mjs"))).toBe(true);
      expect(build!.routes.find((route) => route.route === "/")).toMatchObject({
        status: "rendered",
      });
    });
  });

  describe("Cloudflare App Router build with prerendering", () => {
    let build: CloudflarePrerenderBuild | undefined;

    beforeAll(async () => {
      build = await buildCloudflareAndPrerender(CF_APP_FIXTURE_SOURCE_DIR, "rsc", ["ssr"]);
    }, 180_000);

    afterAll(() => {
      if (build) fs.rmSync(build.fixtureDir, { recursive: true, force: true });
    });

    it("prerenders from the host-owned index.mjs Worker and its ssr/index.js child", () => {
      const serverDir = path.join(build!.fixtureDir, "dist", "server");
      expect(fs.existsSync(path.join(serverDir, "index.mjs"))).toBe(true);
      // plugin-rsc imports the child SSR entry as a fixed ssr/index.js.
      expect(fs.existsSync(path.join(serverDir, "ssr", "index.js"))).toBe(true);
      expect(build!.routes.find((route) => route.route === "/")).toMatchObject({
        status: "rendered",
      });
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
      // entry.js imports ../vinext-client-assets.js, outside dist/server.
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
