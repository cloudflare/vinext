import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";

const loader = {
  loader: "next-intl/extractor/catalogLoader",
  options: { messages: { precompile: true, path: "./messages", format: "json" } },
};
const formatAlias = {
  "use-intl/format-message": "use-intl/format-message/format-only",
  "other/module": "other/target",
};
const rules = { "*.json": { loaders: [loader], as: "*.js" } };

describe("next-intl unsupported catalog precompilation", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-intl-precompile-"));
    roots.push(root);
    return root;
  }
  it.each(["turbopack", "legacy", "webpack"])(
    "does not apply a format-only alias without its %s catalog loader",
    async (mode) => {
      const root = makeRoot();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config =
        mode === "turbopack"
          ? { turbopack: { resolveAlias: formatAlias, rules } }
          : mode === "legacy"
            ? { experimental: { turbo: { resolveAlias: formatAlias, rules } } }
            : {
                webpack(config: any) {
                  Object.assign(config.resolve.alias, formatAlias);
                  config.module.rules.push({ oneOf: [{ use: [loader] }] });
                  return config;
                },
              };
      const resolved = await resolveNextConfig(config, root);
      expect(resolved.aliases["use-intl/format-message"]).toBeUndefined();
      expect(resolved.aliases["other/module"]).toBe("other/target");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring its format-only alias"));
    },
  );
  it("recognizes the absolute format-only path emitted by the real plugin", async () => {
    const root = makeRoot();
    fs.symlinkSync(
      path.resolve(import.meta.dirname, "fixtures/cf-next-intl/node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    const require = createRequire(path.join(root, "package.json"));
    const intlRequire = createRequire(require.resolve("next-intl/plugin"));
    const target = intlRequire.resolve("use-intl/format-message/format-only");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveNextConfig(
      { turbopack: { resolveAlias: { "use-intl/format-message": target }, rules } },
      root,
    );
    expect(resolved.aliases["use-intl/format-message"]).toBeUndefined();
  });
  it.each([
    undefined,
    { "*.json": { loaders: [{ ...loader, options: { messages: { precompile: false } } }] } },
  ])("preserves an explicit format-only alias without precompilation", async (rules) => {
    const root = makeRoot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveNextConfig(
      { turbopack: { resolveAlias: formatAlias, rules } },
      root,
    );
    expect(resolved.aliases["use-intl/format-message"]).toBe(
      formatAlias["use-intl/format-message"],
    );
  });
  it("preserves a custom formatting alias with precompilation configured", async () => {
    const root = makeRoot();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = await resolveNextConfig(
      { turbopack: { resolveAlias: { "use-intl/format-message": "custom/formatter" }, rules } },
      root,
    );
    expect(resolved.aliases["use-intl/format-message"]).toBe("custom/formatter");
  });
});
