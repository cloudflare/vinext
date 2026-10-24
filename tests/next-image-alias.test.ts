// A project may alias next/image to its own "use client" wrapper that renders
// vinext's stock component through `vinext/shims/image`. That explicit shim
// import must reach the shim, not the user's next/image alias: resolving it to
// the wrapper made the wrapper render itself, and every request hung (#4262).
//
// A self-rendering wrapper blocks this worker's event loop, so no test timeout
// would fire. Each suite checks the wrapper's import before any request.

import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { toSlash } from "pathslash";
import { createBuilder, type AliasOptions, type Plugin, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, fetchHtml, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-next-image-alias");
const WRAPPER_PATH = path.join(FIXTURE_DIR, "app/image-wrapper.tsx");
const SHIMS_DIR = toSlash(path.resolve(import.meta.dirname, "../packages/vinext/src/shims"));
const SHIM_PATH = `${SHIMS_DIR}/image.tsx`;
// vinext's resolve.alias target for next/image.
const NEXT_IMAGE_ALIAS_TARGET = `${SHIMS_DIR}/image`;
const ENVIRONMENTS = ["client", "ssr"] as const;

function nextImageAlias(fixtureDir: string) {
  return [{ find: /^next\/image$/, replacement: path.join(fixtureDir, "app/image-wrapper.tsx") }];
}

// A customResolver also moves builds from rolldown's native alias plugin to
// Vite's JS one.
function customResolverAlias(fixtureDir: string) {
  return [
    {
      find: "next/image",
      replacement: path.join(SHIMS_DIR, "image"),
      customResolver: () => path.join(fixtureDir, "app/image-wrapper.tsx"),
    },
  ];
}

const CUSTOM_RESOLVER_FORM = "a custom resolver over vinext's own replacement";

const DEV_ALIAS_FORMS: Array<[string, AliasOptions]> = [
  ["a RegExp", nextImageAlias(FIXTURE_DIR)],
  ["an object key", { "next/image": WRAPPER_PATH }],
  [CUSTOM_RESOLVER_FORM, customResolverAlias(FIXTURE_DIR)],
];

const PRODUCTION_ALIAS_FORMS: Array<[string, (fixtureDir: string) => AliasOptions]> = [
  ["a RegExp", nextImageAlias],
  [CUSTOM_RESOLVER_FORM, customResolverAlias],
];

// Records the environments where the wrapper's vinext/shims/image import was
// forwarded through vinext's next/image alias. With a user alias, next/image
// never reaches that target, so this only observes the unaliased case.
function recordNextImageForwarding(environments: string[]): Plugin {
  return {
    name: "test:record-next-image-forwarding",
    // Ahead of vinext's own resolvers, which settle the alias target.
    enforce: "pre",
    resolveId(id, importer) {
      if (toSlash(id) === NEXT_IMAGE_ALIAS_TARGET && importer === WRAPPER_PATH) {
        environments.push(this.environment.name);
      }
    },
  };
}

async function resolveShimFromWrapper(server: ViteDevServer, environment: string) {
  const resolved = await server.environments[environment].pluginContainer.resolveId(
    "vinext/shims/image",
    WRAPPER_PATH,
  );
  return resolved?.id;
}

// Records the wrapper's resolved imports in each environment's build graph.
function recordWrapperImports(imports: Map<string, string[]>): Plugin {
  return {
    name: "test:record-wrapper-imports",
    buildEnd() {
      for (const id of this.getModuleIds()) {
        if (!toSlash(id).endsWith("/app/image-wrapper.tsx")) continue;
        const importedIds = this.getModuleInfo(id)?.importedIds ?? [];
        imports.set(this.environment.name, importedIds.map(toSlash));
      }
    },
  };
}

function expectStockImage(html: string): void {
  expect(html).toMatch(/<img[^>]*data-testid="aliased-image"/);
  expect(html).toContain('src="/_next/image?url=%2Fx.png&amp;');
  expect(html).toContain('data-nimg="1"');
}

describe.each(DEV_ALIAS_FORMS)(
  "next/image aliased by %s to a wrapper of vinext/shims/image (dev)",
  (_form, alias) => {
    const resolved = new Map<string, string | undefined>();
    let server: ViteDevServer;
    let baseUrl: string;

    beforeAll(async () => {
      ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
        appRouter: true,
        resolve: { alias },
      }));
      for (const environment of ENVIRONMENTS) {
        resolved.set(environment, await resolveShimFromWrapper(server, environment));
      }
    }, 60_000);

    // Closing waits for the dep optimizer, which is slow on a loaded machine.
    afterAll(async () => {
      await server?.close();
    }, 30_000);

    it("renders the stock image through the wrapper", async () => {
      // Checked before the request, which would never finish otherwise.
      expect(Object.fromEntries(resolved)).toEqual({ client: SHIM_PATH, ssr: SHIM_PATH });
      const { res, html } = await fetchHtml(baseUrl, "/");
      expect(res.status).toBe(200);
      expectStockImage(html);
    });
  },
);

describe("next/image not aliased by the user (dev)", () => {
  const forwarded: string[] = [];
  let server: ViteDevServer;

  beforeAll(async () => {
    ({ server } = await startFixtureServer(FIXTURE_DIR, {
      appRouter: true,
      listen: false,
      prependPlugins: [recordNextImageForwarding(forwarded)],
      // Aliases that do not take next/image.
      resolve: {
        alias: [
          { find: "@", replacement: path.join(FIXTURE_DIR, "app") },
          { find: /^next-image$/, replacement: WRAPPER_PATH },
        ],
      },
    }));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  // The browser and SSR share next/image's module, including its dep optimizer
  // pre-bundle when there is one.
  it("resolves vinext/shims/image through next/image outside RSC", async () => {
    for (const environment of ENVIRONMENTS) {
      expect(await resolveShimFromWrapper(server, environment), environment).toBe(SHIM_PATH);
    }
    expect(new Set(forwarded)).toEqual(new Set(ENVIRONMENTS));
  });
});

describe.each(PRODUCTION_ALIAS_FORMS)(
  "next/image aliased by %s to a wrapper of vinext/shims/image (production)",
  (_form, aliasFor) => {
    const wrapperImports = new Map<string, string[]>();
    let fixtureDir = "";
    let server: Server | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      fixtureDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-next-image-alias-");
      fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
      const builder = await createBuilder({
        root: fixtureDir,
        configFile: false,
        plugins: [vinext({ appDir: fixtureDir }), recordWrapperImports(wrapperImports)],
        resolve: { alias: aliasFor(fixtureDir) },
        logLevel: "silent",
      });
      await builder.buildApp();
      // Build module ids are canonical paths.
      const shimId = toSlash(fs.realpathSync.native(SHIM_PATH));
      for (const environment of ENVIRONMENTS) {
        const imports = wrapperImports.get(environment);
        if (!imports?.includes(shimId)) {
          throw new Error(
            `${environment} build: the wrapper imports ${JSON.stringify(imports)}, not the shim`,
          );
        }
      }

      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      ({ server } = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: path.join(fixtureDir, "dist"),
        noCompression: true,
      }));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address");
      baseUrl = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(() => {
      server?.close();
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it("renders the stock image through the wrapper", async () => {
      const { res, html } = await fetchHtml(baseUrl, "/");
      expect(res.status).toBe(200);
      expectStockImage(html);
    });
  },
);
