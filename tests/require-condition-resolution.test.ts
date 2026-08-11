import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRequireConditionResolutionPlugin } from "../packages/vinext/src/plugins/require-condition-resolution.js";

// Ported from Next.js: test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts

type TestResolve = (
  specifier: string,
  importer: string,
  isRequire: boolean,
) => Promise<string | undefined>;

function createPlugin(resolve: TestResolve) {
  const createResolver = vi.fn(
    (_config: unknown, options?: { isRequire?: boolean }) =>
      (_environment: unknown, specifier: string, importer?: string) =>
        resolve(specifier, importer ?? "", options?.isRequire === true),
  );
  const plugin = createRequireConditionResolutionPlugin(createResolver as never);
  const configResolved = plugin.configResolved;
  if (typeof configResolved !== "function") throw new Error("missing configResolved hook");
  void configResolved.call({} as never, {} as never);
  return plugin;
}

function createTransform(resolve: TestResolve) {
  const hook = createPlugin(resolve).transform;
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
