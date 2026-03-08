import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadNextConfig, parseBodySizeLimit, resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } from "../packages/vinext/src/shims/constants.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-config-test-"));
}

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
    expect(config.aliases["wrapped/config"]).toBe(
      path.join(tmpDir, "config", "request.ts"),
    );
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

    expect(config.aliases["wrapped/config"]).toBe(
      path.join(tmpDir, "turbo", "request.ts"),
    );
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

    expect(config.aliases["wrapped/config"]).toBe(
      path.join(tmpDir, "turbopack", "request.ts"),
    );
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

    expect(config.aliases["wrapped/config"]).toBe(
      path.join(tmpDir, "turbopack", "request.ts"),
    );
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
    expect(config.aliases["wrapped/config"]).toBe(
      path.join(tmpDir, "config", "request.ts"),
    );
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
    expect(parseBodySizeLimit("invalid")).toBe(1 * 1024 * 1024);
    expect(parseBodySizeLimit("10mbb")).toBe(1 * 1024 * 1024);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("Invalid bodySizeLimit");
    warn.mockRestore();
    // empty string also falls through to the regex (no match), so it warns too
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
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
