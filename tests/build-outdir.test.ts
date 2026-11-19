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
import { createBuilder, createServer, resolveConfig, type Plugin } from "vite";
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
const NITRO_PAGES_FIXTURE_SOURCE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/pages-router-nitro",
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

    // vinext resolves the root through symlinks (macOS's /var is /private/var).
    const realRoot = fs.realpathSync(fixtureDir);
    const outDirs = Object.fromEntries(
      ["rsc", "ssr", "client"].map((name) => [
        name,
        toSlash(path.relative(realRoot, builder.environments[name]!.config.build.outDir)),
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
    ).rejects.toThrow('The build.outDir ".." contains the project root');
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

  it("rejects a build.outDir equal to the project root", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    // An app's own server/ directory would be the derived RSC outDir.
    const source = path.join(fixtureDir, "server", "db.ts");
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, "export const db = {};\n");

    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir })],
        build: { outDir: "." },
        logLevel: "silent",
      }),
    ).rejects.toThrow('The build.outDir "." contains the project root');
    expect(fs.existsSync(source)).toBe(true);
  });

  it("rejects a build.outDir that holds the app directory before cleaning it", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    const source = path.join(fixtureDir, "app", "page.tsx");

    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir })],
        build: { outDir: "app" },
        logLevel: "silent",
        [VINEXT_BUILD_LIFECYCLE_CONFIG]: {},
      } as Parameters<typeof createBuilder>[0]),
    ).rejects.toThrow('The build.outDir "app" overlaps the app directory "app"');
    expect(fs.existsSync(source)).toBe(true);
  });

  it("checks an environment's build.outDir when each bundler output has its own dir", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);

    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir })],
        environments: {
          client: {
            build: { outDir: "app", rolldownOptions: { output: { dir: "out/client" } } },
          },
        },
        logLevel: "silent",
        [VINEXT_BUILD_LIFECYCLE_CONFIG]: {},
      } as Parameters<typeof createBuilder>[0]),
    ).rejects.toThrow('The client output directory "app" overlaps the app directory "app"');
  });

  it("checks build.outDir for a build that doesn't write", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);

    // vinext's own hooks still write their files with build.write: false.
    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir })],
        build: { outDir: "app", write: false },
        logLevel: "silent",
        [VINEXT_BUILD_LIFECYCLE_CONFIG]: {},
      } as Parameters<typeof createBuilder>[0]),
    ).rejects.toThrow('The build.outDir "app" overlaps the app directory "app"');
  });

  it("rejects a plugin that moves Vite's root after vinext read it", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-moved-root-repo-"));
    temporaryDirs.push(repo);
    fs.mkdirSync(path.join(repo, ".git"));
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(repo, "site"));

    // The root Vite would build from is in a repository vinext never checked.
    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [
          vinext({ appDir: fixtureDir }),
          { name: "move-root", config: () => ({ root: path.join(repo, "site") }) },
        ],
        build: { outDir: path.join(repo, ".git") },
        logLevel: "silent",
      }),
    ).rejects.toThrow("A plugin moved Vite's root");
    expect(fs.existsSync(path.join(repo, ".git", "HEAD"))).toBe(true);
  });

  it("rejects an environment outDir inside the public directory", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);
    const asset = path.join(fixtureDir, "public", "assets", "logo.svg");
    fs.mkdirSync(path.dirname(asset), { recursive: true });
    fs.writeFileSync(asset, "<svg/>");

    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir, clientOutDir: "public/assets" })],
        logLevel: "silent",
      }),
    ).rejects.toThrow(
      'The client output directory "public/assets" overlaps the public directory "public"',
    );
    expect(fs.existsSync(asset)).toBe(true);
  });

  it("rejects a bundler output dir that overlaps the app directory", async () => {
    const fixtureDir = await isolatedFixture(APP_FIXTURE_SOURCE_DIR);

    await expect(
      createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir })],
        environments: { rsc: { build: { rolldownOptions: { output: { dir: "app" } } } } },
        logLevel: "silent",
      }),
    ).rejects.toThrow('The rsc output directory "app" overlaps the app directory "app"');
    expect(fs.existsSync(path.join(fixtureDir, "app", "page.tsx"))).toBe(true);
  });

  it("keeps the server metadata under build.outDir out of Nitro's public output", async () => {
    const fixtureDir = await isolatedFixture(
      NITRO_PAGES_FIXTURE_SOURCE_DIR,
      path.join(NITRO_PAGES_FIXTURE_SOURCE_DIR, "node_modules"),
    );
    // Nitro publishes Vite's build.outDir as static files.
    const outDir = path.join(fixtureDir, "out");
    const nitroModule = (await import(
      pathToFileURL(path.join(fixtureDir, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(config?: Record<string, unknown>): Plugin[] };

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir }),
        nitroModule.nitro({ buildDir: path.join(fixtureDir, ".nitro") }),
      ],
      build: { outDir },
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(outDir, "server", "vinext-server.json"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, ".output", "public", "hello.txt"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureDir, ".output", "public", "server"))).toBe(false);
  }, 180_000);

  it("keeps an earlier build.outDir's server metadata out of Nitro's public output", async () => {
    const fixtureDir = await isolatedFixture(
      NITRO_PAGES_FIXTURE_SOURCE_DIR,
      path.join(NITRO_PAGES_FIXTURE_SOURCE_DIR, "node_modules"),
    );
    // Nitro publishes the build.outDir it sees, which a later build left its
    // server metadata in, before a plugin after Nitro moves build.outDir.
    const nitroOutDir = path.join(fixtureDir, "out");
    fs.mkdirSync(path.join(nitroOutDir, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(nitroOutDir, "server", "vinext-server.json"),
      '{"prerenderSecret":"last-build-secret"}',
    );
    const nitroModule = (await import(
      pathToFileURL(path.join(fixtureDir, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(config?: Record<string, unknown>): Plugin[] };

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir }),
        nitroModule.nitro({ buildDir: path.join(fixtureDir, ".nitro") }),
        {
          name: "move-outdir",
          config: () => ({ build: { outDir: path.join(fixtureDir, "final") } }),
        },
      ],
      build: { outDir: nitroOutDir },
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(fixtureDir, ".output", "public", "server"))).toBe(false);
  }, 180_000);

  it("ignores the server metadata where Nitro reads a relative build.outDir", async () => {
    const fixtureDir = await isolatedFixture(
      NITRO_PAGES_FIXTURE_SOURCE_DIR,
      path.join(NITRO_PAGES_FIXTURE_SOURCE_DIR, "node_modules"),
    );
    // Nitro reads a relative build.outDir from the working directory, not
    // from Vite's root.
    const nitroOutDir = path.join(fixtureDir, "out");
    fs.mkdirSync(path.join(nitroOutDir, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(nitroOutDir, "server", "vinext-server.json"),
      '{"prerenderSecret":"last-build-secret"}',
    );
    const nitroModule = (await import(
      pathToFileURL(path.join(fixtureDir, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(config?: Record<string, unknown>): Plugin[] };

    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir }),
        nitroModule.nitro({ buildDir: path.join(fixtureDir, ".nitro") }),
        {
          name: "move-outdir",
          config: () => ({ build: { outDir: path.join(fixtureDir, "final") } }),
        },
      ],
      build: { outDir: path.relative(process.cwd(), nitroOutDir) },
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(fixtureDir, ".output", "public", "server"))).toBe(false);
  }, 180_000);

  it("keeps the last build's server metadata out of Nitro's dev server", async () => {
    const fixtureDir = await isolatedFixture(
      NITRO_PAGES_FIXTURE_SOURCE_DIR,
      path.join(NITRO_PAGES_FIXTURE_SOURCE_DIR, "node_modules"),
    );
    // A previous production build left its server metadata under build.outDir.
    const outDir = path.join(fixtureDir, "out");
    fs.mkdirSync(path.join(outDir, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "server", "vinext-server.json"),
      '{"prerenderSecret":"last-build-secret"}',
    );
    fs.mkdirSync(path.join(fixtureDir, "other"), { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "other", "other.txt"), "other asset");
    const nitroModule = (await import(
      pathToFileURL(path.join(fixtureDir, "node_modules/nitro/dist/vite.mjs")).href
    )) as { nitro(config?: Record<string, unknown>): Plugin[] };

    const server = await createServer({
      root: fixtureDir,
      configFile: false,
      plugins: [
        vinext({ appDir: fixtureDir }),
        // A plugin's config hook sets the build.outDir that Nitro publishes.
        { name: "set-outdir", config: () => ({ build: { outDir } }) },
        nitroModule.nitro({
          buildDir: path.join(fixtureDir, ".nitro"),
          // A module set up before vinext's publishes another root directory,
          // shaped like Nitro's build.outDir entry, after Nitro registers it
          // and before build:before's handlers run.
          modules: [
            (nitro: {
              options: { publicAssets: Record<string, unknown>[] };
              hooks: { beforeEach(handler: (event: { name: string }) => void): void };
            }) => {
              nitro.hooks.beforeEach(({ name }) => {
                if (name !== "build:before") return;
                nitro.options.publicAssets.push({
                  dir: path.join(fixtureDir, "other"),
                  baseURL: "/",
                  fallthrough: true,
                  maxAge: 0,
                });
              });
            },
          ],
        }),
      ],
      server: { port: 0, host: "127.0.0.1" },
      logLevel: "silent",
    });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("dev server has no address");
      const response = await fetch(`http://127.0.0.1:${address.port}/server/vinext-server.json`);

      expect(await response.text()).not.toContain("last-build-secret");
      const other = await fetch(`http://127.0.0.1:${address.port}/other.txt`);
      expect(await other.text()).toBe("other asset");
    } finally {
      await server.close();
    }
  }, 120_000);
});
