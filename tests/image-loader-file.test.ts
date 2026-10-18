/**
 * `images.loaderFile` config wiring.
 *
 * shims/image-external.tsx imports `vinext/shims/image-loader-file`; the vinext plugin
 * aliases that specifier to the configured loader file, mirroring how Next.js
 * aliases `next/dist/shared/lib/image-loader` to it. The rules come from the
 * `images.loaderFile` normalization in Next.js's server/config.ts. See
 * tests/image-optimization-parity.test.ts for the end-to-end fixture coverage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { aliasEntriesToRecord } from "./helpers.js";

const SPECIFIER = "vinext/shims/image-loader-file";
const DEFAULT_MODULE_RE = /[/\\]shims[/\\]image-loader-file\.(ts|js)$/;

describe("images.loaderFile resolve.alias wiring", () => {
  let root: string;
  let loaderFile: string;

  async function runConfigHook(images?: Record<string, unknown>) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const plugins = vinext({ nextConfig: () => ({ images }) }) as any[];
    const configPlugin = plugins.find((plugin) => plugin.name === "vinext:config");
    return configPlugin.config({ root, plugins: [] }, { command: "build", mode: "production" });
  }

  async function resolveAliasMap(images?: Record<string, unknown>) {
    const config = await runConfigHook(images);
    return aliasEntriesToRecord(config.resolve.alias);
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-image-loader-file-"));
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.mkdirSync(path.join(root, "pages"));
    fs.writeFileSync(path.join(root, "pages", "index.tsx"), "export default () => null;\n");
    loaderFile = path.join(root, "my-loader.js");
    fs.writeFileSync(loaderFile, "export default ({ src }) => src;\n");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps vinext's undefined default when loaderFile is unset", async () => {
    expect((await resolveAliasMap(undefined))[SPECIFIER]).toMatch(DEFAULT_MODULE_RE);
    expect((await resolveAliasMap({ loader: "custom" }))[SPECIFIER]).toMatch(DEFAULT_MODULE_RE);
  });

  it("inlines the loader modes the next/image shim validates against", async () => {
    const unset = (await runConfigHook(undefined)).define;
    expect(unset["process.env.__VINEXT_IMAGE_CUSTOM_LOADER"]).toBe('"false"');
    expect(unset["process.env.__VINEXT_IMAGE_LOADER_FILE"]).toBe('"false"');

    const custom = (await runConfigHook({ loader: "custom", loaderFile: "./my-loader.js" })).define;
    expect(custom["process.env.__VINEXT_IMAGE_CUSTOM_LOADER"]).toBe('"true"');
    expect(custom["process.env.__VINEXT_IMAGE_LOADER_FILE"]).toBe('"true"');
  });

  it.each([undefined, "default", "custom"])(
    "resolves loaderFile against the project root when loader is %s",
    async (loader) => {
      const aliasMap = await resolveAliasMap({ loader, loaderFile: "./my-loader.js" });
      expect(aliasMap[SPECIFIER]).toBe(loaderFile);
    },
  );

  // Next.js joins (not resolves) the path, so a leading slash stays
  // project-relative, as in its loader-config named-export fixture.
  it("treats a leading-slash loaderFile as project-relative", async () => {
    const aliasMap = await resolveAliasMap({ loaderFile: "/my-loader.js" });
    expect(aliasMap[SPECIFIER]).toBe(loaderFile);
  });

  it("rejects loaderFile combined with a built-in loader preset", async () => {
    await expect(
      resolveAliasMap({ loader: "imgix", loaderFile: "./my-loader.js" }),
    ).rejects.toThrow(
      'Specified images.loader property (imgix) cannot be used with images.loaderFile property. Please set images.loader to "custom".',
    );
  });

  it("rejects a loaderFile that does not exist", async () => {
    await expect(resolveAliasMap({ loaderFile: "./missing-loader.js" })).rejects.toThrow(
      `Specified images.loaderFile does not exist at "${path.join(root, "missing-loader.js")}".`,
    );
  });
});
