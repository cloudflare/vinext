import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Alias } from "vite";

const realpathNative = promisify(fs.realpath.native);

type IndexedAlias = Alias & { index: number };

export type OgAssetModuleBoundary = {
  assetRoot: string;
  moduleDir: string;
};

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

async function findPackageRoot(
  moduleDir: string,
  expectedPackageName?: string,
): Promise<string | null> {
  let currentDir = moduleDir;
  while (true) {
    try {
      const packageJsonPath = path.join(currentDir, "package.json");
      const packageJson = await fs.promises.stat(packageJsonPath);
      if (packageJson.isFile()) {
        const manifest = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf8"));
        return expectedPackageName === undefined || manifest.name === expectedPackageName
          ? currentDir
          : null;
      }
    } catch {}

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function getPackageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\0") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] || null;
}

function getAliasedPackageName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const alias = value.match(/^(?:npm:|workspace:)(@[^/]+\/[^@]+|[^@*~^]+)(?:@|$)/);
  return alias?.[1] ?? null;
}

function aliasMatches(find: string | RegExp, source: string): boolean {
  if (typeof find === "string") return source === find || source.startsWith(`${find}/`);
  find.lastIndex = 0;
  return find.test(source);
}

function applyAlias(find: string | RegExp, replacement: string, source: string): string {
  if (typeof find === "string") return replacement + source.slice(find.length);
  find.lastIndex = 0;
  return source.replace(find, replacement);
}

function getNodeModulesPackageRoot(
  logicalProjectRoot: string,
  logicalModulePath: string,
): string | null {
  const isProjectPath = isPathInside(logicalProjectRoot, logicalModulePath);
  const parsedPath = path.parse(logicalModulePath);
  const baseRoot = isProjectPath ? logicalProjectRoot : parsedPath.root;
  const relativePath = isProjectPath
    ? path.relative(logicalProjectRoot, logicalModulePath)
    : logicalModulePath.slice(parsedPath.root.length);
  const segments = relativePath.split(path.sep);
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) return null;

  const packageSegment = segments[nodeModulesIndex + 1];
  if (!packageSegment) return null;
  const packageSegmentCount = packageSegment.startsWith("@") ? 2 : 1;
  if (segments.length <= nodeModulesIndex + packageSegmentCount) return null;
  if (packageSegmentCount === 2 && !segments[nodeModulesIndex + 2]) return null;

  return path.join(baseRoot, ...segments.slice(0, nodeModulesIndex + 1 + packageSegmentCount));
}

async function readPackageName(packageRoot: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    return typeof manifest.name === "string" ? manifest.name : null;
  } catch {
    return null;
  }
}

async function packageOwnsAliasFile(
  packageRoot: string,
  packageName: string | null,
  aliasFile: string,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (packageName !== null && manifest.name === packageName) return true;
    return ["main", "module", "source", "browser"].some(
      (field) =>
        typeof manifest[field] === "string" &&
        path.resolve(packageRoot, manifest[field]) === aliasFile,
    );
  } catch {
    return false;
  }
}

async function packageOwnsAliasDirectory(
  packageRoot: string,
  packageName: string | null,
  aliasDirectory: string,
): Promise<boolean> {
  if (aliasDirectory === packageRoot) return true;
  try {
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (packageName !== null && manifest.name === packageName) return true;
    return ["main", "module", "source", "browser"].some(
      (field) =>
        typeof manifest[field] === "string" &&
        isPathInside(aliasDirectory, path.resolve(packageRoot, manifest[field])),
    );
  } catch {
    return false;
  }
}

export class OgAssetOwnership {
  private projectRoot = process.cwd();
  private readonly linkedPackageRoots = new Set<string>();
  private readonly dependencyPackageNames = new Map<string, string>();
  private readonly stringAliasesByFirstCharacter = new Map<string, IndexedAlias[]>();
  private regularExpressionAliases: IndexedAlias[] = [];
  private configuredAliases: IndexedAlias[] = [];

  configure(projectRoot: string, aliases: readonly Alias[]): void {
    this.projectRoot = path.resolve(projectRoot);
    this.dependencyPackageNames.clear();
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(this.projectRoot, "package.json"), "utf8"),
      );
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const dependencies = manifest[field];
        if (dependencies === null || typeof dependencies !== "object") continue;
        for (const [packageName, value] of Object.entries(dependencies)) {
          this.dependencyPackageNames.set(packageName, getAliasedPackageName(value) ?? packageName);
        }
      }
    } catch {}

    this.stringAliasesByFirstCharacter.clear();
    this.regularExpressionAliases = [];
    this.configuredAliases = [];
    for (const [index, alias] of aliases.entries()) {
      const indexedAlias = { ...alias, index };
      this.configuredAliases.push(indexedAlias);
      if (typeof alias.find === "string") {
        const firstCharacter = alias.find[0];
        if (firstCharacter === undefined) continue;
        const matchingAliases = this.stringAliasesByFirstCharacter.get(firstCharacter) ?? [];
        matchingAliases.push(indexedAlias);
        this.stringAliasesByFirstCharacter.set(firstCharacter, matchingAliases);
      } else {
        this.regularExpressionAliases.push(indexedAlias);
      }
    }
  }

  reset(): void {
    this.linkedPackageRoots.clear();
  }

  shouldTrackImport(source: string): boolean {
    return (
      this.findAlias(source) !== undefined || this.getExpectedPackageName(source) !== undefined
    );
  }

  async recordResolvedImport(source: string, resolvedId: string): Promise<void> {
    const configuredAlias = this.findAlias(source);
    const sourcePackageName = getPackageNameFromSpecifier(source);
    const expectedPackageName = this.getExpectedPackageName(source);
    if (configuredAlias === undefined && expectedPackageName === undefined) return;

    let realResolvedPath: string;
    try {
      realResolvedPath = await realpathNative(path.resolve(resolvedId.split("?")[0]));
    } catch {
      return;
    }

    let packageRoot: string | null;
    if (configuredAlias !== undefined) {
      packageRoot = await this.resolveAliasPackageRoot(
        configuredAlias,
        source,
        sourcePackageName,
        realResolvedPath,
      );
    } else {
      packageRoot = await findPackageRoot(path.dirname(realResolvedPath), expectedPackageName);
    }
    if (packageRoot !== null) this.linkedPackageRoots.add(packageRoot);
  }

  async resolveModuleBoundary(moduleId: string): Promise<OgAssetModuleBoundary | null> {
    const modulePath = path.resolve(moduleId.split("?")[0]);
    let realProjectRoot: string;
    let realModulePath: string;
    try {
      [realProjectRoot, realModulePath] = await Promise.all([
        realpathNative(this.projectRoot),
        realpathNative(modulePath),
      ]);
    } catch {
      try {
        realProjectRoot = await realpathNative(this.projectRoot);
        const realModuleDir = await realpathNative(path.dirname(modulePath));
        realModulePath = path.join(realModuleDir, path.basename(modulePath));
      } catch {
        return null;
      }
    }

    const moduleDir = path.dirname(realModulePath);
    const logicalPackageRoot = getNodeModulesPackageRoot(this.projectRoot, modulePath);
    if (logicalPackageRoot !== null) {
      let realPackageRoot: string;
      try {
        realPackageRoot = await realpathNative(logicalPackageRoot);
      } catch {
        return null;
      }
      if (isPathInside(realPackageRoot, realModulePath)) {
        return { assetRoot: realPackageRoot, moduleDir };
      }

      const declaredPackageName = await readPackageName(logicalPackageRoot);
      if (declaredPackageName === null) return null;
      const logicalModuleRelativePath = path.relative(logicalPackageRoot, modulePath);
      if (
        path.isAbsolute(logicalModuleRelativePath) ||
        logicalModuleRelativePath === ".." ||
        logicalModuleRelativePath.startsWith(`..${path.sep}`)
      ) {
        return null;
      }
      const canonicalPackageRoot = await findPackageRoot(moduleDir, declaredPackageName);
      if (canonicalPackageRoot === null) return null;
      if (path.relative(canonicalPackageRoot, realModulePath) !== logicalModuleRelativePath) {
        return null;
      }
      return { assetRoot: canonicalPackageRoot, moduleDir };
    }

    if (isPathInside(realProjectRoot, realModulePath)) {
      return { assetRoot: realProjectRoot, moduleDir };
    }

    const linkedPackageRoot = [...this.linkedPackageRoots]
      .filter((root) => isPathInside(root, realModulePath))
      .sort((a, b) => b.length - a.length)[0];
    if (linkedPackageRoot !== undefined) {
      return { assetRoot: linkedPackageRoot, moduleDir };
    }

    const configuredAliasRoot = await this.resolveConfiguredAliasRoot(realModulePath);
    return configuredAliasRoot === null ? null : { assetRoot: configuredAliasRoot, moduleDir };
  }

  async resolveContainedAsset(assetRoot: string, assetPath: string): Promise<string | null> {
    try {
      const realPath = await realpathNative(assetPath);
      return isPathInside(assetRoot, realPath) ? realPath : null;
    } catch {
      return null;
    }
  }

  private findAlias(source: string): IndexedAlias | undefined {
    return [
      ...(this.stringAliasesByFirstCharacter.get(source[0] ?? "") ?? []),
      ...this.regularExpressionAliases,
    ]
      .filter((alias) => aliasMatches(alias.find, source))
      .sort((a, b) => a.index - b.index)[0];
  }

  private getExpectedPackageName(source: string): string | undefined {
    const packageName = getPackageNameFromSpecifier(source);
    return packageName === null ? undefined : this.dependencyPackageNames.get(packageName);
  }

  private async resolveAliasPackageRoot(
    alias: IndexedAlias,
    source: string,
    sourcePackageName: string | null,
    realResolvedPath: string,
  ): Promise<string | null> {
    const aliasTarget = applyAlias(alias.find, alias.replacement, source);
    if (!path.isAbsolute(aliasTarget)) return null;
    try {
      const realAliasTarget = await realpathNative(aliasTarget);
      const aliasTargetStat = await fs.promises.stat(realAliasTarget);
      const hasCapture = alias.find instanceof RegExp && alias.replacement.includes("$");
      let configuredDirectory: string | null = null;
      if (!hasCapture) {
        const realReplacement = await realpathNative(alias.replacement);
        const replacementStat = await fs.promises.stat(realReplacement);
        if (replacementStat.isDirectory()) configuredDirectory = realReplacement;
      }
      if (configuredDirectory !== null || aliasTargetStat.isDirectory()) {
        const aliasBoundary = configuredDirectory ?? realAliasTarget;
        const packageRoot = await findPackageRoot(path.dirname(realResolvedPath));
        if (
          packageRoot === null ||
          !isPathInside(aliasBoundary, packageRoot) ||
          !isPathInside(packageRoot, realResolvedPath)
        ) {
          return null;
        }
        return packageRoot;
      }

      const packageRoot = await findPackageRoot(path.dirname(realResolvedPath));
      if (
        packageRoot === null ||
        !(await packageOwnsAliasFile(packageRoot, sourcePackageName, realAliasTarget)) ||
        !isPathInside(packageRoot, realResolvedPath)
      ) {
        return null;
      }
      return packageRoot;
    } catch {
      return null;
    }
  }

  private async resolveConfiguredAliasRoot(realModulePath: string): Promise<string | null> {
    const packageRoot = await findPackageRoot(path.dirname(realModulePath));
    if (packageRoot === null || !isPathInside(packageRoot, realModulePath)) return null;

    for (const alias of this.configuredAliases) {
      if (!path.isAbsolute(alias.replacement)) continue;
      const packageName =
        typeof alias.find === "string" ? getPackageNameFromSpecifier(alias.find) : null;

      const captureIndex = alias.replacement.indexOf("$");
      if (captureIndex !== -1) {
        const packageManifestName = await readPackageName(packageRoot);
        if (packageManifestName === null || !aliasMatches(alias.find, packageManifestName))
          continue;
        const aliasTarget = applyAlias(alias.find, alias.replacement, packageManifestName);
        if (!path.isAbsolute(aliasTarget)) continue;
        try {
          const realAliasTarget = await realpathNative(aliasTarget);
          const aliasTargetStat = await fs.promises.stat(realAliasTarget);
          if (
            (aliasTargetStat.isDirectory() && isPathInside(realAliasTarget, realModulePath)) ||
            (aliasTargetStat.isFile() && realAliasTarget === realModulePath)
          ) {
            return packageRoot;
          }
        } catch {}
        continue;
      }

      try {
        const realReplacement = await realpathNative(alias.replacement);
        const replacementStat = await fs.promises.stat(realReplacement);
        if (replacementStat.isDirectory()) {
          if (
            isPathInside(packageRoot, realReplacement) &&
            isPathInside(realReplacement, realModulePath) &&
            (await packageOwnsAliasDirectory(packageRoot, packageName, realReplacement))
          ) {
            return packageRoot;
          }
          continue;
        }

        if (
          realReplacement === realModulePath &&
          (await packageOwnsAliasFile(packageRoot, packageName, realReplacement))
        ) {
          return packageRoot;
        }
      } catch {}
    }

    return null;
  }
}
