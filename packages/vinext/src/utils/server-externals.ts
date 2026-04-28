import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_NODE_NATIVE_SERVER_EXTERNALS = ["better-sqlite3", "sqlite3", "typescript"];

type PackageExportsValue =
  | string
  | string[]
  | {
      [conditionOrSubpath: string]: PackageExportsValue | undefined;
    };

function parseBarePackageSpecifier(
  specifier: string,
): { packageName: string; exportKey: string } | null {
  const packageName = getBarePackageName(specifier);
  if (!packageName) return null;
  const subpath = specifier.slice(packageName.length);
  return {
    packageName,
    exportKey: subpath ? `.${subpath}` : ".",
  };
}

function getBarePackageName(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.startsWith("\0") ||
    specifier.includes(":")
  ) {
    return null;
  }

  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!packageName || (specifier.startsWith("@") && parts.length < 2)) {
    return null;
  }
  return packageName;
}

export function mergeServerExternalPackages(
  userExternal: string[] | true | undefined,
  nextServerExternal: string[],
): string[] | true {
  if (userExternal === true) return true;

  return [
    ...new Set([
      ...DEFAULT_NODE_NATIVE_SERVER_EXTERNALS,
      ...(Array.isArray(userExternal) ? userExternal : []),
      ...nextServerExternal,
    ]),
  ];
}

function findPackageJsonFromResolvedFile(resolvedFile: string): string | null {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function pickConditionalExportTarget(
  value: PackageExportsValue | undefined,
  activeConditions: Set<string>,
): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = pickConditionalExportTarget(item, activeConditions);
      if (resolved) return resolved;
    }
    return null;
  }

  for (const [condition, target] of Object.entries(value)) {
    if (condition === "types") continue;
    if (condition === "default" || activeConditions.has(condition)) {
      const resolved = pickConditionalExportTarget(target, activeConditions);
      if (resolved) return resolved;
    }
  }

  return null;
}

function resolveServerExternalImportExport(
  specifier: string,
  importerPath: string,
  projectRoot: string,
): string | null {
  const parsed = parseBarePackageSpecifier(specifier);
  if (!parsed) return null;

  let packageJsonPath: string | null = null;
  try {
    packageJsonPath = findPackageJsonFromResolvedFile(
      createRequire(importerPath).resolve(specifier),
    );
  } catch {}

  if (!packageJsonPath) {
    try {
      packageJsonPath = findPackageJsonFromResolvedFile(
        createRequire(path.join(projectRoot, "package.json")).resolve(specifier),
      );
    } catch {}
  }

  if (!packageJsonPath) return null;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      exports?: PackageExportsValue;
    };
    if (!packageJson.exports) return null;

    const exportsValue = packageJson.exports;
    const exportValue =
      typeof exportsValue === "object" &&
      !Array.isArray(exportsValue) &&
      Object.keys(exportsValue).some((key) => key.startsWith("."))
        ? exportsValue[parsed.exportKey]
        : parsed.exportKey === "."
          ? exportsValue
          : undefined;
    const target = pickConditionalExportTarget(
      exportValue,
      new Set(["node", "import", "module", "default"]),
    );
    if (!target || !target.startsWith(".")) return null;
    return path.resolve(path.dirname(packageJsonPath), target);
  } catch {
    return null;
  }
}

export function resolveServerExternalPackageImport(
  specifier: string,
  importer: string | undefined,
  externalPackages: readonly string[],
  projectRoot: string,
): string | null {
  if (specifier.endsWith("/package.json")) {
    return null;
  }

  const packageName = getBarePackageName(specifier);
  if (!packageName || !externalPackages.includes(packageName)) {
    return null;
  }

  const importerPath =
    importer &&
    !importer.startsWith("\0") &&
    !importer.includes("virtual:") &&
    path.isAbsolute(importer)
      ? importer
      : path.join(projectRoot, "package.json");

  try {
    const conditionalResolved = resolveServerExternalImportExport(
      specifier,
      importerPath,
      projectRoot,
    );
    return conditionalResolved ?? createRequire(importerPath).resolve(specifier);
  } catch {}

  try {
    return createRequire(path.join(projectRoot, "package.json")).resolve(specifier);
  } catch {
    return null;
  }
}
