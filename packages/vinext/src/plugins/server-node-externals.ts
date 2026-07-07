import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

type ServerNodeExternalsOptions = {
  getAppDir: () => string | null;
  getPagesDir: () => string | null;
  getServerExternalPackages: () => readonly string[];
  getTranspilePackages: () => readonly string[];
  isEnabled: () => boolean;
};

type PackageMetadata = {
  type: string | null;
};

type ModuleOwnership = {
  app: boolean;
  pages: boolean;
};

const NODE_ESM_RELATIVE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

const FRAMEWORK_PACKAGE_NAMES = new Set([
  "@vitejs/plugin-react",
  "@vitejs/plugin-rsc",
  "react",
  "react-dom",
  "react-server-dom-webpack",
  "scheduler",
  "vite",
  "vinext",
]);

const BUNDLED_SERVER_PACKAGE_NAMES = new Set([
  // `next/og` delegates to @vercel/og through a Vinext shim. The package must
  // stay in Vite's graph so vinext:og-font-patch and vinext:og-assets can
  // rewrite/copy its WASM assets for Node and Workers.
  "@vercel/og",
]);

const MODULE_SPECIFIER_RE =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

const VINEXT_PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

const realpathCache = new Map<string, string>();

function realpathIfExists(filePath: string): string {
  const cached = realpathCache.get(filePath);
  if (cached !== undefined) return cached;

  let resolved = filePath;
  try {
    resolved = fs.realpathSync.native(filePath);
  } catch {
    // Virtual and not-yet-materialized paths should keep their original shape.
  }
  realpathCache.set(filePath, resolved);
  return resolved;
}

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
  if (first.startsWith("@")) {
    return second ? `${first}/${second}` : null;
  }
  return first;
}

function isFrameworkOrVinextRequest(id: string, packageName: string): boolean {
  return (
    FRAMEWORK_PACKAGE_NAMES.has(packageName) ||
    id === "next" ||
    id.startsWith("next/") ||
    id.startsWith("vinext/") ||
    id.startsWith("@vinext/")
  );
}

function isInsideDirectory(dir: string, filePath: string): boolean {
  const relative = path.relative(dir, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isVinextInternalFile(filePath: string): boolean {
  const realFilePath = realpathIfExists(filePath);
  const realVinextRoot = realpathIfExists(VINEXT_PACKAGE_ROOT);
  return realFilePath === realVinextRoot || isInsideDirectory(realVinextRoot, realFilePath);
}

function moduleOwnershipKey(environmentName: string, filePath: string): string {
  return `${environmentName}\0${filePath}`;
}

function directOwnershipForFile(
  filePath: string,
  appDir: string | null,
  pagesDir: string | null,
): ModuleOwnership | null {
  const realFilePath = realpathIfExists(filePath);
  const realAppDir = appDir ? realpathIfExists(appDir) : null;
  const realPagesDir = pagesDir ? realpathIfExists(pagesDir) : null;

  if (realAppDir && isInsideDirectory(realAppDir, realFilePath)) {
    return { app: true, pages: false };
  }
  if (realPagesDir && isInsideDirectory(realPagesDir, realFilePath)) {
    return { app: false, pages: true };
  }
  return null;
}

function mergeOwnership(
  ownershipByModule: Map<string, ModuleOwnership>,
  environmentName: string,
  filePath: string,
  ownership: ModuleOwnership | null,
): void {
  if (!ownership) return;
  // Route ownership should not leak onto vinext shims; their package imports
  // are framework runtime dependencies and must stay bundled by default.
  if (isVinextInternalFile(filePath)) return;

  const key = moduleOwnershipKey(environmentName, realpathIfExists(filePath));
  const current = ownershipByModule.get(key);
  ownershipByModule.set(key, {
    app: Boolean(current?.app || ownership.app),
    pages: Boolean(current?.pages || ownership.pages),
  });
}

function ownershipForImporter(
  importer: string | undefined,
  environmentName: string,
  appDir: string | null,
  pagesDir: string | null,
  ownershipByModule: Map<string, ModuleOwnership>,
): ModuleOwnership | null {
  if (!importer) return null;

  const cleanImporter = stripViteModuleQuery(importer);
  if (!path.isAbsolute(cleanImporter)) return null;

  const realImporter = realpathIfExists(cleanImporter);
  return (
    directOwnershipForFile(realImporter, appDir, pagesDir) ??
    ownershipByModule.get(moduleOwnershipKey(environmentName, realImporter)) ??
    null
  );
}

function isInNodeModules(filePath: string): boolean {
  return filePath.split(path.sep).includes("node_modules");
}

function findPackageJson(filePath: string): string | null {
  const parts = filePath.split(path.sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) return null;

  const packageNameStart = nodeModulesIndex + 1;
  const firstPackageSegment = parts[packageNameStart];
  if (!firstPackageSegment) return null;

  const packageRootEndExclusive = firstPackageSegment.startsWith("@")
    ? packageNameStart + 2
    : packageNameStart + 1;
  if (parts.length <= packageRootEndExclusive) return null;

  const packageRoot = parts.slice(0, packageRootEndExclusive).join(path.sep);
  const candidate = path.join(packageRoot, "package.json");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}

function readPackageMetadata(filePath: string): PackageMetadata | null {
  const packageJsonPath = findPackageJson(filePath);
  if (!packageJsonPath) return null;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const type =
      parsed && typeof parsed === "object" && "type" in parsed
        ? (parsed as { type?: unknown }).type
        : null;
    return {
      type: typeof type === "string" ? type : null,
    };
  } catch {
    return { type: null };
  }
}

function canNodeImportResolvedFile(filePath: string, metadata: PackageMetadata | null): boolean {
  const ext = path.extname(filePath);
  return ext === ".mjs" || (ext === ".js" && metadata?.type === "module");
}

function hasNodeUnsupportedRelativeImport(source: string): boolean {
  // This is intentionally an entry-file guard, not a complete graph analysis.
  // False positives keep packages bundled; false negatives are still bounded by
  // the Pages-only ownership check below.
  MODULE_SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MODULE_SPECIFIER_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier?.startsWith(".")) continue;

    const cleanSpecifier = specifier.split(/[?#]/)[0] ?? specifier;
    if (!NODE_ESM_RELATIVE_EXTENSIONS.has(path.extname(cleanSpecifier))) {
      return true;
    }
  }

  return false;
}

function shouldKeepBundledForNodeUnsupportedImports(filePath: string): boolean {
  try {
    return hasNodeUnsupportedRelativeImport(fs.readFileSync(filePath, "utf8"));
  } catch {
    return true;
  }
}

export function createServerNodeExternalsPlugin(options: ServerNodeExternalsOptions): Plugin {
  let command: "build" | "serve" = "serve";
  const nativeEsmCache = new Map<string, boolean>();
  const ownershipByModule = new Map<string, ModuleOwnership>();

  return {
    name: "vinext:server-node-externals",
    enforce: "pre",

    configResolved(config) {
      command = config.command;
    },

    async resolveId(id, importer) {
      if (command !== "build") return null;
      if (!options.isEnabled()) return null;
      if (this.environment?.name === "client") return null;

      const environmentName = this.environment?.name ?? "unknown";
      const appDir = options.getAppDir();
      const pagesDir = options.getPagesDir();
      const importerOwnership = ownershipForImporter(
        importer,
        environmentName,
        appDir,
        pagesDir,
        ownershipByModule,
      );

      if (!isBarePackageRequest(id)) {
        if (!importerOwnership) return null;

        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (!resolved || resolved.external) return null;

        const resolvedFile = realpathIfExists(stripViteModuleQuery(resolved.id));
        if (path.isAbsolute(resolvedFile)) {
          mergeOwnership(ownershipByModule, environmentName, resolvedFile, importerOwnership);
        }
        return null;
      }

      const packageName = getPackageName(id);
      if (!packageName) return null;
      if (isFrameworkOrVinextRequest(id, packageName)) return null;
      if (BUNDLED_SERVER_PACKAGE_NAMES.has(packageName)) return null;

      if (options.getTranspilePackages().includes(packageName)) return null;

      // Pages-only builds do not propagate next.config serverExternalPackages
      // through userSsrExternal, so keep this explicit resolver branch.
      if (options.getServerExternalPackages().includes(packageName)) {
        return { id, external: true };
      }

      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (!resolved || resolved.external) return null;

      const resolvedFile = realpathIfExists(stripViteModuleQuery(resolved.id));
      if (!path.isAbsolute(resolvedFile)) return null;

      mergeOwnership(ownershipByModule, environmentName, resolvedFile, importerOwnership);

      if (!pagesDir || !importerOwnership?.pages || importerOwnership.app) return null;
      if (!isInNodeModules(resolvedFile)) return null;

      const cached = nativeEsmCache.get(resolvedFile);
      if (cached !== undefined) {
        return cached ? { id, external: true } : null;
      }

      const metadata = readPackageMetadata(resolvedFile);
      const shouldExternalize =
        canNodeImportResolvedFile(resolvedFile, metadata) &&
        !shouldKeepBundledForNodeUnsupportedImports(resolvedFile);
      nativeEsmCache.set(resolvedFile, shouldExternalize);

      return shouldExternalize ? { id, external: true } : null;
    },
  };
}
