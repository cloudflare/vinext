import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";

async function buildAppWithExtensionlessTailwindConfig(
  configFileName: string,
  configSource: string,
  expectedToken: string,
): Promise<void> {
  const vinext = (await import("../packages/vinext/src/index.js")).default;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-init-cjs-resolve-"));
  const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

  // ESM package — mirrors what `vinext init` writes when it renames CJS
  // configs to `.cjs` and adds `"type": "module"`.
  await fs.writeFile(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "init-cjs-resolve-fixture", private: true, type: "module" }),
  );

  await fs.writeFile(path.join(tmpDir, configFileName), configSource);

  await fs.mkdir(path.join(tmpDir, "app"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "app", "layout.tsx"),
    `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
  );
  // Extensionless import of the renamed config (react.dev pattern).
  await fs.writeFile(
    path.join(tmpDir, "app", "page.tsx"),
    `import tailwindConfig from "../tailwind.config";
export default function Page() { return <p>{tailwindConfig.theme.tokenMarker}</p>; }`,
  );

  try {
    const builder = await createBuilder({
      root: tmpDir,
      configFile: false,
      plugins: [vinext({ appDir: tmpDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const builtFiles = await fs.readdir(path.join(tmpDir, "dist", "server"), {
      recursive: true,
      encoding: "utf8",
    });
    const serverOutput = (
      await Promise.all(
        builtFiles
          .filter((file) => file.endsWith(".js"))
          .map((file) => fs.readFile(path.join(tmpDir, "dist", "server", file), "utf8")),
      )
    ).join("\n");
    expect(serverOutput).toContain(expectedToken);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Regression test for extensionless imports of vinext init-renamed CJS configs.
//
// `vinext init` renames CJS config files like `tailwind.config.js` and
// `postcss.config.js` to `.cjs` when it adds `"type": "module"` to
// package.json (see renameCJSConfigs in utils/project.ts). react.dev imports
// the renamed config extensionlessly, e.g.:
//
//   import tailwindConfig from "../../tailwind.config";
//
// Vite's default `resolve.extensions` does NOT include `.cjs`, so the bundle
// fails with "[UNRESOLVED_IMPORT] Could not resolve '../../tailwind.config'".
// vinext overrides `resolve.extensions` for the app graph, so CJS config
// extensions must be in the override list for these configs to resolve
// extensionlessly. `.cts` is covered defensively for TypeScript CJS configs;
// Next.js has matching .cts PostCSS config coverage.
describe("vinext init CJS config extensionless import", () => {
  it("resolves an extensionless import of a renamed tailwind.config.cjs", async () => {
    await buildAppWithExtensionlessTailwindConfig(
      "tailwind.config.cjs",
      `module.exports = { content: ["./app/**/*.{ts,tsx}"], theme: { tokenMarker: "tailwind-cjs-token" } };`,
      "tailwind-cjs-token",
    );
  }, 30000);

  it("resolves an extensionless import of a TypeScript tailwind.config.cts", async () => {
    // .cts is not produced by `vinext init`, but Next.js supports TypeScript
    // CJS config files. Keep it covered because `.cts` shares the same
    // resolution and CommonJS-transform skip path as `.cjs`.
    await buildAppWithExtensionlessTailwindConfig(
      "tailwind.config.cts",
      `type TailwindConfig = { content: string[]; theme: { tokenMarker: string } };
const config: TailwindConfig = { content: ["./app/**/*.{ts,tsx}"], theme: { tokenMarker: "tailwind-cts-token" } };
module.exports = config;`,
      "tailwind-cts-token",
    );
  }, 30000);
});
