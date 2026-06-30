import { describe, it, expect, afterEach, vi, beforeEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectNextIntlConfig,
  lightningCssFeatureNamesToMask,
  loadNextConfig,
  parseBodySizeLimit,
  reassignsModuleExports,
  referencesCjsGlobals,
  resolveNextConfig,
  type ResolvedNextConfig,
} from "../packages/vinext/src/config/next-config.js";
import {
  PHASE_PRODUCTION_BUILD,
  PHASE_DEVELOPMENT_SERVER,
} from "../packages/vinext/src/shims/constants.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-config-test-"));
}

describe("invalid config files", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should throw an error when loading a config fails", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), `{ "type": "module" }`);
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      // Syntactically invalid in any module system.
      `module.exports = { invalid: } ;\n`,
    );

    await expect(loadNextConfig(tmpDir, PHASE_PRODUCTION_BUILD)).rejects.toThrow();
  });
});

describe("deprecated config warnings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not warn when no config file exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig(null);

    expect(warn).not.toHaveBeenCalled();
  });

  it("matches Next.js warnings for explicitly configured deprecated options", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      skipMiddlewareUrlNormalize: true,
      experimental: {
        middlewarePrefetch: "strict",
        instrumentationHook: true,
        middlewareClientMaxBodySize: "5mb",
        externalMiddlewareRewritesResolve: true,
      },
    });

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "`experimental.middlewarePrefetch` is deprecated. Please use `experimental.proxyPrefetch` instead in next.config.js.",
      "`experimental.middlewareClientMaxBodySize` is deprecated. Please use `experimental.proxyClientMaxBodySize` instead in next.config.js.",
      "`experimental.externalMiddlewareRewritesResolve` is deprecated. Please use `experimental.externalProxyRewritesResolve` instead in next.config.js.",
      "`skipMiddlewareUrlNormalize` is deprecated. Please use `skipProxyUrlNormalize` instead in next.config.js.",
      "`experimental.instrumentationHook` is no longer needed, because `instrumentation.js` is available by default. You can remove it from next.config.js.",
    ]);
  });

  it("warns once across repeated config resolution", async () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, "next.config.mjs"), "export default {}\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await resolveNextConfig(
        {
          skipMiddlewareUrlNormalize: false,
          experimental: { instrumentationHook: false },
        },
        root,
      );
      await resolveNextConfig(
        {
          skipMiddlewareUrlNormalize: false,
          experimental: { instrumentationHook: false },
        },
        root,
      );

      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        "`skipMiddlewareUrlNormalize` is deprecated. Please use `skipProxyUrlNormalize` instead in next.config.mjs.",
        "`experimental.instrumentationHook` is no longer needed, because `instrumentation.js` is available by default. You can remove it from next.config.mjs.",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadNextConfig with CJS next.config.js under type:module", () => {
  // Real-world shape from the Next.js deploy suite: `vinext init` flips
  // package.json to `"type": "module"`, but the test fixture's
  // `next.config.js` is still written in CJS (module.exports + require).
  // vinext must load it as CJS instead of forcing the project to rewrite the
  // file to ESM.

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, "package.json"), `{ "type": "module" }`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads module.exports + require() from a .js file", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      `const path = require('node:path');\n` +
        // posix.join keeps the result "/docs" on Windows too — the point of
        // this fixture is exercising require(), not platform join behavior.
        `module.exports = { basePath: path.posix.join('/', 'docs') };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.basePath).toBe("/docs");
  });

  it("supports __dirname and __filename in a CJS .js config", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      `module.exports = { env: { DIRNAME_SET: String(typeof __dirname === 'string'), FILENAME_SET: String(typeof __filename === 'string') } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.DIRNAME_SET).toBe("true");
    expect(config?.env?.FILENAME_SET).toBe("true");
  });

  it("supports require(mod)(args) plugin-wrapper pattern", async () => {
    // Mirrors @next/bundle-analyzer / nextra plugin shape — the value
    // returned from require() is called with options and re-exported.
    fs.writeFileSync(
      path.join(tmpDir, "wrap.cjs"),
      `module.exports = (opts) => (config) => ({ ...config, env: { ...(config.env || {}), WRAPPED: opts.tag } });\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      `const withWrap = require('./wrap.cjs')({ tag: 'yes' });\n` +
        `module.exports = withWrap({ basePath: '/app' });\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.basePath).toBe("/app");
    expect(config?.env?.WRAPPED).toBe("yes");
  });

  it("loads nested CommonJS .js dependencies", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "config-helper.js"),
      `const values = require("./config-values.js");
module.exports = { basePath: values.basePath };
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "config-values.js"),
      `module.exports = { basePath: "/nested" };
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      `module.exports = require("./config-helper.js");
`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.basePath).toBe("/nested");
  });

  it("loads nested CommonJS .js dependencies from read-only symlink targets", async () => {
    const packageDir = path.join(tmpDir, "packages", "config-wrapper");
    const packageLink = path.join(tmpDir, "node_modules", "config-wrapper");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(path.dirname(packageLink), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "config-wrapper", main: "index.js", type: "module" }),
    );
    fs.writeFileSync(path.join(packageDir, "value.js"), `module.exports = "/linked";\n`);
    fs.writeFileSync(
      path.join(packageDir, "index.js"),
      `module.exports = { basePath: require("./value.js") };\n`,
    );
    fs.symlinkSync(packageDir, packageLink, "junction");
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      `module.exports = require("config-wrapper");\n`,
    );
    fs.chmodSync(packageDir, 0o555);

    try {
      const config = await loadNextConfig(tmpDir);
      expect(config?.basePath).toBe("/linked");
      expect(fs.readdirSync(packageDir).some((name) => name.startsWith(".vinext-"))).toBe(false);
    } finally {
      fs.chmodSync(packageDir, 0o755);
    }
  });

  it("does not write temporary modules beside the config", async () => {
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), `module.exports = { basePath: '/x' };\n`);
    fs.chmodSync(tmpDir, 0o555);

    try {
      const config = await loadNextConfig(tmpDir);
      expect(config?.basePath).toBe("/x");
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }

    const stray = fs
      .readdirSync(tmpDir)
      .filter((name) => name.startsWith(".vinext-") && name.endsWith(".cjs"));
    expect(stray).toEqual([]);
  });
});

describe("loadNextConfig phase argument", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes phase-production-build to function-form config when phase is specified", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default (phase) => ({ env: { RECEIVED_PHASE: phase } });\n`,
    );

    const config = await loadNextConfig(tmpDir, PHASE_PRODUCTION_BUILD);
    expect(config?.env?.RECEIVED_PHASE).toBe(PHASE_PRODUCTION_BUILD);
  });

  it("defaults to phase-development-server when no phase is provided", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default (phase) => ({ env: { RECEIVED_PHASE: phase } });\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.RECEIVED_PHASE).toBe(PHASE_DEVELOPMENT_SERVER);
  });

  it("ignores phase for object-form config", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default { env: { STATIC: "yes" } };\n`,
    );

    const config = await loadNextConfig(tmpDir, PHASE_PRODUCTION_BUILD);
    expect(config?.env?.STATIC).toBe("yes");
  });
});

describe("loadNextConfig with CJS globals in next.config.ts", () => {
  // Ported from Next.js: test/e2e/app-dir/next-config-ts/node-api-cjs/
  //   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-config-ts/node-api-cjs/next.config.ts
  // and test/e2e/app-dir/next-config-ts/import-js-extensions-cjs/.
  // Next.js's transpile-config.ts transforms next.config.ts to CommonJS via SWC
  // and evaluates it through Node's `Module._compile`, which exposes the CJS
  // globals (`__filename`, `__dirname`, `module`, `require`, `exports`) even
  // when the source uses ESM syntax. vinext mirrors that behaviour so that
  // upstream fixtures referencing these globals continue to load.
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exposes __dirname inside next.config.ts", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, "foo.txt"), "foo");
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import fs from "node:fs";\nimport path from "node:path";\nconst foo = fs.readFileSync(path.join(__dirname, "foo.txt"), "utf8");\nexport default { env: { FOO: foo } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.FOO).toBe("foo");
  });

  it("exposes __filename inside next.config.ts", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `export default { env: { NAME: __filename } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    const name = config?.env?.NAME;
    expect(typeof name).toBe("string");
    expect((name as string).endsWith("next.config.ts")).toBe(true);
  });

  it("exposes a working require() inside next.config.ts", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, "data.json"), `{"value":"json-data"}`);
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `const data = require("./data.json");\nexport default { env: { VAL: data.value } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.VAL).toBe("json-data");
  });

  it("exposes a CommonJS module/exports object inside next.config.ts", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `module.exports = { env: { VIA: "module.exports" } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.VIA).toBe("module.exports");
  });

  it("does not inject __dirname when user already declares it", async () => {
    // Regression test for https://github.com/cloudflare/vinext/issues/1345.
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { dirname } from "node:path";\n` +
        `import { fileURLToPath } from "node:url";\n` +
        `const __dirname = dirname(fileURLToPath(import.meta.url));\n` +
        `export default { env: { DIR: __dirname } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    const dir = config?.env?.DIR;
    expect(typeof dir).toBe("string");
    expect(fs.realpathSync(dir as string)).toBe(fs.realpathSync(tmpDir));
  });

  it("does not inject __filename when user already declares it", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { fileURLToPath } from "node:url";\n` +
        `const __filename = fileURLToPath(import.meta.url);\n` +
        `export default { env: { FILE: __filename } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    const file = config?.env?.FILE;
    expect(typeof file).toBe("string");
    expect(fs.realpathSync(file as string)).toBe(
      fs.realpathSync(path.join(tmpDir, "next.config.ts")),
    );
  });

  it("does not inject require when user already declares it", async () => {
    // The createRequire polyfill commonly appears alongside the __dirname one
    // and hits the same duplicate-`const` Rolldown crash if injected blindly.
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { createRequire } from "node:module";\n` +
        `const require = createRequire(import.meta.url);\n` +
        `export default { env: { HAS_REQUIRE: typeof require } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.HAS_REQUIRE).toBe("function");
  });

  it("loads a pure-ESM next.config.ts without injecting CJS shims", async () => {
    // No __filename / __dirname / require / module / exports references —
    // the injector transform should short-circuit. We only assert
    // functional behaviour: the export const that the transform would add
    // (__vinext_cjs_exports) is invisible to user code anyway, so the
    // observable contract is just "ESM config loads correctly".
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `export default { env: { PURE: "esm" } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.PURE).toBe("esm");
  });
});

describe("referencesCjsGlobals", () => {
  it("returns false for pure-ESM source", () => {
    expect(referencesCjsGlobals(`export default { env: { FOO: "bar" } };\n`)).toBe(false);
    expect(
      referencesCjsGlobals(
        `import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n`,
      ),
    ).toBe(false);
    expect(referencesCjsGlobals(`export { nextConfig as default };\n`)).toBe(false);
  });

  it("returns true when any CJS global is referenced", () => {
    expect(referencesCjsGlobals(`const x = __filename;`)).toBe(true);
    expect(referencesCjsGlobals(`const x = __dirname;`)).toBe(true);
    expect(referencesCjsGlobals(`const x = require("./foo");`)).toBe(true);
    expect(referencesCjsGlobals(`module.exports = { a: 1 };`)).toBe(true);
    expect(referencesCjsGlobals(`exports.foo = 1;`)).toBe(true);
  });

  it("does not match identifiers that merely contain a global as a substring", () => {
    expect(referencesCjsGlobals(`const requireSomething = 1;`)).toBe(false);
    expect(referencesCjsGlobals(`const myModule = 1;`)).toBe(false);
    expect(referencesCjsGlobals(`const exporter = 1;`)).toBe(false);
    // `export default` is a different word boundary from `exports`.
    expect(referencesCjsGlobals(`export default {};`)).toBe(false);
  });

  it("matches inside strings and comments (acceptable false positive)", () => {
    // Substring match is intentionally loose: a wasted transform is the
    // worst case, never a correctness bug.
    expect(referencesCjsGlobals(`// __dirname is shimmed`)).toBe(true);
    expect(referencesCjsGlobals(`const s = "module.exports = 1";`)).toBe(true);
  });
});

describe("reassignsModuleExports", () => {
  it("returns true for direct module.exports reassignment", () => {
    expect(reassignsModuleExports(`module.exports = { foo: 1 };`)).toBe(true);
    expect(reassignsModuleExports(`module . exports = X;`)).toBe(true);
  });

  it("returns true for property mutation", () => {
    expect(reassignsModuleExports(`module.exports.foo = 1;`)).toBe(true);
    expect(reassignsModuleExports(`module.exports["foo"] = 1;`)).toBe(true);
    expect(reassignsModuleExports(`module.exports[name] = 1;`)).toBe(true);
  });

  it("returns false for pure-ESM source", () => {
    expect(reassignsModuleExports(`export default { foo: 1 };`)).toBe(false);
    expect(reassignsModuleExports(`const x = module;`)).toBe(false);
    expect(reassignsModuleExports(`import x from "node:module";`)).toBe(false);
  });

  it("does not match comparisons or reads", () => {
    expect(reassignsModuleExports(`if (module.exports === foo) {}`)).toBe(false);
    expect(reassignsModuleExports(`const x = module.exports;`)).toBe(false);
    expect(reassignsModuleExports(`const x = module.exports.foo;`)).toBe(false);
  });
});

describe("loadNextConfig CJS vs ESM unwrap", () => {
  // Exercises the static reassignsModuleExports detection end-to-end:
  // pure-ESM configs go through the ESM `default` path, configs that
  // reassign module.exports get unwrapped from the injected wrapper.
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns ESM default for a pure-ESM config", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `export default { env: { SHAPE: "esm-default" } };\n`,
    );
    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.SHAPE).toBe("esm-default");
  });

  it("returns module.exports = X for a config that reassigns module.exports", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `module.exports = { env: { SHAPE: "reassigned" } };\n`,
    );
    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.SHAPE).toBe("reassigned");
  });

  it("accumulates module.exports.foo = ... assignments", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `module.exports.env = { SHAPE: "mutated" };\nmodule.exports.basePath = "/m";\n`,
    );
    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.SHAPE).toBe("mutated");
    expect(config?.basePath).toBe("/m");
  });

  it("falls back to ESM default when module.exports reference is only a false positive", async () => {
    // Ports the heuristic-false-positive case: the substring matcher
    // could see `module.exports = ` inside a string and decide to emit
    // the wrapper. The unwrap path checks identity against the initial
    // empty exports object and falls back to the ESM default.
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `const doc = "module.exports = legacy";\nexport default { env: { SHAPE: "fallback", DOC: doc } };\n`,
    );
    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.SHAPE).toBe("fallback");
    expect(config?.env?.DOC).toBe("module.exports = legacy");
  });
});

describe("loadNextConfig with tsconfig path aliases", () => {
  // Ported from Next.js: test/e2e/app-dir/next-config-ts/import-alias-paths-only/
  //   https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-config-ts/import-alias-paths-only/
  // and import-alias-paths-with-baseurl/.
  // Next.js's transpile-config.ts reads compilerOptions.paths/baseUrl from
  // tsconfig.json and passes them to SWC so that next.config.ts can import via
  // tsconfig aliases and baseUrl bare specifiers. vinext mirrors this with
  // Vite resolver settings when calling runnerImport.

  let tmpDir: string;

  function writePackage(
    name: string,
    packageJson: Record<string, string>,
    files: Record<string, string>,
  ): void {
    const packageDir = path.join(tmpDir, "node_modules", name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...packageJson }),
    );
    for (const [filename, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(packageDir, filename), source);
    }
  }

  function writeBarePackage(name: string, source: string): void {
    writePackage(
      name,
      { type: "module", exports: "./index.js" },
      {
        "index.js": source,
      },
    );
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves '@/*' imports in next.config.ts from tsconfig paths (no baseUrl)", async () => {
    tmpDir = makeTempDir();

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"), `export const foo = "foo";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { foo } from "@/foo";\nexport default { env: { FOO: foo } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.FOO).toBe("foo");
  });

  it("resolves '@/*' imports when baseUrl is set", async () => {
    tmpDir = makeTempDir();

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "bar.ts"), `export const bar = "bar";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { bar } from "@/bar";\nexport default { env: { BAR: bar } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.BAR).toBe("bar");
  });

  it("follows tsconfig 'extends' when resolving paths", async () => {
    tmpDir = makeTempDir();

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "baz.ts"), `export const baz = "baz";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { baz } from "@/baz";\nexport default { env: { BAZ: baz } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.BAZ).toBe("baz");
  });

  it("follows extended tsconfig baseUrl when resolving bare imports", async () => {
    // Ported from Next.js: test/e2e/app-dir/next-config-ts/tsconfig-extends/
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-config-ts/tsconfig-extends/next-config-ts-tsconfig-extends-cjs.test.ts
    tmpDir = makeTempDir();

    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"), `export const foo = "foo";\n`);
    fs.writeFileSync(path.join(tmpDir, "bar.ts"), `export const bar = "bar";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        type: "module",
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["./src/*"],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { foo } from "@/foo";\n` +
        `import { bar } from "bar";\n` +
        `export default { env: { VALUE: foo + bar } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.VALUE).toBe("foobar");
  });

  it("prefers an installed package over a baseUrl-local file of the same name", async () => {
    // When a bare import matches both an installed package and a baseUrl-local
    // file, the installed package wins. vinext keeps installed packages
    // externalized so that CJS config plugins (e.g. @next/mdx) that call
    // `require`/`require.resolve` at runtime keep working; the trade-off is
    // that a baseUrl-local file does not shadow a package of the same name.
    // (Pure TypeScript baseUrl semantics would prefer the local file, but that
    // requires de-externalizing every package, which breaks CJS plugins.)
    tmpDir = makeTempDir();

    fs.writeFileSync(path.join(tmpDir, "bar.ts"), `export const bar = "local";\n`);
    writeBarePackage("bar", `export const bar = "package";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { bar } from "bar";\nexport default { env: { BAR: bar } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.BAR).toBe("package");
  });

  it("loads a CJS config plugin that calls require.resolve at runtime", async () => {
    // Regression for @next/mdx-style plugins: next.config.ts imports a CJS
    // package whose factory calls `require.resolve(...)` when invoked. Keeping
    // installed packages externalized (rather than forcing them through the
    // module runner) ensures `require` is defined. Reproduces the
    // app-router-playground deploy failure: "require is not defined".
    tmpDir = makeTempDir();

    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
    writePackage(
      "fake-mdx",
      { type: "commonjs", main: "index.js" },
      {
        "index.js":
          `module.exports = (opts = {}) => (config = {}) => ({\n` +
          `  ...config,\n` +
          `  loaderPath: require.resolve("./loader.js"),\n` +
          `});\n`,
        "loader.js": `module.exports = "loader";\n`,
      },
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "." } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import withMDX from "fake-mdx";\n` + `export default withMDX({})({ env: { OK: "yes" } });\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.OK).toBe("yes");
  });

  it("falls through to packages when baseUrl has no local match", async () => {
    tmpDir = makeTempDir();

    writeBarePackage("bar", `export const bar = "package";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { bar } from "bar";\nexport default { env: { BAR: bar } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.BAR).toBe("package");
  });

  it("does not apply tsconfig baseUrl package shadowing to next.config.mjs", async () => {
    tmpDir = makeTempDir();

    fs.writeFileSync(path.join(tmpDir, "bar.ts"), `export const bar = "local";\n`);
    writeBarePackage("bar", `export const bar = "package";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `import { bar } from "bar";\nexport default { env: { BAR: bar } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.BAR).toBe("package");
  });

  it("does not apply the app baseUrl to package dependency imports", async () => {
    tmpDir = makeTempDir();

    fs.writeFileSync(path.join(tmpDir, "shared.ts"), `export const shared = "app";\n`);
    writeBarePackage(
      "fake-plugin",
      `import { shared } from "shared";\nexport const pluginValue = shared;\n`,
    );
    writeBarePackage("shared", `export const shared = "package";\n`);
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import { pluginValue } from "fake-plugin";\n` +
        `export default { env: { VALUE: pluginValue } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.VALUE).toBe("package");
  });

  it("imports ESM and CommonJS packages from next.config.ts", async () => {
    // Ported from Next.js: test/e2e/app-dir/next-config-ts/import-from-node-modules/
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-config-ts/import-from-node-modules/next.config.ts
    tmpDir = makeTempDir();

    writePackage(
      "cjs",
      { type: "commonjs", main: "index.cjs" },
      {
        "index.cjs": `module.exports = "cjs";\n`,
      },
    );
    writePackage(
      "mjs",
      { type: "commonjs", main: "index.mjs" },
      {
        "index.mjs": `export default "mjs";\n`,
      },
    );
    writePackage(
      "js-cjs",
      { type: "commonjs", main: "index.js" },
      {
        "index.js": `module.exports = "jsCJS";\n`,
      },
    );
    writePackage(
      "js-esm",
      { type: "module", main: "index.js" },
      {
        "index.js": `export default "jsESM";\n`,
      },
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `import cjs from "cjs";\n` +
        `import mjs from "mjs";\n` +
        `import jsCJS from "js-cjs";\n` +
        `import jsESM from "js-esm";\n` +
        `export default { env: { cjs, mjs, jsCJS, jsESM } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env).toMatchObject({
      cjs: "cjs",
      mjs: "mjs",
      jsCJS: "jsCJS",
      jsESM: "jsESM",
    });
  });

  it("loads config without tsconfig.json (no aliases needed)", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.ts"),
      `export default { env: { PLAIN: "yes" } };\n`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config?.env?.PLAIN).toBe("yes");
  });
});

describe("resolveNextConfig image patterns", () => {
  it("normalizes URL remote patterns for runtime serialization", async () => {
    const config = await resolveNextConfig(
      {
        images: {
          remotePatterns: [new URL("https://image-optimization-test.vercel.app/**")],
        },
      },
      "/tmp/project",
    );

    expect(config.images?.remotePatterns).toEqual([
      {
        protocol: "https",
        hostname: "image-optimization-test.vercel.app",
        port: "",
        pathname: "/**",
        search: "",
      },
    ]);
    expect(JSON.parse(JSON.stringify(config.images?.remotePatterns))).toEqual(
      config.images?.remotePatterns,
    );
  });
});

describe("resolveNextConfig alias extraction", () => {
  it("prefers turbopack resolveExtensions and falls back to webpack extensions", async () => {
    const fallback = await resolveNextConfig({
      webpack(webpackConfig: any) {
        webpackConfig.resolve.extensions = ["", ".png", ".jsx", ".js"];
        return webpackConfig;
      },
    });
    expect(fallback.resolveExtensions).toEqual(["", ".png", ".jsx", ".js"]);
    expect(fallback.serverResolveExtensions).toEqual(["", ".png", ".jsx", ".js"]);

    const preferred = await resolveNextConfig({
      turbopack: { resolveExtensions: ["", ".web.tsx", ".tsx"] },
      webpack(webpackConfig: any) {
        webpackConfig.resolve.extensions = ["", ".png", ".js"];
        return webpackConfig;
      },
    });
    expect(preferred.resolveExtensions).toEqual(["", ".web.tsx", ".tsx"]);
    expect(preferred.serverResolveExtensions).toEqual(["", ".web.tsx", ".tsx"]);

    const explicitlyEmpty = await resolveNextConfig({
      turbopack: { resolveExtensions: [] },
      webpack(webpackConfig: any) {
        webpackConfig.resolve.extensions = [".png"];
        return webpackConfig;
      },
    });
    expect(explicitlyEmpty.resolveExtensions).toEqual([]);
    expect(explicitlyEmpty.serverResolveExtensions).toEqual([]);
  });

  it("supports legacy experimental.turbo resolveExtensions", async () => {
    const legacy = await resolveNextConfig({
      experimental: {
        turbo: { resolveExtensions: ["", ".legacy.ts", ".ts"] },
      },
    });
    expect(legacy.resolveExtensions).toEqual(["", ".legacy.ts", ".ts"]);
    expect(legacy.serverResolveExtensions).toEqual(["", ".legacy.ts", ".ts"]);

    const preferred = await resolveNextConfig({
      experimental: {
        turbo: { resolveExtensions: ["", ".legacy.ts", ".ts"] },
      },
      turbopack: { resolveExtensions: ["", ".modern.ts", ".ts"] },
    });
    expect(preferred.resolveExtensions).toEqual(["", ".modern.ts", ".ts"]);
    expect(preferred.serverResolveExtensions).toEqual(["", ".modern.ts", ".ts"]);
  });

  it("provides Next.js webpack defaults to resolve.extensions callbacks", async () => {
    const resolved = await resolveNextConfig({
      webpack(webpackConfig: any) {
        webpackConfig.resolve.extensions = [".web.tsx", ...webpackConfig.resolve.extensions];
        return webpackConfig;
      },
    });
    expect(resolved.resolveExtensions).toEqual([
      ".web.tsx",
      ".js",
      ".mjs",
      ".tsx",
      ".ts",
      ".jsx",
      ".json",
      ".wasm",
    ]);
  });

  it("ignores untouched webpack resolve.extensions defaults", async () => {
    const untouched = await resolveNextConfig({
      webpack(webpackConfig: any) {
        return webpackConfig;
      },
    });
    expect(untouched.resolveExtensions).toBeNull();

    const copied = await resolveNextConfig({
      webpack(webpackConfig: any) {
        webpackConfig.resolve.extensions = [...webpackConfig.resolve.extensions];
        return webpackConfig;
      },
    });
    expect(copied.resolveExtensions).toBeNull();
  });

  it("captures in-place webpack resolve.extensions mutations", async () => {
    const resolved = await resolveNextConfig({
      webpack(webpackConfig: any) {
        webpackConfig.resolve.extensions.unshift(".web.tsx");
        return webpackConfig;
      },
    });
    expect(resolved.resolveExtensions).toEqual([
      ".web.tsx",
      ".js",
      ".mjs",
      ".tsx",
      ".ts",
      ".jsx",
      ".json",
      ".wasm",
    ]);
  });

  it("preserves client/server and dev/build webpack resolve.extensions", async () => {
    const webpack = (webpackConfig: any, options: any) => {
      webpackConfig.resolve.extensions = [
        options.isServer ? ".server.ts" : ".client.ts",
        options.dev ? ".dev.ts" : ".prod.ts",
        ".ts",
      ];
      return webpackConfig;
    };

    const build = await resolveNextConfig({ webpack });
    expect(build.resolveExtensions).toEqual([".client.ts", ".prod.ts", ".ts"]);
    expect(build.serverResolveExtensions).toEqual([".server.ts", ".prod.ts", ".ts"]);

    const dev = await resolveNextConfig({ webpack }, process.cwd(), { dev: true });
    expect(dev.resolveExtensions).toEqual([".client.ts", ".dev.ts", ".ts"]);
    expect(dev.serverResolveExtensions).toEqual([".server.ts", ".dev.ts", ".ts"]);
  });

  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("captures webpack resolve.alias from wrapped config plugins", async () => {
    tmpDir = makeTempDir();

    fs.mkdirSync(path.join(tmpDir, "node_modules", "fake-plugin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "fake-plugin", "index.js"),
      `module.exports = function fakePlugin() {
        return function withPlugin(nextConfig = {}) {
          return Object.assign({}, nextConfig, {
            webpack(config) {
              config.resolve = config.resolve || {};
              config.resolve.alias = config.resolve.alias || {};
              config.resolve.alias["wrapped/config"] = "./config/request.ts";
              return typeof nextConfig.webpack === "function"
                ? nextConfig.webpack(config)
                : config;
            }
          });
        };
      };`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "fake-plugin", "package.json"),
      JSON.stringify({ name: "fake-plugin", version: "1.0.0", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      `const withPlugin = require("fake-plugin")();
module.exports = withPlugin({ basePath: "/wrapped" });`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.basePath).toBe("/wrapped");
    expect(config.aliases["wrapped/config"]).toBe(path.join(tmpDir, "config", "request.ts"));
  });

  it("captures turbopack aliases from wrapped config plugins", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default {
        experimental: {
          turbo: {
            resolveAlias: {
              "wrapped/config": "./turbo/request.ts"
            }
          }
        }
      };`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.aliases["wrapped/config"]).toBe(path.join(tmpDir, "turbo", "request.ts"));
  });

  it("captures top-level turbopack aliases", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default {
        turbopack: {
          resolveAlias: {
            "wrapped/config": "./turbopack/request.ts"
          }
        }
      };`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.aliases["wrapped/config"]).toBe(path.join(tmpDir, "turbopack", "request.ts"));
  });

  // Regression test for #1507. Turbopack `resolveAlias` (and webpack
  // `resolve.alias`) values can be bare package specifiers — e.g. the upstream
  // esm-externals fixture aliases `preact/compat` -> `react`. Resolving those
  // against the project root mangled them into bogus `<root>/react` paths,
  // which broke the production build with "No such file or directory". Bare
  // specifiers must be left verbatim so Vite re-resolves them via node_modules.
  it("leaves bare package specifier turbopack aliases verbatim", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default {
        turbopack: {
          resolveAlias: {
            "preact/compat": "react",
            "@scope/pkg": "@scope/replacement",
            "subpath": "react/jsx-runtime"
          }
        }
      };`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    // Bare specifiers stay as-is — NOT resolved against tmpDir.
    expect(config.aliases["preact/compat"]).toBe("react");
    expect(config.aliases["@scope/pkg"]).toBe("@scope/replacement");
    expect(config.aliases["subpath"]).toBe("react/jsx-runtime");
  });

  it("still resolves relative-path turbopack aliases against the project root", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default {
        turbopack: {
          resolveAlias: {
            "current": ".",
            "parent": "..",
            "explicit": "./turbo/request.ts",
            "up": "../shared/request.ts"
          }
        }
      };`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.aliases["current"]).toBe(path.resolve(tmpDir, "."));
    expect(config.aliases["parent"]).toBe(path.resolve(tmpDir, ".."));
    expect(config.aliases["explicit"]).toBe(path.join(tmpDir, "turbo", "request.ts"));
    expect(config.aliases["up"]).toBe(path.resolve(tmpDir, "..", "shared", "request.ts"));
  });

  it("leaves absolute-path turbopack aliases verbatim", async () => {
    tmpDir = makeTempDir();
    const absoluteTarget = path.join(tmpDir, "abs", "request.ts");
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default {
        turbopack: {
          resolveAlias: {
            "absolute": ${JSON.stringify(absoluteTarget)}
          }
        }
      };`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.aliases["absolute"]).toBe(absoluteTarget);
  });

  it("leaves bare package specifier webpack aliases verbatim", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.js"),
      `module.exports = {
        webpack(config) {
          config.resolve = config.resolve || {};
          config.resolve.alias = config.resolve.alias || {};
          config.resolve.alias["preact/compat"] = "react";
          return config;
        }
      };`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.aliases["preact/compat"]).toBe("react");
  });

  it("does not attribute turbopack aliases to webpack support warnings", async () => {
    tmpDir = makeTempDir();

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rawConfig = {
      turbopack: {
        resolveAlias: {
          "wrapped/config": "./turbopack/request.ts",
        },
      },
      webpack: (webpackConfig: any) => webpackConfig,
    };

    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.aliases["wrapped/config"]).toBe(path.join(tmpDir, "turbopack", "request.ts"));
    expect(consoleWarn).toHaveBeenCalledWith(
      '[vinext] next.config option "webpack" is not yet supported and will be ignored',
    );
  });

  it("keeps unrelated config resolution unchanged when no aliases exist", async () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default {
        basePath: "/docs",
        env: { FEATURE_FLAG: "on" }
      };`,
    );

    const rawConfig = await loadNextConfig(tmpDir);
    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(config.basePath).toBe("/docs");
    expect(config.env.FEATURE_FLAG).toBe("on");
    expect(config.aliases).toEqual({});
  });

  it("invokes webpack loader callbacks so build-time process.env mutations land in the Node process", async () => {
    // Regression test for #1500.
    // Some Next.js webpack loaders mutate `process.env.X = ...` at build
    // time, expecting the value to be visible to other modules during the
    // same build. vinext doesn't run the webpack loader pipeline, so the
    // env mutation never happens. We compensate by invoking each loader's
    // callback once during config probing with a dummy source.
    tmpDir = makeTempDir();

    const loaderPath = path.join(tmpDir, "vinext-1500-loader.cjs");
    fs.writeFileSync(
      loaderPath,
      `module.exports = function (source) {\n` +
        `  process.env.VINEXT_ISSUE_1500_LOADER_RAN = "yes";\n` +
        `  return source;\n` +
        `};\n`,
    );

    const previous = process.env.VINEXT_ISSUE_1500_LOADER_RAN;
    delete process.env.VINEXT_ISSUE_1500_LOADER_RAN;
    try {
      const rawConfig = {
        webpack: (webpackConfig: any) => {
          webpackConfig.module = webpackConfig.module || { rules: [] };
          webpackConfig.module.rules.push({
            test: /\.svg$/,
            use: [loaderPath],
          });
          return webpackConfig;
        },
      };

      await resolveNextConfig(rawConfig, tmpDir);

      expect(process.env.VINEXT_ISSUE_1500_LOADER_RAN).toBe("yes");
    } finally {
      if (previous === undefined) delete process.env.VINEXT_ISSUE_1500_LOADER_RAN;
      else process.env.VINEXT_ISSUE_1500_LOADER_RAN = previous;
    }
  });

  it("extracts aliases and mdx while probing client and server webpack configs", async () => {
    tmpDir = makeTempDir();

    const invocations: boolean[] = [];
    const fakeRemarkPlugin = () => {};
    const rawConfig = {
      webpack: async (webpackConfig: any, options: any) => {
        invocations.push(options.isServer);
        webpackConfig.resolve = webpackConfig.resolve || {};
        webpackConfig.resolve.alias = webpackConfig.resolve.alias || {};
        webpackConfig.resolve.alias["wrapped/config"] = "./config/request.ts";
        webpackConfig.module = webpackConfig.module || { rules: [] };
        webpackConfig.module.rules.push({
          test: /\.mdx$/,
          use: [
            {
              loader: "@next/mdx/mdx-js-loader",
              options: {
                remarkPlugins: [fakeRemarkPlugin],
              },
            },
          ],
        });
        return webpackConfig;
      },
    };

    const config = await resolveNextConfig(rawConfig, tmpDir);

    expect(invocations).toEqual([false, true]);
    expect(config.aliases["wrapped/config"]).toBe(path.join(tmpDir, "config", "request.ts"));
    expect(config.mdx?.remarkPlugins).toEqual([fakeRemarkPlugin]);
  });
});

describe("parseBodySizeLimit", () => {
  it("parses megabyte strings", () => {
    expect(parseBodySizeLimit("10mb")).toBe(10 * 1024 * 1024);
    expect(parseBodySizeLimit("1mb")).toBe(1 * 1024 * 1024);
  });

  it("parses kilobyte strings", () => {
    expect(parseBodySizeLimit("500kb")).toBe(500 * 1024);
  });

  it("parses gigabyte strings", () => {
    expect(parseBodySizeLimit("1gb")).toBe(1 * 1024 * 1024 * 1024);
  });

  it("parses byte strings", () => {
    expect(parseBodySizeLimit("2048b")).toBe(2048);
  });

  it("passes through numeric values directly", () => {
    expect(parseBodySizeLimit(2097152)).toBe(2097152);
  });

  it("is case-insensitive", () => {
    expect(parseBodySizeLimit("10MB")).toBe(10 * 1024 * 1024);
    expect(parseBodySizeLimit("500KB")).toBe(500 * 1024);
  });

  it("handles fractional values", () => {
    expect(parseBodySizeLimit("1.5mb")).toBe(Math.floor(1.5 * 1024 * 1024));
  });

  it("returns default 1MB for undefined", () => {
    expect(parseBodySizeLimit(undefined)).toBe(1 * 1024 * 1024);
  });

  it("returns default 1MB for null", () => {
    expect(parseBodySizeLimit(null)).toBe(1 * 1024 * 1024);
  });

  it("returns default 1MB and warns for invalid strings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // In Vitest 4, spyOn on an already-intercepted console returns the same mock,
    // which may have accumulated calls from earlier tests. Clear before asserting.
    warn.mockClear();
    expect(parseBodySizeLimit("invalid")).toBe(1 * 1024 * 1024);
    expect(parseBodySizeLimit("10mbb")).toBe(1 * 1024 * 1024);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("Invalid bodySizeLimit");
    warn.mockRestore();
    // empty string also falls through to the regex (no match), so it warns too
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn2.mockClear();
    expect(parseBodySizeLimit("")).toBe(1 * 1024 * 1024);
    expect(warn2).toHaveBeenCalledTimes(1);
    warn2.mockRestore();
  });

  it("parses terabyte strings", () => {
    expect(parseBodySizeLimit("10tb")).toBe(10 * 1024 * 1024 * 1024 * 1024);
  });

  it("parses petabyte strings", () => {
    expect(parseBodySizeLimit("1pb")).toBe(1 * 1024 * 1024 * 1024 * 1024 * 1024);
  });

  it("accepts bare number strings as bytes", () => {
    expect(parseBodySizeLimit("1048576")).toBe(1048576);
    expect(parseBodySizeLimit("2097152")).toBe(2097152);
  });

  it("throws for zero or negative numeric values", () => {
    expect(() => parseBodySizeLimit(0)).toThrow();
    expect(() => parseBodySizeLimit(-1)).toThrow();
  });
});

describe("resolveNextConfig serverExternalPackages", () => {
  it("defaults to empty array when no config is provided", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.serverExternalPackages).toEqual([]);
  });

  it("defaults to empty array when not configured", async () => {
    const resolved = await resolveNextConfig({ env: {} });
    expect(resolved.serverExternalPackages).toEqual([]);
  });

  it("reads top-level serverExternalPackages", async () => {
    const resolved = await resolveNextConfig({
      serverExternalPackages: ["payload", "graphql"],
    });
    expect(resolved.serverExternalPackages).toEqual(["payload", "graphql"]);
  });

  it("falls back to experimental.serverComponentsExternalPackages (legacy name)", async () => {
    const resolved = await resolveNextConfig({
      experimental: {
        serverComponentsExternalPackages: ["jose", "pg-cloudflare"],
      },
    });
    expect(resolved.serverExternalPackages).toEqual(["jose", "pg-cloudflare"]);
  });

  it("prefers top-level serverExternalPackages over legacy experimental key", async () => {
    const resolved = await resolveNextConfig({
      serverExternalPackages: ["payload"],
      experimental: {
        serverComponentsExternalPackages: ["jose"],
      },
    });
    expect(resolved.serverExternalPackages).toEqual(["payload"]);
  });

  it("preserves transpilePackages for default external precedence", async () => {
    const resolved = await resolveNextConfig({
      transpilePackages: ["typescript", "shiki"],
    });

    expect(resolved.transpilePackages).toEqual(["typescript", "shiki"]);
  });
});

describe("resolveNextConfig transpilePackages", () => {
  it("keeps Next.js defaults separate from configured transpile packages", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.transpilePackages).toEqual([]);
    expect(resolved.turbopackTranspilePackages).toEqual(["geist"]);
  });

  it("includes configured packages before Turbopack defaults", async () => {
    const resolved = await resolveNextConfig({
      transpilePackages: ["custom-package", "@scope/pkg"],
    });
    expect(resolved.transpilePackages).toEqual(["custom-package", "@scope/pkg"]);
    expect(resolved.turbopackTranspilePackages).toEqual(["custom-package", "@scope/pkg", "geist"]);
  });

  it("preserves Next.js duplicate package semantics", async () => {
    const resolved = await resolveNextConfig({
      transpilePackages: ["geist", "custom-package", "custom-package"],
    });
    expect(resolved.transpilePackages).toEqual(["geist", "custom-package", "custom-package"]);
    expect(resolved.turbopackTranspilePackages).toEqual([
      "geist",
      "custom-package",
      "custom-package",
      "geist",
    ]);
  });

  it("does not treat optimized packages as Turbopack-transpiled packages", async () => {
    const resolved = await resolveNextConfig({
      transpilePackages: ["custom-package"],
      experimental: {
        optimizePackageImports: ["optimized-package", "geist", "custom-package"],
      },
    });

    expect(resolved.optimizePackageImports).toEqual([
      "optimized-package",
      "geist",
      "custom-package",
    ]);
    expect(resolved.transpilePackages).toEqual(["custom-package"]);
    expect(resolved.turbopackTranspilePackages).toEqual(["custom-package", "geist"]);
  });
});

describe("resolveNextConfig serverActionsBodySizeLimit", () => {
  it("defaults to 1MB when no config is provided", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.serverActionsBodySizeLimit).toBe(1 * 1024 * 1024);
  });

  it("defaults to 1MB when serverActions is not configured", async () => {
    const resolved = await resolveNextConfig({ env: {} });
    expect(resolved.serverActionsBodySizeLimit).toBe(1 * 1024 * 1024);
  });

  it("parses bodySizeLimit from experimental.serverActions", async () => {
    const resolved = await resolveNextConfig({
      experimental: {
        serverActions: {
          bodySizeLimit: "10mb",
        },
      },
    });
    expect(resolved.serverActionsBodySizeLimit).toBe(10 * 1024 * 1024);
  });

  it("accepts numeric bodySizeLimit", async () => {
    const resolved = await resolveNextConfig({
      experimental: {
        serverActions: {
          bodySizeLimit: 5242880,
        },
      },
    });
    expect(resolved.serverActionsBodySizeLimit).toBe(5242880);
  });

  // The verbatim config string drives the "Body exceeded {limit} limit" error
  // message (matching Next.js), so it must be preserved alongside the parsed
  // byte count rather than reconstructed from it.
  it("preserves the verbatim bodySizeLimit label, defaulting to Next.js' 1 MB literal", async () => {
    const defaulted = await resolveNextConfig(null);
    expect(defaulted.serverActionsBodySizeLimitLabel).toBe("1 MB");

    const stringLabel = await resolveNextConfig({
      experimental: { serverActions: { bodySizeLimit: "2mb" } },
    });
    expect(stringLabel.serverActionsBodySizeLimitLabel).toBe("2mb");

    const numericLabel = await resolveNextConfig({
      experimental: { serverActions: { bodySizeLimit: 5242880 } },
    });
    expect(numericLabel.serverActionsBodySizeLimitLabel).toBe("5242880");
  });
});

describe("resolveNextConfig disableOptimizedLoading", () => {
  // Regression for #1519: `experimental.disableOptimizedLoading` defaults to
  // `false` and is read into the resolved config. The default drives the
  // `defer`-in-head behaviour for Pages Router scripts in production.
  it("defaults disableOptimizedLoading to false", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.disableOptimizedLoading).toBe(false);
  });

  it("reads experimental.disableOptimizedLoading from next.config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { disableOptimizedLoading: true },
    });
    expect(resolved.disableOptimizedLoading).toBe(true);
  });
});

describe("resolveNextConfig scrollRestoration", () => {
  it("defaults scrollRestoration to false", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.scrollRestoration).toBe(false);
  });

  it("reads experimental.scrollRestoration from next.config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { scrollRestoration: true },
    });
    expect(resolved.scrollRestoration).toBe(true);
  });
});

describe("resolveNextConfig prefetchInlining", () => {
  it("reads experimental.prefetchInlining from next.config", async () => {
    const disabled = await resolveNextConfig({});
    expect(disabled.prefetchInlining).toBe(false);

    const enabledByBoolean = await resolveNextConfig({
      experimental: { prefetchInlining: true },
    });
    expect(enabledByBoolean.prefetchInlining).toBe(true);

    const enabledByThresholds = await resolveNextConfig({
      experimental: { prefetchInlining: { maxSize: Infinity, maxBundleSize: Infinity } },
    });
    expect(enabledByThresholds.prefetchInlining).toBe(true);
  });
});

describe("resolveNextConfig gestureTransition", () => {
  it("defaults experimental.gestureTransition to false", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.gestureTransition).toBe(false);
  });

  it("reads experimental.gestureTransition from next.config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { gestureTransition: true },
    });
    expect(resolved.gestureTransition).toBe(true);
  });
});

describe("resolveNextConfig appNavFailHandling", () => {
  it("defaults experimental.appNavFailHandling to false", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.appNavFailHandling).toBe(false);
  });

  it("reads experimental.appNavFailHandling from next.config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { appNavFailHandling: true },
    });
    expect(resolved.appNavFailHandling).toBe(true);
  });
});

describe("resolveNextConfig globalNotFound", () => {
  it("defaults experimental.globalNotFound to false", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.globalNotFound).toBe(false);
  });

  it("reads experimental.globalNotFound from next.config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { globalNotFound: true },
    });
    expect(resolved.globalNotFound).toBe(true);
  });
});

describe("resolveNextConfig hashSalt", () => {
  const OLD_ENV = process.env.NEXT_HASH_SALT;

  afterEach(() => {
    if (OLD_ENV !== undefined) {
      process.env.NEXT_HASH_SALT = OLD_ENV;
    } else {
      delete process.env.NEXT_HASH_SALT;
    }
  });

  it("defaults to empty string when no config or env is set", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.hashSalt).toBe("");
  });

  it("defaults to empty string when config has no experimental", async () => {
    const resolved = await resolveNextConfig({ env: {} });
    expect(resolved.hashSalt).toBe("");
  });

  it("reads outputHashSalt from experimental config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { outputHashSalt: "v1" },
    });
    expect(resolved.hashSalt).toBe("v1");
  });

  it("reads NEXT_HASH_SALT from env var", async () => {
    process.env.NEXT_HASH_SALT = "envsalt";
    const resolved = await resolveNextConfig(null);
    expect(resolved.hashSalt).toBe("envsalt");
  });

  it("concatenates config salt and env salt (config first)", async () => {
    process.env.NEXT_HASH_SALT = "envsalt";
    const resolved = await resolveNextConfig({
      experimental: { outputHashSalt: "configsalt" },
    });
    expect(resolved.hashSalt).toBe("configsaltenvsalt");
  });

  it("handles only env var without config salt", async () => {
    process.env.NEXT_HASH_SALT = "onlyenv";
    const resolved = await resolveNextConfig({ env: {} });
    expect(resolved.hashSalt).toBe("onlyenv");
  });
});

describe("resolveNextConfig instrumentationClientInject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, "package.json"), `{ "type": "module" }\n`);
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads instrumentationClientInject from next.config.mjs", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "next.config.mjs"),
      `export default { instrumentationClientInject: ["./inject-a.js", "./inject-b.js"] };\n`,
    );
    const raw = await loadNextConfig(tmpDir);
    const resolved = await resolveNextConfig(raw, tmpDir);
    expect(resolved.instrumentationClientInject).toEqual(["./inject-a.js", "./inject-b.js"]);
  });
});

describe("resolveNextConfig clientTraceMetadata", () => {
  it("defaults to undefined when no config is provided", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.clientTraceMetadata).toBeUndefined();
  });

  it("defaults to undefined when experimental is not set", async () => {
    const resolved = await resolveNextConfig({ env: {} });
    expect(resolved.clientTraceMetadata).toBeUndefined();
  });

  it("defaults to undefined when experimental.clientTraceMetadata is omitted", async () => {
    const resolved = await resolveNextConfig({ experimental: {} });
    expect(resolved.clientTraceMetadata).toBeUndefined();
  });

  it("resolves a string array from experimental.clientTraceMetadata", async () => {
    const resolved = await resolveNextConfig({
      experimental: {
        clientTraceMetadata: ["my-test-key-1", "my-test-key-2", "my-parent-span-id"],
      },
    });
    expect(resolved.clientTraceMetadata).toEqual([
      "my-test-key-1",
      "my-test-key-2",
      "my-parent-span-id",
    ]);
  });

  it("filters out non-string entries", async () => {
    const resolved = await resolveNextConfig({
      // oxlint-disable-next-line typescript/no-explicit-any
      experimental: { clientTraceMetadata: ["valid-key", 42, null, "another-key"] as any },
    });
    expect(resolved.clientTraceMetadata).toEqual(["valid-key", "another-key"]);
  });

  it("returns undefined for a non-array value", async () => {
    const resolved = await resolveNextConfig({
      // oxlint-disable-next-line typescript/no-explicit-any
      experimental: { clientTraceMetadata: "not-an-array" as any },
    });
    expect(resolved.clientTraceMetadata).toBeUndefined();
  });

  it("resolves to an empty array when experimental.clientTraceMetadata is an empty array", async () => {
    const resolved = await resolveNextConfig({
      experimental: { clientTraceMetadata: [] },
    });
    expect(resolved.clientTraceMetadata).toEqual([]);
  });
});

describe("resolveNextConfig removeConsole", () => {
  it("resolves `compiler: { removeConsole: true }` to `true`", async () => {
    const resolved = await resolveNextConfig({ compiler: { removeConsole: true } });
    expect(resolved.removeConsole).toBe(true);
  });

  it("resolves `compiler: { removeConsole: { exclude: ['error'] } }` to the same shape", async () => {
    const resolved = await resolveNextConfig({
      compiler: { removeConsole: { exclude: ["error"] } },
    });
    expect(resolved.removeConsole).toEqual({ exclude: ["error"] });
  });

  it("resolves `compiler: { removeConsole: {} }` to `{ exclude: [] }`", async () => {
    const resolved = await resolveNextConfig({ compiler: { removeConsole: {} } });
    expect(resolved.removeConsole).toEqual({ exclude: [] });
  });

  it("resolves missing `compiler` to `false`", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.removeConsole).toBe(false);
  });

  it("resolves `compiler: {}` (no removeConsole key) to `false`", async () => {
    const resolved = await resolveNextConfig({ compiler: {} });
    expect(resolved.removeConsole).toBe(false);
  });

  it("resolves `compiler: { removeConsole: false }` to `false`", async () => {
    const resolved = await resolveNextConfig({ compiler: { removeConsole: false } });
    expect(resolved.removeConsole).toBe(false);
  });

  it("coerces non-string entries in `exclude` away (sanitization)", async () => {
    const resolved = await resolveNextConfig({
      // oxlint-disable-next-line typescript/no-explicit-any
      compiler: { removeConsole: { exclude: ["error", 42, null, "warn"] as any } },
    });
    expect(resolved.removeConsole).toEqual({ exclude: ["error", "warn"] });
  });
});

// Ported from Next.js: test/e2e/define/define.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/define/define.test.ts
describe("resolveNextConfig compiler.define / defineServer", () => {
  it("defaults to empty maps when `compiler` is unset", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.compilerDefine).toEqual({});
    expect(resolved.compilerDefineServer).toEqual({});
  });

  it("JSON-stringifies string, number, and boolean values for `define`", async () => {
    const resolved = await resolveNextConfig({
      compiler: {
        define: {
          MY_MAGIC_VARIABLE: "foobar",
          "process.env.MY_MAGIC_EXPR": "barbaz",
          MY_NUMBER_VARIABLE: 42,
          MY_BOOLEAN_VARIABLE: true,
        },
      },
    });
    expect(resolved.compilerDefine).toEqual({
      MY_MAGIC_VARIABLE: '"foobar"',
      "process.env.MY_MAGIC_EXPR": '"barbaz"',
      MY_NUMBER_VARIABLE: "42",
      MY_BOOLEAN_VARIABLE: "true",
    });
    expect(resolved.compilerDefineServer).toEqual({});
  });

  it("JSON-stringifies values for `defineServer` and keeps them separate from `define`", async () => {
    const resolved = await resolveNextConfig({
      compiler: {
        define: { CLIENT_SAFE: "shared" },
        defineServer: {
          MY_SERVER_VARIABLE: "server",
          "process.env.MY_MAGIC_SERVER_EXPR": "serverbarbaz",
        },
      },
    });
    expect(resolved.compilerDefine).toEqual({ CLIENT_SAFE: '"shared"' });
    expect(resolved.compilerDefineServer).toEqual({
      MY_SERVER_VARIABLE: '"server"',
      "process.env.MY_MAGIC_SERVER_EXPR": '"serverbarbaz"',
    });
  });

  it("ignores entries whose values are not string/number/boolean", async () => {
    const resolved = await resolveNextConfig({
      compiler: {
        // oxlint-disable-next-line typescript/no-explicit-any
        define: { OK: "yes", BAD_OBJ: { nope: 1 } as any, BAD_NULL: null as any },
        // oxlint-disable-next-line typescript/no-explicit-any
        defineServer: { OK_SRV: 1, BAD_ARR: [1, 2] as any },
      },
    });
    expect(resolved.compilerDefine).toEqual({ OK: '"yes"' });
    expect(resolved.compilerDefineServer).toEqual({ OK_SRV: "1" });
  });
});

describe("resolveNextConfig htmlLimitedBots", () => {
  it("serializes RegExp config values to their source", async () => {
    const resolved = await resolveNextConfig({ htmlLimitedBots: /Minibot/i });

    expect(resolved.htmlLimitedBots).toBe("Minibot");
  });

  it("accepts valid serialized regex source strings", async () => {
    const resolved = await resolveNextConfig({ htmlLimitedBots: "Minibot|Weebot" });

    expect(resolved.htmlLimitedBots).toBe("Minibot|Weebot");
  });

  it("treats empty string config as unset", async () => {
    const resolved = await resolveNextConfig({ htmlLimitedBots: "" });

    expect(resolved.htmlLimitedBots).toBeUndefined();
  });

  it("throws a config error for invalid serialized regex sources", async () => {
    await expect(resolveNextConfig({ htmlLimitedBots: "[" })).rejects.toThrow(
      'Invalid next.config option "htmlLimitedBots"',
    );
  });
});

describe("resolveNextConfig expireTime", () => {
  it("defaults to the Next.js route expire fallback", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.expireTime).toBe(31_536_000);
  });

  it("uses configured expireTime", async () => {
    const resolved = await resolveNextConfig({ expireTime: 2 });
    expect(resolved.expireTime).toBe(2);
  });
});

describe("resolveNextConfig reactMaxHeadersLength", () => {
  it("defaults to the Next.js default of 6000", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.reactMaxHeadersLength).toBe(6000);
  });

  it("uses a configured value", async () => {
    const resolved = await resolveNextConfig({ reactMaxHeadersLength: 400 });
    expect(resolved.reactMaxHeadersLength).toBe(400);
  });

  it("preserves 0 (disables emission) rather than falling back to the default", async () => {
    const resolved = await resolveNextConfig({ reactMaxHeadersLength: 0 });
    expect(resolved.reactMaxHeadersLength).toBe(0);
  });
});

// Ported from Next.js: packages/next/src/server/config.ts:528-531
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/config.ts
describe("resolveNextConfig basePath → assetPrefix parity fallback", () => {
  it("falls back to basePath when assetPrefix is empty", async () => {
    const resolved = await resolveNextConfig({ basePath: "/app" });
    expect(resolved.basePath).toBe("/app");
    expect(resolved.assetPrefix).toBe("/app");
  });

  it("does not override an explicitly set assetPrefix", async () => {
    const resolved = await resolveNextConfig({
      basePath: "/app",
      assetPrefix: "/cdn",
    });
    expect(resolved.basePath).toBe("/app");
    expect(resolved.assetPrefix).toBe("/cdn");
  });

  it("preserves absolute-URL assetPrefix even when basePath is also set", async () => {
    const resolved = await resolveNextConfig({
      basePath: "/app",
      assetPrefix: "https://cdn.example.com",
    });
    expect(resolved.assetPrefix).toBe("https://cdn.example.com");
  });

  it("leaves assetPrefix empty when basePath is also empty", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.basePath).toBe("");
    expect(resolved.assetPrefix).toBe("");
  });

  it("does not fall back when basePath is literal `/` (parity with Next.js)", async () => {
    // Next.js rejects basePath === "/" earlier in its config pipeline;
    // vinext passes the value through but the fallback explicitly skips
    // it to avoid producing assetPrefix === "/" (which would collide
    // with the root URL).
    const resolved = await resolveNextConfig({ basePath: "/" });
    expect(resolved.basePath).toBe("/");
    expect(resolved.assetPrefix).toBe("");
  });
});

describe("detectNextIntlConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeResolved(overrides: Partial<ResolvedNextConfig> = {}): ResolvedNextConfig {
    return {
      env: {},
      assetPrefix: "",
      basePath: "",
      trailingSlash: false,
      output: "",
      pageExtensions: ["tsx", "ts", "jsx", "js"],
      resolveExtensions: null,
      serverResolveExtensions: null,
      cacheComponents: false,
      appNavFailHandling: false,
      gestureTransition: false,
      prefetchInlining: false,
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: [],
      images: undefined,
      i18n: null,
      mdx: null,
      aliases: {},
      allowedDevOrigins: [],
      serverActionsAllowedOrigins: [],
      optimizePackageImports: [],
      transpilePackages: [],
      turbopackTranspilePackages: ["geist"],
      inlineCss: false,
      globalNotFound: false,
      serverActionsBodySizeLimit: 1 * 1024 * 1024,
      serverActionsBodySizeLimitLabel: "1 MB",
      htmlLimitedBots: undefined,
      serverExternalPackages: [],
      cacheHandler: undefined,
      cacheMaxMemorySize: undefined,
      hashSalt: "",
      enablePrerenderSourceMaps: true,
      appShells: false,
      expireTime: 31_536_000,
      reactMaxHeadersLength: 6000,
      buildId: "test-build-id",
      deploymentId: undefined,
      sassOptions: null,
      removeConsole: false,
      disableOptimizedLoading: false,
      scrollRestoration: false,
      compilerDefine: {},
      compilerDefineServer: {},
      instrumentationClientInject: [],
      clientTraceMetadata: undefined,
      staleTimes: { dynamic: 0, static: 300 },
      useLightningcss: false,
      lightningCssFeatures: { include: 0, exclude: 0 },
      ...overrides,
    };
  }

  /** Create a tmpdir with a fake next-intl package so require.resolve("next-intl") works */
  function setupWithNextIntl(i18nFile?: string) {
    tmpDir = makeTempDir();
    // Create a resolvable next-intl package with an entry file.
    const nextIntlDir = path.join(tmpDir, "node_modules", "next-intl");
    fs.mkdirSync(nextIntlDir, { recursive: true });
    fs.writeFileSync(
      path.join(nextIntlDir, "package.json"),
      JSON.stringify({ name: "next-intl", version: "4.0.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(nextIntlDir, "index.js"), "module.exports = {};\n");
    // Create root package.json so createRequire works
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-project" }));

    if (i18nFile) {
      const absPath = path.join(tmpDir, i18nFile);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, "export default {};\n");
    }
  }

  it("auto-detects i18n/request.ts when next-intl is installed", () => {
    setupWithNextIntl("i18n/request.ts");
    const resolved = makeResolved();
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.aliases["next-intl/config"]).toBe(path.join(tmpDir, "i18n", "request.ts"));
  });

  it("auto-detects src/i18n/request.ts", () => {
    setupWithNextIntl("src/i18n/request.ts");
    const resolved = makeResolved();
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.aliases["next-intl/config"]).toBe(
      path.join(tmpDir, "src", "i18n", "request.ts"),
    );
  });

  it("prefers i18n/request.ts over src/i18n/request.ts", () => {
    setupWithNextIntl("i18n/request.ts");
    // Also create src variant
    const srcPath = path.join(tmpDir, "src", "i18n", "request.ts");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "export default {};\n");

    const resolved = makeResolved();
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.aliases["next-intl/config"]).toBe(path.join(tmpDir, "i18n", "request.ts"));
  });

  it("detects .js extension variant", () => {
    setupWithNextIntl("i18n/request.js");
    const resolved = makeResolved();
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.aliases["next-intl/config"]).toBe(path.join(tmpDir, "i18n", "request.js"));
  });

  it("detects .tsx extension variant", () => {
    setupWithNextIntl("i18n/request.tsx");
    const resolved = makeResolved();
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.aliases["next-intl/config"]).toBe(path.join(tmpDir, "i18n", "request.tsx"));
  });

  // Note: "does nothing when next-intl is not installed" cannot be tested
  // in this monorepo because vitest's module resolution always finds
  // next-intl from the workspace root. The code path is a single try/catch
  // that returns early — covered by the "no config file" and "explicit alias" tests.

  it("does nothing when no i18n config file exists", () => {
    setupWithNextIntl(); // no i18n file
    const resolved = makeResolved();
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.aliases["next-intl/config"]).toBeUndefined();
  });

  it("does not overwrite explicit alias", () => {
    setupWithNextIntl("i18n/request.ts");
    const explicit = "/custom/path/to/config.ts";
    const resolved = makeResolved({
      aliases: { "next-intl/config": explicit },
    });
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.aliases["next-intl/config"]).toBe(explicit);
  });

  it("sets trailing slash env var when trailingSlash is true", () => {
    setupWithNextIntl("i18n/request.ts");
    const resolved = makeResolved({ trailingSlash: true });
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.env._next_intl_trailing_slash).toBe("true");
  });

  it("does not set trailing slash env var when trailingSlash is false", () => {
    setupWithNextIntl("i18n/request.ts");
    const resolved = makeResolved({ trailingSlash: false });
    detectNextIntlConfig(tmpDir, resolved);

    expect(resolved.env._next_intl_trailing_slash).toBeUndefined();
  });
});

describe("resolveNextConfig next-intl auto-detection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-detects next-intl even when config is null", async () => {
    tmpDir = makeTempDir();
    // Setup next-intl + i18n config file
    const nextIntlDir = path.join(tmpDir, "node_modules", "next-intl");
    fs.mkdirSync(nextIntlDir, { recursive: true });
    fs.writeFileSync(
      path.join(nextIntlDir, "package.json"),
      JSON.stringify({ name: "next-intl", version: "4.0.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(nextIntlDir, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-project" }));
    fs.mkdirSync(path.join(tmpDir, "i18n"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "i18n", "request.ts"), "export default {};\n");

    const config = await resolveNextConfig(null, tmpDir);
    expect(config.aliases["next-intl/config"]).toBe(path.join(tmpDir, "i18n", "request.ts"));
  });

  it("explicit webpack alias takes precedence over auto-detection", async () => {
    tmpDir = makeTempDir();
    // Setup next-intl + i18n config file
    const nextIntlDir = path.join(tmpDir, "node_modules", "next-intl");
    fs.mkdirSync(nextIntlDir, { recursive: true });
    fs.writeFileSync(
      path.join(nextIntlDir, "package.json"),
      JSON.stringify({ name: "next-intl", version: "4.0.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(nextIntlDir, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-project" }));
    fs.mkdirSync(path.join(tmpDir, "i18n"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "i18n", "request.ts"), "export default {};\n");

    // Create a custom config path
    fs.mkdirSync(path.join(tmpDir, "custom"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "custom", "intl.ts"), "export default {};\n");

    const rawConfig = {
      webpack: (webpackConfig: any) => {
        webpackConfig.resolve = webpackConfig.resolve || {};
        webpackConfig.resolve.alias = webpackConfig.resolve.alias || {};
        webpackConfig.resolve.alias["next-intl/config"] = "./custom/intl.ts";
        return webpackConfig;
      },
    };

    const config = await resolveNextConfig(rawConfig, tmpDir);
    // Should use the explicit webpack alias, not auto-detected
    expect(config.aliases["next-intl/config"]).toBe(path.join(tmpDir, "custom", "intl.ts"));
  });
});

// Ported from Next.js: test/integration/production-config/test/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/integration/production-config/test/index.test.ts
describe("generateBuildId", () => {
  it("defaults to a non-empty string when generateBuildId is not set", async () => {
    const config = await resolveNextConfig(null);
    expect(typeof config.buildId).toBe("string");
    expect(config.buildId.length).toBeGreaterThan(0);
  });

  it("uses the string returned by generateBuildId", async () => {
    const config = await resolveNextConfig({ generateBuildId: () => "my-custom-build-id" });
    expect(config.buildId).toBe("my-custom-build-id");
  });

  it("trims whitespace from the returned build ID", async () => {
    const config = await resolveNextConfig({ generateBuildId: () => "  trimmed  " });
    expect(config.buildId).toBe("trimmed");
  });

  it("falls back to a random UUID when generateBuildId returns null", async () => {
    const config = await resolveNextConfig({ generateBuildId: () => null });
    expect(typeof config.buildId).toBe("string");
    expect(config.buildId.length).toBeGreaterThan(0);
  });

  it("supports async generateBuildId returning a string", async () => {
    const config = await resolveNextConfig({
      generateBuildId: async () => "async-build-id",
    });
    expect(config.buildId).toBe("async-build-id");
  });

  it("supports async generateBuildId returning null (falls back)", async () => {
    const config = await resolveNextConfig({
      generateBuildId: async () => null,
    });
    expect(typeof config.buildId).toBe("string");
    expect(config.buildId.length).toBeGreaterThan(0);
  });

  it("throws when generateBuildId returns a non-string, non-null value", async () => {
    await expect(
      resolveNextConfig({ generateBuildId: () => 42 as unknown as string }),
    ).rejects.toThrow("generateBuildId did not return a string");
  });

  it("throws when generateBuildId returns an empty string", async () => {
    await expect(resolveNextConfig({ generateBuildId: () => "   " })).rejects.toThrow(
      "generateBuildId returned an empty string",
    );
  });

  it("two calls with no generateBuildId produce different build IDs (random)", async () => {
    const a = await resolveNextConfig(null);
    const b = await resolveNextConfig(null);
    // UUIDs are random — astronomically unlikely to collide
    expect(a.buildId).not.toBe(b.buildId);
  });

  it("two calls with the same generateBuildId produce the same ID", async () => {
    const fn = () => "stable-id";
    const a = await resolveNextConfig({ generateBuildId: fn });
    const b = await resolveNextConfig({ generateBuildId: fn });
    expect(a.buildId).toBe("stable-id");
    expect(b.buildId).toBe("stable-id");
  });
});

describe("deploymentId", () => {
  const OLD_ENV = process.env.NEXT_DEPLOYMENT_ID;

  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.NEXT_DEPLOYMENT_ID;
    } else {
      process.env.NEXT_DEPLOYMENT_ID = OLD_ENV;
    }
  });

  it("defaults to undefined when no deployment ID is configured", async () => {
    delete process.env.NEXT_DEPLOYMENT_ID;

    const config = await resolveNextConfig(null);

    expect(config.deploymentId).toBeUndefined();
  });

  it("uses NEXT_DEPLOYMENT_ID when next.config.js does not set deploymentId", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "env-deployment";

    const config = await resolveNextConfig({});

    expect(config.deploymentId).toBe("env-deployment");
  });

  it("lets next.config.js deploymentId take precedence over NEXT_DEPLOYMENT_ID", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "env-deployment";

    const config = await resolveNextConfig({ deploymentId: "config-deployment" });

    expect(config.deploymentId).toBe("config-deployment");
  });

  it("treats an empty next.config.js deploymentId as unset even when NEXT_DEPLOYMENT_ID is set", async () => {
    process.env.NEXT_DEPLOYMENT_ID = "env-deployment";

    const config = await resolveNextConfig({ deploymentId: "" });

    expect(config.deploymentId).toBeUndefined();
  });

  it("throws when deploymentId contains invalid characters", async () => {
    await expect(resolveNextConfig({ deploymentId: "bad value" })).rejects.toThrow(
      "Invalid `deploymentId` configuration: contains invalid characters",
    );
  });

  it("throws when deploymentId is not a string", async () => {
    await expect(resolveNextConfig({ deploymentId: 42 as unknown as string })).rejects.toThrow(
      "Invalid `deploymentId` configuration: must be a string",
    );
  });
});

describe("resolveNextConfig external rewrite warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a warning when rewrites contain external destinations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      rewrites: async () => [
        { source: "/api/:path*", destination: "https://api.example.com/:path*" },
        { source: "/internal", destination: "/other" },
      ],
    });

    const externalWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("external rewrite"),
    );

    expect(externalWarning).toBeDefined();
    expect(externalWarning![0]).toContain("1 external rewrite that");
    expect(externalWarning![0]).toContain("https://api.example.com/:path*");
    expect(externalWarning![0]).toContain("/api/:path*");
    expect(externalWarning![0]).toContain("→");
    expect(externalWarning![0]).toContain("credential headers");
    expect(externalWarning![0]).toContain("forwarded");
    expect(externalWarning![0]).toContain("match Next.js behavior");
    expect(externalWarning![0]).not.toContain("/other");
  });

  it("does not warn when all rewrites are internal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      rewrites: async () => [
        { source: "/old", destination: "/new" },
        { source: "/a", destination: "/b" },
      ],
    });

    const externalWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("external rewrite"),
    );
    expect(externalWarning).toBeUndefined();
  });

  it("warns about multiple external rewrites across beforeFiles, afterFiles, and fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      rewrites: async () => ({
        beforeFiles: [{ source: "/proxy1", destination: "https://one.example.com/api" }],
        afterFiles: [{ source: "/proxy2", destination: "https://two.example.com/api" }],
        fallback: [{ source: "/proxy3", destination: "https://three.example.com/api" }],
      }),
    });

    const externalWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("external rewrite"),
    );
    expect(externalWarning).toBeDefined();
    expect(externalWarning![0]).toContain("3 external rewrites");
    expect(externalWarning![0]).toContain("https://one.example.com/api");
    expect(externalWarning![0]).toContain("https://two.example.com/api");
    expect(externalWarning![0]).toContain("https://three.example.com/api");
    expect(externalWarning![0]).toContain("/proxy1");
    expect(externalWarning![0]).toContain("/proxy2");
    expect(externalWarning![0]).toContain("/proxy3");
  });

  it("does not warn when no rewrites are configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({ env: {} });

    const externalWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("external rewrite"),
    );
    expect(externalWarning).toBeUndefined();
  });
});

describe("resolveNextConfig swcEnvOptions warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a warning when experimental.swcEnvOptions is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: { swcEnvOptions: { mode: "usage" } },
    });

    const swcWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("swcEnvOptions"),
    );

    expect(swcWarning).toBeDefined();
    expect(swcWarning![0]).toContain("swcEnvOptions");
    expect(swcWarning![0]).toContain("not applicable");
    expect(swcWarning![0]).toContain("vinext uses Vite");
  });

  it("does not warn when experimental.swcEnvOptions is not set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: {},
    });

    const swcWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("swcEnvOptions"),
    );
    expect(swcWarning).toBeUndefined();
  });
});

describe("resolveNextConfig cachedNavigations warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a warning when experimental.cachedNavigations is set without cacheComponents", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: { cachedNavigations: true },
    });

    const cachedNavigationsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("cachedNavigations"),
    );

    expect(cachedNavigationsWarning).toBeDefined();
    expect(cachedNavigationsWarning![0]).toContain("experimental.cachedNavigations");
    expect(cachedNavigationsWarning![0]).toContain("cacheComponents: true");
  });

  it("does not warn when experimental.cachedNavigations is set with cacheComponents", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      cacheComponents: true,
      experimental: { cachedNavigations: true },
    });

    const cachedNavigationsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("cachedNavigations"),
    );
    expect(cachedNavigationsWarning).toBeUndefined();
  });

  it("does not warn when experimental.cachedNavigations is not set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: {},
    });

    const cachedNavigationsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("cachedNavigations"),
    );
    expect(cachedNavigationsWarning).toBeUndefined();
  });

  it("does not warn when experimental.cachedNavigations is false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: { cachedNavigations: false },
    });

    const cachedNavigationsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("cachedNavigations"),
    );
    expect(cachedNavigationsWarning).toBeUndefined();
  });
});

describe("resolveNextConfig rootParams deprecation warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a warning when experimental.rootParams is true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: { rootParams: true },
    });

    const rootParamsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("rootParams"),
    );

    expect(rootParamsWarning).toBeDefined();
    expect(rootParamsWarning![0]).toContain("experimental.rootParams");
    expect(rootParamsWarning![0]).toContain("no longer needed");
    expect(rootParamsWarning![0]).toContain("next/root-params");
    expect(rootParamsWarning![0]).toContain("available by default");
  });

  it("emits a warning when experimental.rootParams is false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: { rootParams: false },
    });

    const rootParamsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("rootParams"),
    );

    expect(rootParamsWarning).toBeDefined();
  });

  it("does not warn when experimental.rootParams is not set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({
      experimental: {},
    });

    const rootParamsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("rootParams"),
    );
    expect(rootParamsWarning).toBeUndefined();
  });

  it("does not warn when experimental is not set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveNextConfig({});

    const rootParamsWarning = warn.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("rootParams"),
    );
    expect(rootParamsWarning).toBeUndefined();
  });
});

describe("resolveNextConfig cacheHandler", () => {
  it("resolves file:// URLs to filesystem paths", async () => {
    // Build the URL with pathToFileURL so it is valid on Windows too, where a
    // file:// URL must carry a drive letter (a drive-less file:///… throws in
    // fileURLToPath). In production the URL comes from import.meta.resolve, so
    // it is always platform-valid.
    const handlerPath = path.resolve("/absolute/path/to/handler.js");
    const resolved = await resolveNextConfig({
      cacheHandler: pathToFileURL(handlerPath).href,
    });
    expect(resolved.cacheHandler).toBe(handlerPath);
  });

  it("passes through absolute paths unchanged", async () => {
    const resolved = await resolveNextConfig({
      cacheHandler: "/absolute/path/to/handler.js",
    });
    expect(resolved.cacheHandler).toBe("/absolute/path/to/handler.js");
  });

  it("passes through relative paths unchanged", async () => {
    const resolved = await resolveNextConfig({
      cacheHandler: "./my-cache-handler.js",
    });
    expect(resolved.cacheHandler).toBe("./my-cache-handler.js");
  });

  it("defaults to undefined when not configured", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.cacheHandler).toBeUndefined();
  });

  it("defaults to undefined when config is null", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.cacheHandler).toBeUndefined();
  });

  it("resolves cacheMaxMemorySize when configured", async () => {
    const resolved = await resolveNextConfig({
      cacheMaxMemorySize: 52428800,
    });
    expect(resolved.cacheMaxMemorySize).toBe(52428800);
  });

  it("defaults cacheMaxMemorySize to undefined when not configured", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.cacheMaxMemorySize).toBeUndefined();
  });
});

describe("resolveNextConfig enablePrerenderSourceMaps", () => {
  it("defaults enablePrerenderSourceMaps to true when not configured", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.enablePrerenderSourceMaps).toBe(true);
  });

  it("respects explicit enablePrerenderSourceMaps: false", async () => {
    const resolved = await resolveNextConfig({
      enablePrerenderSourceMaps: false,
    });
    expect(resolved.enablePrerenderSourceMaps).toBe(false);
  });
});

// Regression for issue #1490:
// experimental.staleTimes should be surfaced through ResolvedNextConfig so the
// plugin can inject the values into the client-side router cache.
describe("resolveNextConfig staleTimes (#1490)", () => {
  it("defaults to Next.js' { dynamic: 0, static: 300 } when no config is provided", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.staleTimes).toEqual({ dynamic: 0, static: 300 });
  });

  it("defaults to Next.js' { dynamic: 0, static: 300 } when experimental is not set", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.staleTimes).toEqual({ dynamic: 0, static: 300 });
  });

  it("reads experimental.staleTimes.{dynamic,static} verbatim (in seconds)", async () => {
    const resolved = await resolveNextConfig({
      experimental: { staleTimes: { dynamic: 30, static: 180 } },
    });
    expect(resolved.staleTimes).toEqual({ dynamic: 30, static: 180 });
  });

  it("falls back to defaults for individually-omitted keys", async () => {
    const resolvedDynOnly = await resolveNextConfig({
      experimental: { staleTimes: { dynamic: 45 } },
    });
    expect(resolvedDynOnly.staleTimes).toEqual({ dynamic: 45, static: 300 });

    const resolvedStaticOnly = await resolveNextConfig({
      experimental: { staleTimes: { static: 600 } },
    });
    expect(resolvedStaticOnly.staleTimes).toEqual({ dynamic: 0, static: 600 });
  });

  it("falls back to defaults when staleTimes contains non-numeric values", async () => {
    const resolved = await resolveNextConfig({
      experimental: {
        staleTimes: { dynamic: "oops" as unknown as number, static: undefined },
      },
    });
    expect(resolved.staleTimes).toEqual({ dynamic: 0, static: 300 });
  });

  it("falls back to defaults when staleTimes contains negative values", async () => {
    // Negative values are rejected at resolution time so we don't pass them
    // downstream to `resolvePrefetchCacheTtl`, where they'd be re-validated.
    // Matches the `seconds < 0` guard in `shims/navigation.ts`.
    const resolved = await resolveNextConfig({
      experimental: { staleTimes: { dynamic: -5, static: -1 } },
    });
    expect(resolved.staleTimes).toEqual({ dynamic: 0, static: 300 });
  });
});

describe("resolveNextConfig appShells", () => {
  it("defaults appShells to false when not set", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.appShells).toBe(false);
  });

  it("defaults appShells to false for null config", async () => {
    const resolved = await resolveNextConfig(null);
    expect(resolved.appShells).toBe(false);
  });

  it("reads appShells: true from experimental config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { appShells: true },
    });
    expect(resolved.appShells).toBe(true);
  });

  it("reads appShells: false from experimental config", async () => {
    const resolved = await resolveNextConfig({
      experimental: { appShells: false },
    });
    expect(resolved.appShells).toBe(false);
  });

  it("warns when appShells is enabled without required co-flags", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveNextConfig({
      experimental: { appShells: true },
    });
    expect(resolved.appShells).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "experimental.appShells is enabled but requires the following co-flags",
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cacheComponents"));
    warnSpy.mockRestore();
  });

  it("does not warn when appShells is enabled with all required co-flags", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveNextConfig({
      cacheComponents: true,
      experimental: {
        appShells: true,
        prefetchInlining: true,
        varyParams: true,
        optimisticRouting: true,
        cachedNavigations: true,
      },
    });
    expect(resolved.appShells).toBe(true);
    // The warning should NOT contain the appShells co-flags message
    const appShellsWarnings = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && call[0].includes("experimental.appShells is enabled"),
    );
    expect(appShellsWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

describe("lightningCssFeatureNamesToMask", () => {
  // Bit values are copied from `lightningcss/node/targets.d.ts` (`Features` enum)
  // and `.nextjs-ref/crates/next-core/src/next_config.rs`
  // (`lightningcss_feature_names_to_mask`).
  it("returns 0 for an empty list", () => {
    expect(lightningCssFeatureNamesToMask([])).toBe(0);
  });

  it("maps individual feature names to their canonical bit values", () => {
    expect(lightningCssFeatureNamesToMask(["nesting"])).toBe(1);
    expect(lightningCssFeatureNamesToMask(["not-selector-list"])).toBe(2);
    expect(lightningCssFeatureNamesToMask(["light-dark"])).toBe(1048576);
    expect(lightningCssFeatureNamesToMask(["logical-properties"])).toBe(524288);
  });

  it("maps composite groups to the OR of their constituent bits", () => {
    expect(lightningCssFeatureNamesToMask(["selectors"])).toBe(31);
    expect(lightningCssFeatureNamesToMask(["media-queries"])).toBe(448);
    expect(lightningCssFeatureNamesToMask(["colors"])).toBe(1113088);
  });

  it("OR-merges multiple names into a single bitmask", () => {
    expect(lightningCssFeatureNamesToMask(["nesting", "light-dark"])).toBe(1 | 1048576);
  });

  it("warns and skips unknown feature names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(lightningCssFeatureNamesToMask(["nesting", "not-a-real-feature"])).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not-a-real-feature"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("resolveNextConfig experimental.lightningCssFeatures", () => {
  it("defaults to disabled with empty bitmasks when unset", async () => {
    const resolved = await resolveNextConfig({});
    expect(resolved.useLightningcss).toBe(false);
    expect(resolved.lightningCssFeatures).toEqual({ include: 0, exclude: 0 });
  });

  it("plumbs `useLightningcss: true` through", async () => {
    const resolved = await resolveNextConfig({
      experimental: { useLightningcss: true },
    });
    expect(resolved.useLightningcss).toBe(true);
  });

  it("converts dash-case feature names into the canonical bitmask", async () => {
    const resolved = await resolveNextConfig({
      experimental: {
        useLightningcss: true,
        lightningCssFeatures: {
          include: ["nesting"],
          exclude: ["light-dark", "logical-properties"],
        },
      },
    });
    expect(resolved.lightningCssFeatures).toEqual({
      include: 1,
      exclude: 1048576 | 524288,
    });
  });

  it("warns when lightningCssFeatures is set without useLightningcss", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = await resolveNextConfig({
        experimental: {
          lightningCssFeatures: { exclude: ["light-dark"] },
        },
      });
      expect(resolved.useLightningcss).toBe(false);
      expect(resolved.lightningCssFeatures.exclude).toBe(1048576);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("lightningCssFeatures is set but experimental.useLightningcss"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
