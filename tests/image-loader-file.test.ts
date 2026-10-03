/**
 * `images.loaderFile` config wiring.
 *
 * Next.js's `images: { loader: "custom", loaderFile: "./my-loader.js" }`
 * points at a module whose default export is a custom ImageLoader, used by
 * every `next/image` instance that doesn't set its own `loader` prop.
 *
 * vinext wires this as a `resolve.alias` entry (not a generated virtual
 * module — there is nothing to generate, just a file swap): the bare
 * specifier `vinext:image-loader-file` resolves to the user's configured
 * file when set, or to shims/image-loader-file-default.ts (`undefined`,
 * a no-op) otherwise. shims/image.tsx imports that specifier unconditionally
 * and falls back to it when no per-image `loader` prop is given — see
 * tests/image-component.test.ts for the shim-side srcSet/quality behavior
 * once a loader (prop or loaderFile) is in play.
 *
 * Ported from Next.js: test/e2e/next-image-new/loader-config/loader-config.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/loader-config/loader-config.test.ts
 */
import path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic");

async function resolveAliasMap(images?: Record<string, unknown>) {
  const plugins = vinext({ nextConfig: () => ({ images }) }) as any[];
  const configPlugin = plugins.find((plugin) => plugin.name === "vinext:config");
  const config = await configPlugin.config(
    { root: APP_FIXTURE_DIR, plugins: [] },
    { command: "build", mode: "production" },
  );
  const alias = config.resolve.alias as Array<{ find: string; replacement: string }>;
  return Object.fromEntries(alias.map((entry) => [entry.find, entry.replacement]));
}

describe("images.loaderFile resolve.alias wiring", () => {
  it("aliases to the no-op default when images is unset", async () => {
    const aliasMap = await resolveAliasMap(undefined);
    expect(aliasMap["vinext:image-loader-file"]).toMatch(/image-loader-file-default\.(ts|js)$/);
  });

  it("aliases to the no-op default when loader is 'default' (or unset) even with loaderFile present", async () => {
    const aliasMap = await resolveAliasMap({ loaderFile: "./my-loader.js" });
    expect(aliasMap["vinext:image-loader-file"]).toMatch(/image-loader-file-default\.(ts|js)$/);
  });

  it("aliases to the configured file, resolved against the project root, when loader is 'custom'", async () => {
    const aliasMap = await resolveAliasMap({ loader: "custom", loaderFile: "./my-loader.js" });
    expect(aliasMap["vinext:image-loader-file"]).toBe(
      path.resolve(APP_FIXTURE_DIR, "./my-loader.js"),
    );
  });

  it("aliases to the no-op default when loader is 'custom' but loaderFile is missing", async () => {
    const aliasMap = await resolveAliasMap({ loader: "custom" });
    expect(aliasMap["vinext:image-loader-file"]).toMatch(/image-loader-file-default\.(ts|js)$/);
  });
});
