import fs from "node:fs";
import path, { toSlash } from "pathslash";
import type { Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

type PagesNodeExternalsOptions = {
  getRoot: () => string;
  getPagesDir: () => string | null;
  getAliases: () => Readonly<Record<string, string>>;
  getTranspilePackages: () => readonly string[];
  isEnabled: () => boolean;
};

const FRAMEWORK_PACKAGES = new Set([
  "@vitejs/plugin-react",
  "@vitejs/plugin-rsc",
  "react",
  "react-dom",
  "react-server-dom-webpack",
  "scheduler",
  "vite",
  "vinext",
]);

function packageNameFromSpecifier(id: string): string | null {
  const [first, second] = id.split("/");
  if (!first) return null;
  return first.startsWith("@") ? (second ? `${first}/${second}` : null) : first;
}

function canonicalFile(id: string): string {
  const cleanId = toSlash(stripViteModuleQuery(id));
  try {
    return toSlash(fs.realpathSync.native(cleanId));
  } catch {
    return cleanId;
  }
}

function isInsideDirectory(directory: string, file: string): boolean {
  const relative = path.relative(canonicalFile(directory), canonicalFile(file));
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function findPackageJson(file: string): string | null {
  let directory = path.dirname(file);
  while (true) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory || path.basename(directory) === "node_modules") return null;
    directory = parent;
  }
}

function canNodeImport(file: string): boolean {
  const extension = path.extname(file);
  if (extension === ".mjs") return true;
  if (extension !== ".js") return false;

  const packageJson = findPackageJson(file);
  if (!packageJson) return false;
  try {
    return (
      (JSON.parse(fs.readFileSync(packageJson, "utf8")) as { type?: unknown }).type === "module"
    );
  } catch {
    return false;
  }
}

function matchesAlias(id: string, aliases: Readonly<Record<string, string>>): boolean {
  return Object.keys(aliases).some((alias) => id === alias || id.startsWith(`${alias}/`));
}

/**
 * Externalize native ESM dependencies reached from Pages Router files.
 *
 * Next.js and Vite both resolve ESM imports through the package's `import`
 * condition. Keeping a native ESM entry external preserves that condition at
 * runtime and avoids traversing implementation-only dynamic imports during the
 * server build. A `.js` entry in a CommonJS package is deliberately left in
 * Vite's graph: Node cannot import it as ESM, while Rolldown can bundle the
 * selected `import` export just like Turbopack.
 */
export function createPagesNodeExternalsPlugin(options: PagesNodeExternalsOptions): Plugin {
  const pagesOwnedModules = new Set<string>();

  return {
    name: "vinext:pages-node-externals",
    enforce: "pre",
    resolveId: {
      // Only relative modules (for Pages ownership propagation) and bare
      // package requests need this rule. Absolute and virtual ids stay out of
      // the JavaScript hook entirely.
      filter: { id: /^(?:\.\.?\/|(?![./\\]|[a-zA-Z][\w+.-]*:)[\w@])/ },
      async handler(id, importer) {
        if (!options.isEnabled() || this.environment?.name === "client" || !importer) return null;

        const pagesDir = options.getPagesDir();
        const cleanImporter = canonicalFile(importer);
        const importerIsPagesOwned = Boolean(
          pagesDir &&
          path.isAbsolute(cleanImporter) &&
          (isInsideDirectory(pagesDir, cleanImporter) || pagesOwnedModules.has(cleanImporter)),
        );
        if (!importerIsPagesOwned) {
          return null;
        }

        if (id.startsWith(".")) {
          const resolved = await this.resolve(id, importer, { skipSelf: true });
          if (resolved && !resolved.external) pagesOwnedModules.add(canonicalFile(resolved.id));
          return null;
        }

        const packageName = packageNameFromSpecifier(id);
        if (
          !packageName ||
          FRAMEWORK_PACKAGES.has(packageName) ||
          id === "next" ||
          id.startsWith("next/") ||
          id.startsWith("vinext/") ||
          id.startsWith("@vinext/") ||
          options.getTranspilePackages().includes(packageName)
        ) {
          return null;
        }

        if (matchesAlias(id, options.getAliases())) {
          const aliased = await this.resolve(id, importer, { skipSelf: true });
          if (aliased && !aliased.external) {
            const aliasedFile = canonicalFile(aliased.id);
            if (path.isAbsolute(aliasedFile) && !aliasedFile.includes("/node_modules/")) {
              pagesOwnedModules.add(aliasedFile);
            }
          }
          return null;
        }

        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (!resolved || resolved.external) return null;
        const resolvedFile = canonicalFile(resolved.id);
        if (!path.isAbsolute(resolvedFile) || !resolvedFile.includes("/node_modules/")) return null;
        if (!canNodeImport(resolvedFile)) return null;

        // A nested dependency must stay bundled when resolving the same request
        // from the app root selects another installed version. External output
        // is relocated next to the root node_modules tree at runtime.
        const rootImporter = path.join(options.getRoot(), "__vinext_external_resolve__.js");
        const rootResolved = await this.resolve(id, rootImporter, { skipSelf: true });
        if (
          !rootResolved ||
          rootResolved.external ||
          canonicalFile(rootResolved.id) !== resolvedFile
        ) {
          return null;
        }

        return { id, external: true };
      },
    },
  };
}
