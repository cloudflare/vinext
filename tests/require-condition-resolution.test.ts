import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRequireConditionResolutionPlugin,
  isConditionalRequireScriptModuleId,
} from "../packages/vinext/src/plugins/require-condition-resolution.js";

// Ported from Next.js: test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts

type TestResolve = (
  specifier: string,
  importer: string,
  isRequire: boolean,
) => Promise<string | undefined>;
type TestFilter = (id: string) => boolean | undefined;

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
  return handler!.bind({ environment: {} } as never) as (
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
    expect(resolve).toHaveBeenCalledTimes(4);
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
      const transform = transformHandler.bind({ environment: {} } as never) as (
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
        { environment: {} } as never,
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
        { environment: {} } as never,
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
});

describe("vinext:require-condition-resolution in unbundled ESM dependencies", () => {
  const CACHE_DIR = "/app/node_modules/.vite";
  const ID = "/app/node_modules/dependency/esm/index.js";
  const devServer = {
    mode: "dev",
    config: { cacheDir: CACHE_DIR, dev: { moduleRunnerTransform: true } },
  };

  function createDependencyTransform(environment: object = devServer) {
    const resolve = vi.fn(async () => undefined);
    const hook = createPlugin(resolve).transform;
    const handler = typeof hook === "function" ? hook : hook?.handler;
    const transform = handler!.bind({ environment } as never) as (
      code: string,
      id: string,
    ) => Promise<{ code: string } | null>;
    return { transform, resolve };
  }

  it("awaits module-level calls in place and hoists nested ones after the directives", async () => {
    const { transform, resolve } = createDependencyTransform();

    const result = await transform(
      [
        `#!/usr/bin/env node`,
        `"use client"`,
        `import helper from "./helper.js";`,
        `const path = require("node:path");`,
        `if (typeof window !== "undefined") require("./browser.js");`,
        `export function read() {`,
        `  return [helper, path, require("./data.json"), require("./data.json"), require("server-only")];`,
        `}`,
        `export const shadowed = ((require) => require("./local.js"))(String);`,
        `export class Reader { static value = require("./static.js"); }`,
      ].join("\n"),
      ID,
    );

    expect(result?.code.split("\n")).toEqual([
      `#!/usr/bin/env node`,
      `"use client"`,
      `const __vinext_require_0__ = await __vinext_require_load__(import("./data.json"));` +
        `const __vinext_require_1__ = await __vinext_require_load__(import("server-only"));` +
        `const __vinext_require_2__ = await __vinext_require_load__(import("./static.js"));` +
        `import helper from "./helper.js";`,
      `const path = __vinext_require__(await import("node:path"));`,
      `if (typeof window !== "undefined") __vinext_require__(await import("./browser.js"));`,
      `export function read() {`,
      `  return [helper, path, __vinext_require_0__(), __vinext_require_0__(), __vinext_require_1__()];`,
      `}`,
      `export const shadowed = ((require) => require("./local.js"))(String);`,
      `export class Reader { static value = __vinext_require_2__(); }`,
      expect.stringMatching(/^function __vinext_require__\(m\)/),
      expect.stringMatching(/^function __vinext_require_load__\(load\)/),
    ]);
    // Vite resolves the imports; nothing is pre-resolved.
    expect(resolve).not.toHaveBeenCalled();
  });

  /** Evaluate a transformed module whose only module syntax is `export function read`. */
  async function evaluate(code: string, modules: Record<string, () => Promise<object>>) {
    const loads: string[] = [];
    const body = code
      .replaceAll("import(", "__import(")
      .replace("export function read", "function read");
    const module = new AsyncFunction("__import", `${body}\nreturn read;`);
    const read = (await module((target: string) => {
      loads.push(target);
      return modules[target]?.() ?? Promise.reject(new Error(`Cannot find module '${target}'`));
    })) as () => unknown;
    return { read, loads };
  }
  const AsyncFunction = (async () => {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  it("returns what @vitejs/plugin-rsc's interop returns and throws errors where require() would", async () => {
    const { transform } = createDependencyTransform();
    const result = await transform(
      [
        `let optional = "fallback";`,
        `try { optional = require("missing"); } catch {}`,
        `const loaded = require("cjs");`,
        `if (loaded !== require("cjs")) require("never");`,
        `export function read() {`,
        `  let nested = "fallback";`,
        `  try { nested = require("missing"); } catch (error) { nested = error.message; }`,
        `  return { optional, nested, cjs: require("cjs"), converted: require("converted"),`,
        `    esm: require("esm"), nullDefault: require("null-default"), workers: require("workers") };`,
        `}`,
      ].join("\n"),
      ID,
    );

    const exports = { named: "named" };
    const esm = { default: "default", named: "named" };
    const nullDefault = { default: null, named: "named" };
    const workers = { env: {} };
    const { read, loads } = await evaluate(result!.code, {
      // CommonJS through Node and builtins, and through plugin-rsc's transform.
      cjs: async () => ({ default: exports, named: "named" }),
      converted: async () => ({ default: exports, __cjs_module_runner_transform: true }),
      // ESM, an ESM default that is not module.exports, and a module without one.
      esm: async () => esm,
      "null-default": async () => nullDefault,
      workers: async () => workers,
    });

    expect(read()).toEqual({
      optional: "fallback",
      nested: "Cannot find module 'missing'",
      cjs: exports,
      converted: exports,
      esm,
      nullDefault,
      workers,
    });
    // Nested targets load first, then module-level ones in order when reached.
    expect(loads).toEqual([
      "missing",
      "cjs",
      "converted",
      "esm",
      "null-default",
      "workers",
      "missing",
      "cjs",
      "cjs",
    ]);
  });

  it.each([
    ["export class", `@dec\nexport class C { static x = require("x"); }`],
    ["export default class", `@dec\nexport default class { static x = require("x"); }`],
  ])("hoists nested calls above the decorators of an %s", async (_label, code) => {
    const { transform } = createDependencyTransform();
    const result = await transform(code, ID);

    expect(result?.code.split("\n").slice(0, 2)).toEqual([
      `const __vinext_require_0__ = await __vinext_require_load__(import("x"));@dec`,
      code.split("\n")[1]!.replace(`require("x")`, `__vinext_require_0__()`),
    ]);
  });

  it("picks helper names the module does not use", async () => {
    const { transform } = createDependencyTransform();
    const result = await transform(
      `const __vinext_require_0__ = 1;\nexport function read() { return require("x"); }`,
      ID,
    );

    expect(result?.code).toContain(
      `const __vinext_require_$0__ = await __vinext_require_$load__(import("x"));`,
    );
    expect(result?.code).toContain(`const __vinext_require_0__ = 1;`);
  });

  it.each([
    ["builds", { ...devServer, mode: "build" }, ID, `export const x = require("x");`],
    [
      "environments without a module runner",
      { ...devServer, config: { ...devServer.config, dev: { moduleRunnerTransform: false } } },
      ID,
      `export const x = require("x");`,
    ],
    [
      "optimized dependencies",
      devServer,
      `${CACHE_DIR}/deps/x.js`,
      `export const x = require("x");`,
    ],
    [
      "CommonJS files",
      devServer,
      "/app/node_modules/dependency/index.cjs",
      `export const x = require("x");`,
    ],
    // @vitejs/plugin-rsc converts dependencies without module syntax.
    [
      "CommonJS dependencies",
      devServer,
      "/app/node_modules/dependency/index.js",
      `// import x\nmodule.exports = require("x");`,
    ],
  ])("skips %s", async (_label, environment, id, code) => {
    const { transform, resolve } = createDependencyTransform(environment);

    expect(await transform(code, id)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["mjs", "mts", "ts", "jsx"])(
    "lowers .%s dependencies without module syntax",
    async (extension) => {
      const { transform } = createDependencyTransform();
      const result = await transform(
        `const x = require("x");`,
        `/app/node_modules/dependency/index.${extension}`,
      );

      expect(result?.code).toContain(`const x = __vinext_require__(await import("x"));`);
    },
  );

  it('lowers .js dependencies without module syntax in a "type": "module" package', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-type-module-"));
    try {
      const dependency = path.join(root, "node_modules", "dependency");
      await mkdir(dependency, { recursive: true });
      await writeFile(path.join(dependency, "package.json"), `{ "type": "module" }`);
      const { transform } = createDependencyTransform();
      const result = await transform(`const x = require("x");`, path.join(dependency, "index.js"));

      expect(result?.code).toContain(`const x = __vinext_require__(await import("x"));`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lowers ESM dependencies whose only module syntax is import.meta", async () => {
    const { transform } = createDependencyTransform();
    const result = await transform(`const url = import.meta.url;\nrequire("node:path");`, ID);

    expect(result?.code).toContain(`__vinext_require__(await import("node:path"));`);
  });
});
