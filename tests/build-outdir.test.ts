/**
 * Test: Vite's `build.outDir` moves the whole vinext build output.
 *
 * A Vite build that sets `build.outDir` (inline config or `vite build
 * --outDir`) writes everything under that directory, as the Cloudflare Vite
 * plugin does for its environments: the RSC, SSR and client bundles, the
 * server metadata (BUILD_ID, vinext-server.json), the hybrid Pages Router
 * server and the prerendered output. The default `dist` under the project root
 * stays untouched. https://github.com/cloudflare/vinext/issues/4764
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";
import { pathToFileURL } from "node:url";
import { createBuilder, resolveConfig, type Plugin } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { VINEXT_BUILD_LIFECYCLE_CONFIG } from "../packages/vinext/src/build/lifecycle.js";
import { emitPrerenderPathManifest } from "../packages/vinext/src/build/prerender-paths.js";
import { runPrerender } from "../packages/vinext/src/build/run-prerender.js";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const APP_FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-build-outdir");
const PAGES_FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-build-outdir");
const CF_APP_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-build-outdir",
);
const CF_NODE_MODULES_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/cf-app-basic/node_modules",
);

const temporaryDirs: string[] = [];

afterAll(() => {
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function isolatedFixture(sourceDir: string, nodeModulesDir?: string): Promise<string> {
  const fixtureDir = await createIsolatedFixture(
    sourceDir,
    "vinext-build-outdir-",
    undefined,
    nodeModulesDir,
  );
  temporaryDirs.push(fixtureDir);
  return fixtureDir;
}

function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toSlash(path.relative(dir, path.join(entry.parentPath, entry.name))));
}

describe("build.outDir", () => {
  it("writes an App Router build under build.outDir, outside the project root", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    // The hybrid Pages Router bundle is only built by the build lifecycle.
    fs.rmSync(path.join(fixtureDir, "pages"), { recursive: true });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-outdir-out-"));
    temporaryDirs.push(outDir);

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      build: { outDir },
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(fixtureDir, "dist"))).toBe(false);
    expect(fs.readdirSync(outDir).sort()).toEqual(["client", "server"]);
    const serverFiles = listFiles(path.join(outDir, "server"));
    expect(serverFiles).toEqual(
      expect.arrayContaining([
        "index.js",
        "ssr/index.js",
        "BUILD_ID",
        "RSC_BUILD_ID",
        "vinext-server.json",
      ]),
    );
    expect(listFiles(path.join(outDir, "client")).some((file) => file.endsWith(".js"))).toBe(true);
  }, 180_000);

  it("cleans, builds and prerenders a hybrid project under a relative build.outDir", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    const outDir = path.join(fixtureDir, "out");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "stale.txt"), "from an earlier build");

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      build: { outDir: "out" },
      logLevel: "silent",
      [VINEXT_BUILD_LIFECYCLE_CONFIG]: {},
    } as Parameters<typeof createBuilder>[0]);
    await builder.buildApp();

    // The prerender phase `vite build` runs after the bundles, with the
    // output roots the build lifecycle reads from the builder.
    const routeRootConfig = {
      appDir: fixtureDir,
      outDir: builder.config.build.outDir,
      rscOutDir: builder.environments.rsc!.config.build.outDir,
      ssrOutDir: builder.environments.ssr!.config.build.outDir,
      clientOutDir: builder.environments.client!.config.build.outDir,
    };
    const result = await runPrerender({ root: fixtureDir, routeRootConfig });
    await emitPrerenderPathManifest({ root: fixtureDir, routeRootConfig });

    expect(fs.existsSync(path.join(fixtureDir, "dist"))).toBe(false);
    // stale.txt is gone: the build emptied build.outDir as it empties dist.
    expect(fs.readdirSync(outDir).sort()).toEqual(["client", "server", "vinext-client-assets.js"]);
    expect(result?.routes.filter((route) => route.status === "rendered").length).toBeGreaterThan(0);
    const serverFiles = listFiles(path.join(outDir, "server"));
    expect(serverFiles).toEqual(
      expect.arrayContaining([
        "index.js",
        "ssr/index.js",
        "entry.js",
        "BUILD_ID",
        "vinext-server.json",
        "vinext-prerender.json",
        "vinext-prerender-paths.json",
        "prerendered-routes/index.html",
        "prerendered-routes/about.html",
      ]),
    );
  }, 180_000);

  it("writes a Pages Router build under build.outDir", async () => {
    const fixtureDir = await isolatedFixture(PAGES_FIXTURE_SOURCE_DIR);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-outdir-out-"));
    temporaryDirs.push(outDir);

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      build: { outDir },
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(fixtureDir, "dist"))).toBe(false);
    expect(fs.readdirSync(outDir).sort()).toEqual([
      "client",
      "package.json",
      "server",
      "vinext-client-assets.js",
    ]);
    expect(listFiles(path.join(outDir, "server"))).toEqual(
      expect.arrayContaining(["entry.js", "BUILD_ID", "vinext-server.json"]),
    );
  }, 180_000);

  it("writes a Cloudflare App Router build under build.outDir", async () => {
    const fixtureDir = await isolatedFixture(CF_APP_FIXTURE_SOURCE_DIR, CF_NODE_MODULES_DIR);
    const { cloudflare } = (await import(
      pathToFileURL(path.join(fixtureDir, "node_modules/@cloudflare/vite-plugin/dist/index.mjs"))
        .href
    )) as {
      cloudflare: (options?: {
        inspectorPort?: false;
        viteEnvironment?: { name: string; childEnvironments?: string[] };
      }) => Plugin;
    };
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-outdir-out-"));
    temporaryDirs.push(outDir);

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir }),
        cloudflare({
          inspectorPort: false,
          viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        }),
      ],
      build: { outDir },
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(fixtureDir, "dist"))).toBe(false);
    expect(fs.readdirSync(outDir).sort()).toEqual(["client", "server"]);
    expect(listFiles(path.join(outDir, "server"))).toEqual(
      expect.arrayContaining([
        "index.js",
        "ssr/index.js",
        "wrangler.json",
        "BUILD_ID",
        "vinext-server.json",
      ]),
    );
  }, 180_000);

  it("follows a build.outDir that a later plugin sets", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    fs.rmSync(path.join(fixtureDir, "pages"), { recursive: true });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-outdir-out-"));
    temporaryDirs.push(outDir);

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir }),
        { name: "test:late-outdir", config: () => ({ build: { outDir } }) },
      ],
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(fixtureDir, "dist"))).toBe(false);
    expect(fs.readdirSync(outDir).sort()).toEqual(["client", "server"]);
    expect(listFiles(path.join(outDir, "server"))).toEqual(
      expect.arrayContaining(["index.js", "ssr/index.js", "BUILD_ID", "vinext-server.json"]),
    );
  }, 180_000);

  it("rejects a server outDir inside the client outDir derived from build.outDir", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);

    // The client build runs last and empties build/client, which would delete
    // the RSC output in build/client/rsc.
    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir, rscOutDir: "build/client/rsc" })],
        build: { outDir: "build" },
        logLevel: "silent",
      }),
    ).rejects.toThrow('clientOutDir "build/client" contains rscOutDir "build/client/rsc"');
  });

  it("keeps an explicit rscOutDir when a later plugin sets build.outDir", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir, rscOutDir: "dist/server" }),
        { name: "test:late-outdir", config: () => ({ build: { outDir: "out" } }) },
      ],
      logLevel: "silent",
    });

    const outDirs = Object.fromEntries(
      ["rsc", "ssr", "client"].map((name) => [
        name,
        toSlash(path.relative(fixtureDir, builder.environments[name]!.config.build.outDir)),
      ]),
    );
    expect(outDirs).toEqual({ rsc: "dist/server", ssr: "out/server/ssr", client: "out/client" });
  });

  it("rejects a client outDir that contains the server metadata directory", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);

    // BUILD_ID and vinext-server.json go to <build.outDir>/server, which the
    // last client build would empty along with the rest of "dist".
    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [
          vinext({
            appDir: fixtureDir,
            clientOutDir: "dist",
            rscOutDir: "out/rsc",
            ssrOutDir: "out/ssr",
          }),
        ],
        logLevel: "silent",
      }),
    ).rejects.toThrow('clientOutDir "dist" contains the server metadata directory "dist/server"');
  });

  it("empties an external build.outDir when a later plugin sets emptyOutDir: true", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    fs.rmSync(path.join(fixtureDir, "pages"), { recursive: true });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-outdir-out-"));
    temporaryDirs.push(outDir);
    fs.writeFileSync(path.join(outDir, "stale.txt"), "from an earlier build");

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir }),
        { name: "test:late-outdir", config: () => ({ build: { outDir, emptyOutDir: true } }) },
      ],
      logLevel: "silent",
      [VINEXT_BUILD_LIFECYCLE_CONFIG]: {},
    } as Parameters<typeof createBuilder>[0]);
    await builder.buildApp();

    expect(fs.existsSync(path.join(fixtureDir, "dist"))).toBe(false);
    expect(fs.readdirSync(outDir).sort()).toEqual(["client", "server"]);
  }, 180_000);

  it("rejects a build.outDir whose derived server directory is the project root", async () => {
    // A project named "server" with build.outDir ".." would get its RSC
    // output, which Vite empties, at the project root itself.
    const isolatedDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-outdir-parent-"));
    temporaryDirs.push(parentDir);
    const fixtureDir = path.join(parentDir, "server");
    fs.renameSync(isolatedDir, fixtureDir);
    const source = path.join(fixtureDir, "app", "page.tsx");

    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir })],
        build: { outDir: "..", emptyOutDir: true },
        logLevel: "silent",
      }),
    ).rejects.toThrow('The rsc output directory "." contains the project root');
    expect(fs.existsSync(source)).toBe(true);
  });

  it("previews a plain Pages build from a build.outDir that a later plugin sets", async () => {
    const fixtureDir = await isolatedFixture(PAGES_FIXTURE_SOURCE_DIR);
    const latePlugin = { name: "test:late-outdir", config: () => ({ build: { outDir: "out" } }) };
    const inlineConfig = {
      root: fixtureDir,
      configFile: false as const,
      plugins: [vinext({ appDir: fixtureDir }), latePlugin],
      logLevel: "silent" as const,
    };

    const builder = await createBuilder(inlineConfig);
    // `vite preview` resolves the config again; the preview server serves the
    // client and server environments' outDirs.
    const preview = await resolveConfig(inlineConfig, "serve", "production", "production", true);

    for (const name of ["client", "ssr"]) {
      const outDir = (config: { environments: Record<string, { build: { outDir: string } }> }) =>
        toSlash(
          path.relative(
            fixtureDir,
            path.resolve(fixtureDir, config.environments[name]!.build.outDir),
          ),
        );
      expect(outDir(preview)).toBe(outDir(builder.config));
    }
    expect(
      toSlash(
        path.relative(
          fixtureDir,
          path.resolve(fixtureDir, preview.environments.client!.build.outDir),
        ),
      ),
    ).toBe("out/client");
  });

  it("rejects an environment outDir at the project root set by a configEnvironment hook", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    const source = path.join(fixtureDir, "app", "page.tsx");

    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [
          vinext({ appDir: fixtureDir }),
          {
            name: "test:env-outdir",
            configEnvironment: (name) =>
              name === "rsc" ? { build: { outDir: fixtureDir, emptyOutDir: true } } : undefined,
          },
        ],
        logLevel: "silent",
      }),
    ).rejects.toThrow('The rsc output directory "." contains the project root');
    expect(fs.existsSync(source)).toBe(true);
  });
});
