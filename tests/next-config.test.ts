import { describe, it, expect, afterEach, vi, beforeEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectNextIntlConfig,
  loadNextConfig,
  parseBodySizeLimit,
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
      `const path = require('path');\n module.exports = {};\n`,
    );

    await expect(loadNextConfig(tmpDir, PHASE_PRODUCTION_BUILD)).rejects.toThrow();
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
      serverActionsBodySizeLimit: 1 * 1024 * 1024,
      serverExternalPackages: [],
      buildId: "test-build-id",
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
