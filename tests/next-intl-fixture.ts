import fs from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function createNextIntlFixture({
  convention = "middleware",
  layout = "hoisted",
  cloudflare = true,
  requestConfig = true,
}: {
  convention?: string;
  layout?: string;
  cloudflare?: boolean;
  requestConfig?: boolean;
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
    if (!requestConfig) {
      await fs.rm(path.join(root, "i18n/request.ts"));
      await fs.rm(middlewarePath);
      const localeLayout = path.join(root, "app/[locale]/layout.tsx");
      await fs.writeFile(
        localeLayout,
        (await fs.readFile(localeLayout, "utf8"))
          .replace("hasLocale, NextIntlClientProvider", "NextIntlClientProvider")
          .replace('import { getMessages } from "next-intl/server";', "")
          .replace("hasLocale(locales, locale)", "locales.includes(locale as any)")
          .replace(
            "await getMessages()",
            "(await import(`@vinext-test/next-intl/locales/${locale}.json`)).default",
          )
          .replace(
            "messages={messages}",
            'messages={messages} locale={locale} formats={{}} now={new Date(0)} timeZone="UTC"',
          ),
      );
      const page = path.join(root, "app/[locale]/page.tsx");
      await fs.writeFile(
        page,
        (await fs.readFile(page, "utf8"))
          .replace(
            'import { getTranslations, setRequestLocale } from "next-intl/server";',
            'import { createTranslator } from "next-intl";',
          )
          .replace('import { Link } from "../../i18n/navigation";', 'import Link from "next/link";')
          .replace("setRequestLocale(locale);", "")
          .replace(
            'await getTranslations("HomePage")',
            'createTranslator({ locale, messages: (await import(`@vinext-test/next-intl/locales/${locale}.json`)).default, namespace: "HomePage" })',
          )
          .replace('href="/" locale="de"', 'href="/de"'),
      );
    }
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
