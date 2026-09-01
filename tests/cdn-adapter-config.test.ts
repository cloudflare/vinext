import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  configureCdnVersionMetadata,
  finalizeCdnAdapterBuildOutput,
} from "../packages/cloudflare/src/cache/cdn-adapter-config.js";
import {
  cdnAdapter,
  DEFAULT_CDN_VERSION_METADATA_BINDING,
} from "../packages/cloudflare/src/cache/cdn-adapter.js";
import { resolveCdnAdapterConfig } from "../packages/cloudflare/src/deploy-config.js";
import { assertCdnVersionMetadataConfig } from "../packages/cloudflare/src/wrangler-version-metadata.js";

let root: string;

function writeJson(relativePath: string, value: unknown): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function writeGeneratedConfig(
  relativePath = "dist/server/wrangler.json",
  config: Record<string, unknown> = { name: "test-worker", main: "index.js" },
): string {
  const configPath = writeJson(relativePath, config);
  writeJson(".wrangler/deploy/config.json", {
    configPath: path.relative(path.join(root, ".wrangler/deploy"), configPath),
  });
  return configPath;
}

describe("Cloudflare CDN adapter generated config", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cdn-adapter-config-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("adds the default binding to the primary generated config only", async () => {
    const sourcePath = writeJson("wrangler.jsonc", { name: "source-worker" });
    const generatedPath = writeGeneratedConfig();
    const auxiliaryPath = writeJson("dist/auxiliary/wrangler.json", {
      name: "auxiliary-worker",
    });

    await finalizeCdnAdapterBuildOutput({
      root,
      outDir: path.dirname(auxiliaryPath),
      binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
      bindingIsExplicit: false,
    });
    await finalizeCdnAdapterBuildOutput({
      root,
      outDir: path.dirname(generatedPath),
      binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
      bindingIsExplicit: false,
    });

    expect(JSON.parse(fs.readFileSync(generatedPath, "utf8")).version_metadata).toEqual({
      binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
    });
    expect(JSON.parse(fs.readFileSync(auxiliaryPath, "utf8")).version_metadata).toBeUndefined();
    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"name":"source-worker"}');
  });

  it("leaves an already matching generated config byte-for-byte unchanged", async () => {
    const generatedPath = writeGeneratedConfig("dist/server/wrangler.json", {
      name: "test-worker",
      version_metadata: { binding: DEFAULT_CDN_VERSION_METADATA_BINDING },
    });
    const before = fs.readFileSync(generatedPath, "utf8");

    await finalizeCdnAdapterBuildOutput({
      root,
      outDir: path.dirname(generatedPath),
      binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
      bindingIsExplicit: false,
    });

    expect(fs.readFileSync(generatedPath, "utf8")).toBe(before);
  });

  it("rejects an existing custom binding when cdnAdapter uses its default", async () => {
    const generatedPath = writeGeneratedConfig("dist/server/wrangler.json", {
      name: "test-worker",
      version_metadata: { binding: "EXISTING_VERSION" },
    });

    await expect(
      finalizeCdnAdapterBuildOutput({
        root,
        outDir: path.dirname(generatedPath),
        binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
        bindingIsExplicit: false,
      }),
    ).rejects.toThrow('configure cdnAdapter({ versionMetadataBinding: "EXISTING_VERSION" })');
    expect(JSON.parse(fs.readFileSync(generatedPath, "utf8")).version_metadata).toEqual({
      binding: "EXISTING_VERSION",
    });
  });

  it("lets an explicit adapter binding replace a generated binding", () => {
    expect(
      configureCdnVersionMetadata(
        { version_metadata: { binding: "EXISTING_VERSION" } },
        { binding: "CUSTOM_VERSION", bindingIsExplicit: true },
      ),
    ).toEqual({ version_metadata: { binding: "CUSTOM_VERSION" } });
  });

  it("rejects malformed generated metadata instead of silently replacing it", () => {
    for (const version_metadata of [null, [], {}, { binding: "" }, { binding: 42 }]) {
      expect(() =>
        configureCdnVersionMetadata(
          { version_metadata },
          { binding: DEFAULT_CDN_VERSION_METADATA_BINDING, bindingIsExplicit: false },
        ),
      ).toThrow(/invalid version_metadata/);
    }
  });

  it("exposes finalization only for Cloudflare builds", () => {
    const output = cdnAdapter().output;
    expect(output.matchesBuild({ plugins: [{ name: "vite-plugin-cloudflare" }] })).toBe(true);
    expect(output.matchesBuild({ plugins: [{ name: "vite-plugin-cloudflare:deploy" }] })).toBe(
      true,
    );
    expect(output.matchesBuild({ plugins: [{ name: "another-platform" }] })).toBe(false);
  });
});

describe("vinext cache adapter output hook", () => {
  it("runs matching adapter finalizers with the emitted output directory", async () => {
    const finalizeBuildOutput = vi.fn();
    const plugins = vinext({
      disableAppRouter: true,
      react: false,
      rsc: false,
      cache: {
        cdn: {
          adapter: "test-adapter",
          output: {
            matchesBuild: ({ plugins }) => plugins.some(({ name }) => name === "test-platform"),
            finalizeBuildOutput,
          },
        },
      },
    });
    const plugin = plugins.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        "name" in candidate &&
        candidate.name === "vinext:cache-adapter-build-output",
    );
    expect(plugin).toBeDefined();
    if (!plugin || typeof plugin !== "object" || !("writeBundle" in plugin)) return;

    const hook =
      typeof plugin.writeBundle === "function" ? plugin.writeBundle : plugin.writeBundle?.handler;
    expect(hook).toBeTypeOf("function");
    await hook?.call(
      {
        environment: {
          config: {
            root: "/project",
            plugins: [{ name: "test-platform" }],
          },
        },
      } as never,
      { dir: "dist/server" } as never,
      {},
    );

    expect(finalizeBuildOutput).toHaveBeenCalledOnce();
    expect(finalizeBuildOutput).toHaveBeenCalledWith({
      root: "/project",
      outDir: path.resolve("/project/dist/server"),
    });
  });
});

describe("CDN version metadata deploy validation", () => {
  it("resolves the built-in adapter's default and custom bindings", () => {
    expect(resolveCdnAdapterConfig({ cdn: cdnAdapter() })).toEqual({
      versionMetadataBinding: DEFAULT_CDN_VERSION_METADATA_BINDING,
    });
    expect(
      resolveCdnAdapterConfig({
        cdn: cdnAdapter({ versionMetadataBinding: "CUSTOM_VERSION" }),
      }),
    ).toEqual({ versionMetadataBinding: "CUSTOM_VERSION" });
    expect(resolveCdnAdapterConfig({ cdn: { adapter: "custom-adapter" } })).toBeNull();
  });

  it("rejects missing or conflicting effective deploy bindings", () => {
    expect(() =>
      assertCdnVersionMetadataConfig({
        binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
        configuredBinding: undefined,
        configPath: "dist/server/wrangler.json",
      }),
    ).toThrow("does not declare version_metadata");
    expect(() =>
      assertCdnVersionMetadataConfig({
        binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
        configuredBinding: "OTHER_VERSION",
        configPath: "dist/server/wrangler.json",
      }),
    ).toThrow('declares "OTHER_VERSION" instead');
    expect(() =>
      assertCdnVersionMetadataConfig({
        binding: DEFAULT_CDN_VERSION_METADATA_BINDING,
        configuredBinding: DEFAULT_CDN_VERSION_METADATA_BINDING,
        configPath: "dist/server/wrangler.json",
      }),
    ).not.toThrow();
  });
});
