import { readFile as readFileFromFs } from "node:fs/promises";
import type { Plugin } from "vite";

type ReadPackageJson = (path: string) => Promise<string>;

type ClientReferenceDedupOptions = {
  readFile?: ReadPackageJson;
};

type PackageImportSpecifier = {
  packageName: string;
  specifier: string;
};

type PackagePath = {
  packageName: string;
  packageRoot: string;
  relativePath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReadPackageJson(path: string): Promise<string> {
  return readFileFromFs(path, "utf8");
}

function parsePackagePath(absolutePath: string): PackagePath | null {
  const marker = "/node_modules/";
  const lastIdx = absolutePath.lastIndexOf(marker);
  if (lastIdx === -1) return null;

  const rest = absolutePath.slice(lastIdx + marker.length);
  const parts = rest.split("/");
  const packagePartCount = rest.startsWith("@") ? 2 : 1;
  const packageParts = parts.slice(0, packagePartCount);

  if (packageParts.length < packagePartCount || packageParts.some((part) => part === "")) {
    return null;
  }

  const packageName = packageParts.join("/");
  const relativeParts = parts.slice(packagePartCount);

  return {
    packageName,
    packageRoot: absolutePath.slice(0, lastIdx + marker.length + packageName.length),
    relativePath: relativeParts.join("/"),
  };
}

/**
 * Extract the bare package name from an absolute file path containing node_modules.
 *
 * Handles scoped packages (`@org/name`) and nested node_modules.
 * Returns `null` if the path doesn't contain `/node_modules/`.
 */
export function extractPackageName(absolutePath: string): string | null {
  return parsePackagePath(absolutePath)?.packageName ?? null;
}

function normalizeExportTarget(target: string): string {
  return target.startsWith("./") ? target.slice(2) : target;
}

function matchExportTarget(target: string, relativePath: string): string | null {
  const normalizedTarget = normalizeExportTarget(target);
  const wildcardIndex = normalizedTarget.indexOf("*");

  if (wildcardIndex === -1) {
    return normalizedTarget === relativePath ? "" : null;
  }

  const beforeWildcard = normalizedTarget.slice(0, wildcardIndex);
  const afterWildcard = normalizedTarget.slice(wildcardIndex + 1);

  if (!relativePath.startsWith(beforeWildcard) || !relativePath.endsWith(afterWildcard)) {
    return null;
  }

  return relativePath.slice(beforeWildcard.length, relativePath.length - afterWildcard.length);
}

function exportKeyToSpecifier(
  packageName: string,
  exportKey: string,
  wildcardMatch: string,
): string {
  if (exportKey === ".") return packageName;

  const subpath = exportKey.startsWith("./") ? exportKey.slice(2) : exportKey;
  const resolvedSubpath = subpath.includes("*") ? subpath.replace("*", wildcardMatch) : subpath;

  return `${packageName}/${resolvedSubpath}`;
}

function collectExportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectExportTargets(entry));
  if (!isRecord(value)) return [];

  return Object.values(value).flatMap((entry) => collectExportTargets(entry));
}

function findExportSpecifier(
  packageName: string,
  exportsValue: unknown,
  relativePath: string,
): string | null {
  if (!isRecord(exportsValue)) {
    for (const target of collectExportTargets(exportsValue)) {
      const wildcardMatch = matchExportTarget(target, relativePath);
      if (wildcardMatch !== null) {
        return exportKeyToSpecifier(packageName, ".", wildcardMatch);
      }
    }
    return null;
  }

  const entries = Object.entries(exportsValue);
  const hasSubpathKeys = entries.some(([key]) => key === "." || key.startsWith("./"));
  if (!hasSubpathKeys) {
    for (const target of collectExportTargets(exportsValue)) {
      const wildcardMatch = matchExportTarget(target, relativePath);
      if (wildcardMatch !== null) {
        return exportKeyToSpecifier(packageName, ".", wildcardMatch);
      }
    }
    return null;
  }

  let bestMatch: { key: string; wildcard: string } | null = null;

  for (const [key, value] of entries) {
    if (key !== "." && !key.startsWith("./")) continue;

    for (const target of collectExportTargets(value)) {
      const wildcardMatch = matchExportTarget(target, relativePath);
      if (wildcardMatch === null) continue;

      if (!bestMatch || key.length > bestMatch.key.length) {
        bestMatch = { key, wildcard: wildcardMatch };
      }
    }
  }

  return bestMatch ? exportKeyToSpecifier(packageName, bestMatch.key, bestMatch.wildcard) : null;
}

function getLegacyEntry(packageJson: Record<string, unknown>): string {
  const browser = packageJson.browser;
  if (typeof browser === "string") return browser;

  const module = packageJson.module;
  if (typeof module === "string") return module;

  const main = packageJson.main;
  return typeof main === "string" ? main : "index.js";
}

function matchesLegacyEntry(legacyEntry: string, relativePath: string): boolean {
  const normalizedEntry = normalizeExportTarget(legacyEntry);
  return normalizedEntry === relativePath || `${normalizedEntry}.js` === relativePath;
}

/**
 * Convert an absolute package file path into the least lossy bare import
 * specifier that can be handed back to Vite's dependency optimizer.
 */
export async function extractPackageImportSpecifier(
  absolutePath: string,
  readPackageJson: ReadPackageJson = defaultReadPackageJson,
): Promise<PackageImportSpecifier | null> {
  const packagePath = parsePackagePath(absolutePath);
  if (!packagePath) return null;

  const { packageName, packageRoot, relativePath } = packagePath;
  if (relativePath === "") {
    return { packageName, specifier: packageName };
  }

  let packageJson: Record<string, unknown> | null = null;
  try {
    const rawPackageJson = await readPackageJson(`${packageRoot}/package.json`);
    const parsedPackageJson: unknown = JSON.parse(rawPackageJson);
    packageJson = isRecord(parsedPackageJson) ? parsedPackageJson : null;
  } catch {
    packageJson = null;
  }

  if (!packageJson) {
    return { packageName, specifier: packageName };
  }

  if ("exports" in packageJson) {
    const exportedSpecifier = findExportSpecifier(packageName, packageJson.exports, relativePath);
    return { packageName, specifier: exportedSpecifier ?? packageName };
  }

  const specifier = matchesLegacyEntry(getLegacyEntry(packageJson), relativePath)
    ? packageName
    : `${packageName}/${relativePath}`;

  return { packageName, specifier };
}

const DEDUP_PREFIX = "\0vinext:dedup/";
// oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
const DEDUP_FILTER = /^\0vinext:dedup\//;
const PROXY_MARKER = "virtual:vite-rsc/client-in-server-package-proxy/";

/**
 * Intercepts absolute node_modules path imports originating from RSC
 * `client-in-server-package-proxy` virtual modules in the client environment
 * and redirects them through bare specifier imports. This ensures the browser
 * loads the pre-bundled version (from `.vite/deps/`) rather than the raw ESM
 * file, preventing module duplication and broken React contexts.
 *
 * Dev-only — production builds use the SSR manifest which handles this correctly.
 */
export function clientReferenceDedupPlugin(options: ClientReferenceDedupOptions = {}): Plugin {
  let excludeSet = new Set<string>();
  const readPackageJson = options.readFile ?? defaultReadPackageJson;
  const packageImportCache = new Map<string, Promise<PackageImportSpecifier | null>>();

  return {
    name: "vinext:client-reference-dedup",
    enforce: "pre",
    apply: "serve",

    configResolved(config) {
      // Capture client environment's optimizeDeps.exclude so we don't
      // redirect packages the user explicitly opted out of pre-bundling.
      const clientExclude =
        config.environments?.client?.optimizeDeps?.exclude ?? config.optimizeDeps?.exclude ?? [];
      excludeSet = new Set(clientExclude);
    },

    resolveId: {
      filter: { id: /node_modules/ },
      async handler(id, importer) {
        // Only operate in the client environment
        if (this.environment?.name !== "client") return;

        // Only intercept imports from client-in-server-package-proxy modules
        if (!importer || !importer.includes(PROXY_MARKER)) return;

        // Only handle absolute paths through node_modules
        if (!id.startsWith("/") || !id.includes("/node_modules/")) return;

        const packageName = extractPackageName(id);
        if (!packageName) return;

        // Respect user's optimizeDeps.exclude
        if (excludeSet.has(packageName)) return;

        let packageImportPromise = packageImportCache.get(id);
        if (!packageImportPromise) {
          packageImportPromise = extractPackageImportSpecifier(id, readPackageJson);
          packageImportCache.set(id, packageImportPromise);
        }

        const packageImport = await packageImportPromise;
        if (!packageImport) return;
        if (excludeSet.has(packageImport.specifier)) return;

        return `${DEDUP_PREFIX}${packageImport.specifier}`;
      },
    },

    load: {
      filter: { id: DEDUP_FILTER },
      handler(id) {
        if (!id.startsWith(DEDUP_PREFIX)) return;

        const pkgName = id.slice(DEDUP_PREFIX.length);
        // Re-export via bare specifier — Vite's import analysis will resolve
        // this to the pre-bundled version in .vite/deps/
        // Note: if the package has no default export, `__all__.default` is
        // undefined, so this produces `export default undefined` — which matches
        // the RSC client-in-server-package-proxy behavior.
        return [
          `export * from ${JSON.stringify(pkgName)};`,
          `import * as __all__ from ${JSON.stringify(pkgName)};`,
          `export default __all__.default;`,
        ].join("\n");
      },
    },
  };
}
