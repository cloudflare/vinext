import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

type PagesNodeExternalsOptions = {
  getRoot: () => string;
  getPagesDir: () => string | null;
  getEsmExternals: () => boolean | "loose";
  getBundlePagesRouterDependencies: () => boolean;
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

const MODULE_SPECIFIER_RE =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const STATIC_REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function isBarePackageRequest(id: string): boolean {
  return (
    id !== "" &&
    id[0] !== "." &&
    id[0] !== "/" &&
    id[0] !== "\0" &&
    !id.includes(":") &&
    !path.isAbsolute(id)
  );
}

function getPackageName(id: string): string | null {
  const [first, second] = id.split("/");
  if (!first) return null;
  return first.startsWith("@") ? (second ? `${first}/${second}` : null) : first;
}

function isInsideDirectory(directory: string, file: string): boolean {
  const relative = path.relative(realpathIfExists(directory), realpathIfExists(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathIfExists(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
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

function hasNodeUnsupportedRelativeImport(file: string): boolean {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return true;
  }

  MODULE_SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MODULE_SPECIFIER_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier?.startsWith(".")) continue;
    const extension = path.extname(specifier.split(/[?#]/, 1)[0] ?? specifier);
    if (!extension) return true;
  }
  return false;
}

export function createPagesNodeExternalsPlugin(options: PagesNodeExternalsOptions): Plugin {
  let isBuild = false;
  const pagesOwnedModules = new Set<string>();
  const nativeEsmCache = new Map<string, boolean>();
  const requireRequestsByImporter = new Map<string, Set<string>>();

  return {
    name: "vinext:pages-node-externals",
    enforce: "pre",

    configResolved(config) {
      isBuild = config.command === "build";
    },

    transform: {
      order: "pre",
      handler(code, id) {
        if (!isBuild || !options.isEnabled() || this.environment?.name === "client") return null;
        if (!code.includes("require")) return null;

        const requests = new Set<string>();
        STATIC_REQUIRE_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = STATIC_REQUIRE_RE.exec(code)) !== null) {
          const request = match[1];
          if (request && isBarePackageRequest(request)) requests.add(request);
        }
        if (requests.size > 0) {
          requireRequestsByImporter.set(realpathIfExists(stripViteModuleQuery(id)), requests);
        }
        return null;
      },
    },

    async resolveId(id, importer) {
      if (!isBuild || !options.isEnabled() || this.environment?.name === "client") return null;

      const pagesDir = options.getPagesDir();
      if (!pagesDir) return null;
      const cleanImporter = importer ? stripViteModuleQuery(importer) : null;
      const importerIsPagesOwned = Boolean(
        cleanImporter &&
        path.isAbsolute(cleanImporter) &&
        (isInsideDirectory(pagesDir, cleanImporter) || pagesOwnedModules.has(cleanImporter)),
      );

      if (!isBarePackageRequest(id)) {
        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (!resolved || resolved.external) return null;
        const cleanResolved = realpathIfExists(stripViteModuleQuery(resolved.id));
        if (
          path.isAbsolute(cleanResolved) &&
          (isInsideDirectory(pagesDir, cleanResolved) || importerIsPagesOwned)
        ) {
          pagesOwnedModules.add(cleanResolved);
        }
        return null;
      }

      if (!importerIsPagesOwned) return null;
      if (options.getEsmExternals() === false || options.getBundlePagesRouterDependencies()) {
        return null;
      }
      const packageName = getPackageName(id);
      if (!packageName) return null;
      if (
        FRAMEWORK_PACKAGES.has(packageName) ||
        id === "next" ||
        id.startsWith("next/") ||
        id.startsWith("vinext/") ||
        id.startsWith("@vinext/") ||
        options.getTranspilePackages().includes(packageName)
      ) {
        return null;
      }

      const canonicalImporter = cleanImporter ? realpathIfExists(cleanImporter) : null;
      const isRequireRequest = Boolean(
        canonicalImporter && requireRequestsByImporter.get(canonicalImporter)?.has(id),
      );
      if (isRequireRequest) {
        const requireFromImporter = createRequire(
          canonicalImporter ?? path.join(pagesDir, "index.js"),
        );
        const requireResolved = realpathIfExists(requireFromImporter.resolve(id));
        if (canNodeImport(requireResolved) && options.getEsmExternals() !== "loose") {
          throw new Error(
            `ESM packages (${id}) need to be imported. Use 'import' to reference the package instead. https://nextjs.org/docs/messages/import-esm-externals`,
          );
        }
        pagesOwnedModules.add(requireResolved);
        return canNodeImport(requireResolved) ? { id, external: true } : requireResolved;
      }

      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved || resolved.external) return null;
      const cleanResolved = realpathIfExists(stripViteModuleQuery(resolved.id));
      if (
        !path.isAbsolute(cleanResolved) ||
        !cleanResolved.includes(`${path.sep}node_modules${path.sep}`)
      ) {
        return null;
      }
      pagesOwnedModules.add(cleanResolved);

      let shouldExternalize = nativeEsmCache.get(cleanResolved);
      if (shouldExternalize === undefined) {
        shouldExternalize =
          canNodeImport(cleanResolved) && !hasNodeUnsupportedRelativeImport(cleanResolved);
        nativeEsmCache.set(cleanResolved, shouldExternalize);
      }
      if (shouldExternalize) {
        const rootImporter = path.join(options.getRoot(), "__vinext_external_resolve__.js");
        const rootResolved = await this.resolve(id, rootImporter, { skipSelf: true });
        const cleanRootResolved = rootResolved?.external
          ? null
          : rootResolved
            ? realpathIfExists(stripViteModuleQuery(rootResolved.id))
            : null;
        if (cleanRootResolved !== cleanResolved) return null;
        return { id, external: true };
      }

      try {
        const requireFromImporter = createRequire(cleanImporter ?? path.join(pagesDir, "index.js"));
        const requireResolved = realpathIfExists(requireFromImporter.resolve(id));
        if (requireResolved !== cleanResolved) {
          pagesOwnedModules.add(requireResolved);
          return requireResolved;
        }
      } catch {
        // Keep Vite's import-condition resolution when no require fallback exists.
      }
      return null;
    },
  };
}
