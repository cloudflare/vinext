import { describe, it, expect, afterEach, vi, beforeEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectNextIntlConfig,
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
        `module.exports = { basePath: path.join('/', 'docs') };\n`,
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

  it("does not leave temp .cjs files in the project root", async () => {
    fs.writeFileSync(path.join(tmpDir, "next.config.js"), `module.exports = { basePath: '/x' };\n`);

    await loadNextConfig(tmpDir);

    const stray = fs
      .readdirSync(tmpDir)
      .filter((name) => name.startsWith(".vinext-next-config.") && name.endsWith(".cjs"));
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
  // Next.js's transpile-config.ts reads compilerOptions.paths from tsconfig.json
  // and passes them to SWC so that next.config.ts can import via tsconfig
  // aliases. vinext mirrors this by passing tsconfig paths to Vite as
  // resolve.alias when calling runnerImport.

  let tmpDir: string;

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

describe("resolveNextConfig alias extraction", () => {
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

  it("extracts aliases and mdx from a single async webpack probe", async () => {
    tmpDir = makeTempDir();

    let invocations = 0;
    const fakeRemarkPlugin = () => {};
    const rawConfig = {
      webpack: async (webpackConfig: any) => {
        invocations++;
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

    expect(invocations).toBe(1);
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
      cacheComponents: false,
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
      serverActionsBodySizeLimit: 1 * 1024 * 1024,
      serverExternalPackages: [],
      cacheHandler: undefined,
      cacheMaxMemorySize: undefined,
      hashSalt: "",
      enablePrerenderSourceMaps: true,
      expireTime: 31_536_000,
      buildId: "test-build-id",
      deploymentId: undefined,
      sassOptions: null,
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

describe("resolveNextConfig cacheHandler", () => {
  it("resolves file:// URLs to filesystem paths", async () => {
    const resolved = await resolveNextConfig({
      cacheHandler: "file:///absolute/path/to/handler.js",
    });
    expect(resolved.cacheHandler).toBe("/absolute/path/to/handler.js");
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
