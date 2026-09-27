import fs from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function createNextIntlFixture({
  convention = "middleware",
  layout = "hoisted",
  cloudflare = true,
}: {
  convention?: string;
  layout?: string;
  cloudflare?: boolean;
} = {}): Promise<string> {
  const fixture = path.resolve(process.cwd(), "tests/fixtures/ecosystem/next-intl");
  const nodeModules =
    process.env.VINEXT_NEXT_INTL_NODE_MODULES ?? path.join(fixture, "node_modules");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-next-intl-"));
  try {
    await fs.cp(fixture, root, {
      recursive: true,
      filter: (src) =>
        !["node_modules", ".vinext", ".wrangler", "dist", ".next"].includes(path.basename(src)),
    });
    const localModules = path.join(root, "node_modules");
    if (!process.env.VINEXT_NEXT_INTL_NODE_MODULES && layout === "hoisted") {
      // Model npm's layout using the already installed, locked dependencies.
      await fs.mkdir(localModules);
      for (const name of await fs.readdir(nodeModules)) {
        if (name.startsWith(".")) continue;
        await fs.symlink(path.join(nodeModules, name), path.join(localModules, name), "junction");
      }
      const nextIntlPackage = await fs.realpath(
        findPackageJSON("next-intl", pathToFileURL(path.join(fixture, "package.json")))!,
      );
      const useIntlPackage = await fs.realpath(
        findPackageJSON("use-intl", pathToFileURL(nextIntlPackage))!,
      );
      for (const [name, parent] of [
        ["@formatjs/intl-localematcher", nextIntlPackage],
        ["negotiator", nextIntlPackage],
        ["@formatjs/fast-memoize", useIntlPackage],
        ["intl-messageformat", useIntlPackage],
      ]) {
        const target = path.join(localModules, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.symlink(
          path.dirname(findPackageJSON(name, pathToFileURL(parent))!),
          target,
          "junction",
        );
      }
    } else {
      try {
        await fs.symlink(nodeModules, localModules, "dir");
      } catch {
        await fs.symlink(nodeModules, localModules, "junction");
      }
    }
    const middlewarePath = path.join(root, "middleware.ts");
    await fs.writeFile(
      middlewarePath,
      (await fs.readFile(middlewarePath, "utf8")).replace(
        'matcher: ["/"]',
        'matcher: ["/", "/(en|de)/:path*"]',
      ),
    );
    if (convention === "proxy") {
      await fs.mkdir(path.join(root, "src"));
      for (const dir of ["app", "i18n"])
        await fs.rename(path.join(root, dir), path.join(root, "src", dir));
      await fs.rename(middlewarePath, path.join(root, "src/proxy.ts"));
    }
    const pluginPath = path.join(
      process.env.VINEXT_NEXT_INTL_NODE_MODULES ??
        path.resolve(process.cwd(), "tests/fixtures/cf-app-basic/node_modules"),
      "@cloudflare/vite-plugin/dist/index.mjs",
    );
    if (cloudflare) {
      await fs.writeFile(
        path.join(root, "wrangler.jsonc"),
        JSON.stringify({
          name: "vinext-next-intl-cold-start",
          compatibility_date: "2026-02-12",
          compatibility_flags: ["nodejs_compat"],
          main: "vinext/server/fetch-handler",
          assets: { binding: "ASSETS", not_found_handling: "none" },
        }),
      );
    }
    const plugins = ["vinext()"];
    if (cloudflare)
      plugins.push('cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })');
    if (convention === "proxy") plugins.reverse();
    await fs.writeFile(
      path.join(root, "vite.config.ts"),
      `
import { defineConfig } from "vite";
import vinext from "vinext";
${cloudflare ? `import { cloudflare } from ${JSON.stringify(pathToFileURL(pluginPath).href)};` : ""}
export default defineConfig({ cacheDir: ".vite-cold-start", plugins: [${plugins.join(", ")}] });
`,
    );
    return root;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
