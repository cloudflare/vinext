import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder, createIdResolver, createServer, type Plugin } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRequireConditionResolutionPlugin,
  isConditionalRequireScriptModuleId,
} from "../packages/vinext/src/plugins/require-condition-resolution.js";
import { createTransitiveExternalsPlugin } from "../packages/vinext/src/plugins/transitive-externals.js";

// Ported from Next.js: test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts

type TestResolve = (
  specifier: string,
  importer: string,
  isRequire: boolean,
) => Promise<string | undefined>;
type TestFilter = (id: string) => boolean | undefined;

const TEST_ENVIRONMENT = { config: { resolve: { external: [] }, build: {} } };

function createPlugin(
  resolve: TestResolve,
  filter: TestFilter = (id) => (isConditionalRequireScriptModuleId(id) ? true : undefined),
) {
  const createResolver = vi.fn(
    (_config: unknown, options?: { isRequire?: boolean }) =>
      (_environment: unknown, specifier: string, importer?: string) =>
        resolve(specifier, importer ?? "", options?.isRequire === true),
  );
  const plugin = createRequireConditionResolutionPlugin(createResolver as never, filter);
  const configResolved = plugin.configResolved;
  if (typeof configResolved !== "function") throw new Error("missing configResolved hook");
  void configResolved.call({} as never, {} as never);
  return plugin;
}

function createTransform(resolve: TestResolve, filter?: TestFilter) {
  const hook = createPlugin(resolve, filter).transform;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  return handler!.bind({ environment: TEST_ENVIRONMENT } as never) as (
    code: string,
    id: string,
  ) => Promise<{ code: string } | null>;
}

describe("vinext:require-condition-resolution", () => {
  it("pre-resolves package require calls with the require import kind", async () => {
    const resolve = vi.fn(async (_specifier: string, _importer: string, isRequire: boolean) =>
      isRequire ? "/app/node_modules/library/index.cjs" : "/app/node_modules/library/index.mjs",
    );
    const transform = createTransform(resolve);

    const result = await transform(
      `const Library = require("library");\nexport default Library;`,
      "/app/page.tsx",
    );

    expect(resolve).toHaveBeenCalledWith("library", "/app/page.tsx", true);
    expect(resolve).toHaveBeenCalledWith("library", "/app/page.tsx", false);
    expect(result?.code).toContain(
      'require("/app/node_modules/library/index.cjs.vinext-require.js")',
    );
  });

  it("skips ordinary node_modules that the CommonJS transform ignores", async () => {
    const resolve = vi.fn(async () => "/app/node_modules/nested/index.cjs");
    const transform = createTransform(resolve);

    expect(
      await transform(
        `module.exports = require("nested");`,
        "/app/node_modules/dependency/index.js",
      ),
    ).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["cjs", "cts"])(
    "skips project .%s files that the CommonJS transform ignores",
    async (extension) => {
      const resolve = vi.fn(async () => "/app/node_modules/library/index.cjs");
      const filter = vi.fn((id: string) =>
        /\.c[jt]s$/i.test(id) && !id.includes("node_modules") ? false : undefined,
      );
      const transform = createTransform(resolve, filter);

      expect(
        await transform(`module.exports = require("library");`, `/app/config.${extension}`),
      ).toBeNull();
      expect(filter).toHaveBeenCalledWith(`/app/config.${extension}`);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("resolves import and require branches independently", async () => {
    const resolve = vi.fn(async (specifier: string, _importer: string, isRequire: boolean) =>
      isRequire
        ? `/app/node_modules/${specifier}/index.cjs`
        : `/app/node_modules/${specifier}/index.mjs`,
    );
    const transform = createTransform(resolve);

    const result = await transform(
      `import Library from "library";\nconst RequiredLibrary = require("library");`,
      "/app/page.tsx",
    );

    expect(result?.code).toContain('import Library from "library"');
    expect(result?.code).toContain(
      'require("/app/node_modules/library/index.cjs.vinext-require.js")',
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite a lexically bound require function", async () => {
    const resolve = vi.fn(async () => "/app/node_modules/library/index.cjs");
    const transform = createTransform(resolve);

    const result = await transform(
      `function load(require: (id: string) => unknown) { return require("library"); }`,
      "/app/page.ts",
    );

    expect(result).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("leaves relative, external, and unresolved requires unchanged", async () => {
    const resolve = vi.fn(async (specifier: string) => {
      if (specifier === "external") return specifier;
      return undefined;
    });
    const transform = createTransform(resolve);

    const result = await transform(
      `require("./local"); require("external"); require("missing");`,
      "/app/page.js",
    );

    expect(result).toBeNull();
    // The bare "external" result is retried with the bundling resolvers.
    expect(resolve).toHaveBeenCalledTimes(6);
  });

  it("leaves packages with the same import and require entry untouched", async () => {
    const resolve = vi.fn(async () => "/app/node_modules/library/index.js");
    const transform = createTransform(resolve);

    const result = await transform(`require("library");`, "/app/page.js");

    expect(result).toBeNull();
  });

  it("ignores query-only differences for the same resolved entry", async () => {
    const resolve = vi.fn(async (_specifier: string, _importer: string, isRequire: boolean) =>
      isRequire
        ? "/app/node_modules/library/index.js?require"
        : "/app/node_modules/library/index.js?import",
    );
    const transform = createTransform(resolve);

    const result = await transform(`require("library");`, "/app/page.js");

    expect(result).toBeNull();
  });

  it("loads the selected CJS source through its synthetic JavaScript identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-condition-"));
    try {
      const target = path.join(root, "index.cjs");
      await writeFile(target, `"use client"; module.exports = () => "cjs";\n`);
      const plugin = createPlugin(
        vi.fn(async (_specifier: string, _importer: string, isRequire: boolean) =>
          isRequire ? target : `${target}.mjs`,
        ),
      );
      const transformHook = plugin.transform;
      const transformHandler =
        typeof transformHook === "function" ? transformHook : transformHook?.handler;
      if (!transformHandler) throw new Error("missing transform hook");
      const transform = transformHandler.bind({ environment: TEST_ENVIRONMENT } as never) as (
        code: string,
        id: string,
      ) => Promise<{ code: string }>;

      const transformed = await transform(`require("library");`, path.join(root, "page.tsx"));
      const virtualId = `${target}.vinext-require.js`;
      expect(transformed.code).toContain(JSON.stringify(virtualId));

      const resolveId = plugin.resolveId;
      expect(typeof resolveId).toBe("function");
      expect(await (resolveId as Function).call({} as never, virtualId)).toBe(virtualId);

      const addWatchFile = vi.fn();
      const load = plugin.load;
      expect(typeof load).toBe("function");
      expect(await (load as Function).call({ addWatchFile } as never, virtualId)).toEqual({
        code: `"use client"; module.exports = () => "cjs";\n`,
        moduleType: "js",
      });
      expect(addWatchFile).toHaveBeenCalledWith(target);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rewrites nested package requires in synthetic targets", async () => {
    const resolve = vi.fn(async (specifier: string, _importer: string, isRequire: boolean) =>
      isRequire
        ? `/app/node_modules/${specifier}/index.cjs`
        : `/app/node_modules/${specifier}/index.mjs`,
    );
    const transform = createTransform(resolve);

    const outer = await transform(`module.exports = require("outer");`, "/app/page.tsx");
    const outerId = "/app/node_modules/outer/index.cjs.vinext-require.js";
    expect(outer?.code).toContain(JSON.stringify(outerId));

    const inner = await transform(`module.exports = require("inner");`, outerId);
    expect(inner?.code).toContain(
      JSON.stringify("/app/node_modules/inner/index.cjs.vinext-require.js"),
    );
  });

  it("preserves JSON module typing for a conditional require target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-condition-json-"));
    try {
      const target = path.join(root, "data.json");
      await writeFile(target, `{"condition":"require"}\n`);
      const plugin = createPlugin(
        vi.fn(async (_specifier: string, _importer: string, isRequire: boolean) =>
          isRequire ? target : path.join(root, "data.js"),
        ),
      );
      const transformHook = plugin.transform;
      const transformHandler =
        typeof transformHook === "function" ? transformHook : transformHook?.handler;
      if (!transformHandler) throw new Error("missing transform hook");
      const transformed = await transformHandler.call(
        { environment: TEST_ENVIRONMENT } as never,
        `require("library");`,
        path.join(root, "page.tsx"),
      );
      const virtualId = `${target}.vinext-require.json`;
      const transformedCode =
        typeof transformed === "string" ? transformed : (transformed?.code ?? "");
      expect(transformedCode).toContain(JSON.stringify(virtualId));

      const load = plugin.load;
      expect(typeof load).toBe("function");
      expect(await (load as Function).call({ addWatchFile: vi.fn() } as never, virtualId)).toEqual({
        code: `{"condition":"require"}\n`,
        moduleType: "json",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers stale synthetic targets to Vite's contextual load error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-condition-stale-"));
    try {
      const target = path.join(root, "missing.cjs");
      const plugin = createPlugin(
        vi.fn(async (_specifier: string, _importer: string, isRequire: boolean) =>
          isRequire ? target : path.join(root, "index.mjs"),
        ),
      );
      const transformHook = plugin.transform;
      const transformHandler =
        typeof transformHook === "function" ? transformHook : transformHook?.handler;
      if (!transformHandler) throw new Error("missing transform hook");
      await transformHandler.call(
        { environment: TEST_ENVIRONMENT } as never,
        `require("library");`,
        path.join(root, "page.tsx"),
      );

      const load = plugin.load;
      expect(typeof load).toBe("function");
      expect(
        await (load as Function).call(
          { addWatchFile: vi.fn() } as never,
          `${target}.vinext-require.js`,
        ),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Server environments without `noExternal: true` (e.g. Nitro services)
  // externalize node_modules packages by default. Run real builds so explicit
  // externals and plugins are judged by Rolldown itself.
  const userExternal = (match: (id: string, isResolved: boolean) => boolean) => ({
    build: {
      rolldownOptions: {
        external: (id: string, _importer: string | undefined, isResolved: boolean) =>
          match(id, isResolved),
      },
    },
  });
  // Vite's own resolver runs before normal plugins, so only a pre plugin could
  // intercept the bare import before this rewrite.
  const redirectPlugin: Plugin = {
    name: "redirect-lib-cjs",
    enforce: "pre",
    resolveId(source) {
      if (source === "lib-cjs") return "\0lib-cjs-redirect";
    },
    load(id) {
      if (id === "\0lib-cjs-redirect") return "export default 'redirect';";
    },
  };
  const externalPlugin: Plugin = {
    name: "externalize-lib-cjs",
    enforce: "pre",
    resolveId(source) {
      if (source === "lib-cjs") return { id: source, external: true };
    },
  };

  async function withConditionalPackage<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vinext-require-condition-")));
    try {
      const packageDir = path.join(root, "node_modules", "lib-cjs");
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "lib-cjs",
          version: "1.0.0",
          type: "commonjs",
          exports: { ".": { import: "./index.mjs", default: "./index.js" } },
        }),
      );
      await writeFile(path.join(packageDir, "index.js"), "module.exports = 'cjs';\n");
      await writeFile(path.join(packageDir, "index.mjs"), "export default 'esm';\n");
      await writeFile(
        path.join(root, "page.js"),
        `const Library = require("lib-cjs");\nconst Again = require("lib-cjs");\nexport { Library, Again };\n`,
      );
      return await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function recordPage(onPage: (code: string) => void): Plugin {
    return {
      name: "record-page",
      transform(code, id) {
        if (id.endsWith("/page.js")) onPage(code);
      },
    };
  }

  function expectRewritten(root: string, code: string | undefined, rewritten: boolean) {
    const virtualId = `${path.join(root, "node_modules", "lib-cjs", "index.js")}.vinext-require.js`;
    const call = rewritten ? `require(${JSON.stringify(virtualId)})` : `require("lib-cjs")`;
    // The fixture requires the package twice; both calls must agree.
    expect(code?.split(call).length).toBe(3);
  }

  it.each<[string, Record<string, unknown>, boolean, Plugin[]?, Record<string, unknown>?]>([
    ["bundles the require target of a default-externalized package", {}, true],
    [
      "bundles past a bundler external that does not match",
      { build: { rollupOptions: { external: [/^nitro(\/|$)/] } } },
      true,
    ],
    [
      "keeps a package listed in resolve.external external",
      { resolve: { external: ["lib-cjs"] } },
      false,
    ],
    [
      "keeps packages external when resolve.external is true",
      { resolve: { external: true } },
      false,
    ],
    [
      "keeps a string bundler external external",
      { build: { rolldownOptions: { external: ["lib-cjs"] } } },
      false,
    ],
    [
      "keeps a RegExp bundler external external",
      { build: { rollupOptions: { external: /^lib-/ } } },
      false,
    ],
    ["keeps a function bundler external external", userExternal((id) => id === "lib-cjs"), false],
    [
      "matches a sticky RegExp bundler external like Rolldown",
      { build: { rollupOptions: { external: /cjs/y } } },
      false,
    ],
    [
      "matches a frozen global RegExp bundler external without mutating it",
      { build: { rollupOptions: { external: Object.freeze(/^lib-/g) } } },
      false,
    ],
    [
      "leaves a require whose synthetic id is a bundler external",
      { build: { rollupOptions: { external: /node_modules/ } } },
      false,
    ],
    [
      "leaves a require whose resolved synthetic id a function bundler external matches",
      userExternal((id, isResolved) => isResolved && id.endsWith(".vinext-require.js")),
      false,
    ],
    // The environment externalizes the bare id before Rolldown resolves it, so
    // resolved-path externals never saw these targets without the rewrite.
    [
      "bundles past a function external on the import target",
      userExternal((id, isResolved) => isResolved && id.endsWith("/index.mjs")),
      true,
    ],
    [
      "bundles past a function external on the require target",
      userExternal((id, isResolved) => isResolved && id.endsWith("/lib-cjs/index.js")),
      true,
    ],
    ["leaves a package that a plugin resolves elsewhere", {}, false, [redirectPlugin]],
    ["leaves a package that a plugin externalizes", {}, false, [externalPlugin]],
    [
      "leaves a require whose synthetic id an options-hook external matches",
      {},
      false,
      [
        {
          name: "add-node-modules-external",
          options(options) {
            return { ...options, external: /node_modules/ };
          },
        },
      ],
    ],
    // Without Vite's `packageJsonPath` tag, its externalization looks exactly
    // like a plugin's, so the call keeps the environment's resolution.
    [
      "leaves the call under the legacy CJS interop",
      {},
      false,
      [],
      { legacy: { inconsistentCjsInterop: true } },
    ],
  ])("%s", async (_name, environment, rewritten, plugins = [], config = {}) => {
    await withConditionalPackage(async (root) => {
      let page: string | undefined;
      const builder = await createBuilder({
        ...config,
        root,
        configFile: false,
        logLevel: "silent",
        build: { ssr: "page.js", write: false },
        environments: { ssr: environment },
        plugins: [
          createRequireConditionResolutionPlugin(createIdResolver, () => undefined),
          ...plugins,
          recordPage((code) => (page = code)),
        ],
      });
      await builder.build(builder.environments.ssr);
      expectRewritten(root, page, rewritten);
    });
  });

  it("keeps server external packages such as native addons external", async () => {
    await withConditionalPackage(async (root) => {
      const packageDir = path.join(root, "node_modules", "lib-cjs");
      await writeFile(path.join(packageDir, "binding.node"), "not a JavaScript module");
      await writeFile(
        path.join(packageDir, "index.js"),
        `module.exports = require("./binding.node");\n`,
      );

      let page: string | undefined;
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        build: { ssr: "page.js", write: false },
        plugins: [
          createRequireConditionResolutionPlugin(
            createIdResolver,
            () => undefined,
            () => ["lib-cjs"],
          ),
          recordPage((code) => (page = code)),
        ],
      });
      await builder.build(builder.environments.ssr);
      expectRewritten(root, page, false);
    });
  });

  it.each([
    ["transitive-externals bundles", true],
    ["a pre plugin resolves to the same file", false],
  ])("server external private copy: %s (rewritten: %s)", async (_case, viaTransitive) => {
    await withConditionalPackage(async (root) => {
      const packageDir = path.join(root, "node_modules", "lib-cjs");
      const writeServerExt = async (dir: string) => {
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "package.json"),
          JSON.stringify({
            name: "server-ext",
            version: "1.0.0",
            type: "commonjs",
            exports: { ".": { import: "./index.mjs", default: "./index.js" } },
          }),
        );
        await writeFile(path.join(dir, "index.js"), "module.exports = 'cjs';\n");
        await writeFile(path.join(dir, "index.mjs"), "export default 'esm';\n");
      };
      const privateDir = path.join(packageDir, "node_modules", "server-ext");
      await writeServerExt(path.join(root, "node_modules", "server-ext"));
      await writeServerExt(privateDir);
      await writeFile(
        path.join(packageDir, "index.js"),
        `module.exports = require("server-ext");\n`,
      );

      let target: string | undefined;
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        build: { ssr: "page.js", write: false },
        plugins: [
          createRequireConditionResolutionPlugin(
            createIdResolver,
            (id) => (isConditionalRequireScriptModuleId(id) ? true : undefined),
            () => ["server-ext"],
          ),
          viaTransitive
            ? createTransitiveExternalsPlugin({
                getRoot: () => root,
                getExternalPackages: () => ["server-ext"],
              })
            : {
                name: "user-redirect",
                enforce: "pre",
                resolveId(source) {
                  if (source === "server-ext") return path.join(privateDir, "index.mjs");
                },
              },
          {
            name: "record-target",
            transform(code, id) {
              if (id.endsWith("/lib-cjs/index.js.vinext-require.js")) target = code;
            },
          },
        ],
      });
      await builder.build(builder.environments.ssr);
      const privateRequire = `require(${JSON.stringify(`${path.join(privateDir, "index.js")}.vinext-require.js`)})`;
      if (viaTransitive) expect(target).toContain(privateRequire);
      else expect(target).toContain(`require("server-ext")`);
    });
  });

  it("bundles a synthetic target's private dependencies rather than hoisted copies", async () => {
    await withConditionalPackage(async (root) => {
      const packageDir = path.join(root, "node_modules", "lib-cjs");
      for (const [dir, value] of [
        [path.join(packageDir, "node_modules", "plain-dep"), "private-copy"],
        [path.join(root, "node_modules", "plain-dep"), "hoisted-copy"],
      ]) {
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "package.json"),
          JSON.stringify({ name: "plain-dep", version: "1.0.0", main: "index.js" }),
        );
        await writeFile(path.join(dir, "index.js"), `module.exports = ${JSON.stringify(value)};\n`);
      }
      await writeFile(
        path.join(packageDir, "index.js"),
        `module.exports = require("plain-dep");\n`,
      );

      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        build: { ssr: "page.js", write: false },
        environments: { ssr: { resolve: { noExternal: true } } },
        plugins: [createRequireConditionResolutionPlugin(createIdResolver, () => undefined)],
      });
      const output = await builder.build(builder.environments.ssr);
      const code = JSON.stringify(output);
      expect(code).toContain("private-copy");
      expect(code).not.toContain("hoisted-copy");
    });
  });

  it("keeps rewriting in environments that already bundle every package", async () => {
    await withConditionalPackage(async (root) => {
      let page: string | undefined;
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        build: { ssr: "page.js", write: false },
        environments: {
          ssr: {
            resolve: { noExternal: true },
            build: { rolldownOptions: { external: /node_modules\/lib-cjs\/index\.mjs$/ } },
          },
        },
        plugins: [
          createRequireConditionResolutionPlugin(createIdResolver, () => undefined),
          recordPage((code) => (page = code)),
        ],
      });
      await builder.build(builder.environments.ssr);
      expectRewritten(root, page, true);
    });
  });

  it("resolves nested requires from the file a synthetic target stands for", async () => {
    await withConditionalPackage(async (root) => {
      const packageDir = path.join(root, "node_modules", "lib-cjs");
      const privateDir = path.join(packageDir, "node_modules", "private-dep");
      // A hoisted copy that resolution from the project root would pick.
      for (const dir of [privateDir, path.join(root, "node_modules", "private-dep")]) {
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "package.json"),
          JSON.stringify({
            name: "private-dep",
            version: "1.0.0",
            type: "commonjs",
            exports: { ".": { import: "./index.mjs", default: "./index.js" } },
          }),
        );
        await writeFile(path.join(dir, "index.js"), "module.exports = 'cjs';\n");
        await writeFile(path.join(dir, "index.mjs"), "export default 'esm';\n");
      }
      await writeFile(
        path.join(packageDir, "index.js"),
        `module.exports = require("private-dep");\n`,
      );

      let target: string | undefined;
      const builder = await createBuilder({
        root,
        configFile: false,
        logLevel: "silent",
        build: { ssr: "page.js", write: false },
        plugins: [
          createRequireConditionResolutionPlugin(createIdResolver, (id) =>
            isConditionalRequireScriptModuleId(id) ? true : undefined,
          ),
          {
            name: "record-target",
            transform(code, id) {
              if (id.endsWith("/lib-cjs/index.js.vinext-require.js")) target = code;
            },
          },
        ],
      });
      await builder.build(builder.environments.ssr);
      expect(target).toContain(
        `require(${JSON.stringify(`${path.join(privateDir, "index.js")}.vinext-require.js`)})`,
      );
    });
  });

  it("ignores build-only bundler externals in dev", async () => {
    await withConditionalPackage(async (root) => {
      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { middlewareMode: true, hmr: false, ws: false },
        environments: { ssr: { build: { rolldownOptions: { external: ["lib-cjs"] } } } },
        plugins: [createRequireConditionResolutionPlugin(createIdResolver, () => undefined)],
      });
      try {
        const result = await server.environments.ssr.transformRequest("/page.js");
        expect(result?.code).toContain(
          `${path.join(root, "node_modules", "lib-cjs", "index.js")}.vinext-require.js`,
        );
      } finally {
        await server.close();
      }
    });
  });
});
