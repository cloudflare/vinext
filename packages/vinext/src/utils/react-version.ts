import fs from "node:fs";
import { createRequire } from "node:module";
import path from "pathslash";

type DependencyMap = Record<string, string>;
type ProjectPackageJson = {
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
};

type InstalledPackage = {
  root: string;
  version: string;
};

const RSDW_PACKAGE = "react-server-dom-webpack";
const PLUGIN_RSC_VENDOR_CLIENT = "@vitejs/plugin-rsc/vendor/react-server-dom/client.browser";
// @vitejs/plugin-rsc 0.5.34, vinext's minimum supported release, vendors this
// React Flight version. Keep the floor available when `vinext init --install=false`
// runs before the optional plugin has been installed.
const MINIMUM_PLUGIN_RSC_VENDOR_REACT_VERSION: [number, number, number] = [19, 2, 8];
const EXACT_VERSION_RE = /^=?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function readProjectPackage(root: string): ProjectPackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function getDeclaredVersion(pkg: ProjectPackageJson | null, dependency: string): string | null {
  if (!pkg) return null;
  return (
    pkg.dependencies?.[dependency] ??
    pkg.devDependencies?.[dependency] ??
    pkg.optionalDependencies?.[dependency] ??
    pkg.peerDependencies?.[dependency] ??
    null
  );
}

function parseExactVersion(specifier: string | null): string | null {
  if (!specifier) return null;
  return EXACT_VERSION_RE.exec(specifier)?.[1] ?? null;
}

function getInstalledPackage(
  root: string,
  dependency: string,
  packageName = dependency,
): InstalledPackage | null {
  const req = createRequire(path.join(root, "package.json"));
  try {
    return findPackage(req.resolve(dependency), packageName);
  } catch {
    return null;
  }
}

function parseVersionTuple(version: string): [major: number, minor: number, patch: number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersionTuples(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function getVendoredReactVersion(
  root: string,
  vendoredRuntimeRoot?: string | null,
): [major: number, minor: number, patch: number] | null {
  let version: string | null = null;
  if (vendoredRuntimeRoot) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(vendoredRuntimeRoot, "package.json"), "utf8"),
      );
      version = typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      // Fall through to root-based package resolution.
    }
  }
  // An explicit null lets callers and tests represent a plugin that is known
  // to be unavailable. Undefined retains the normal project/self lookup.
  if (!version && vendoredRuntimeRoot !== null) {
    version = getInstalledPackage(root, PLUGIN_RSC_VENDOR_CLIENT, RSDW_PACKAGE)?.version ?? null;
  }
  if (!version && vendoredRuntimeRoot !== null) {
    try {
      const resolvedEntry = createRequire(import.meta.url).resolve(PLUGIN_RSC_VENDOR_CLIENT);
      version = findPackage(resolvedEntry, RSDW_PACKAGE)?.version ?? null;
    } catch {
      // The optional RSC plugin may not be installed yet during `vinext init`.
    }
  }
  return parseVersionTuple(version ?? "") ?? MINIMUM_PLUGIN_RSC_VENDOR_REACT_VERSION;
}

function getEffectiveVersion(
  installed: InstalledPackage | null,
  pkg: ProjectPackageJson | null,
  dependency: string,
): string | null {
  return installed?.version ?? parseExactVersion(getDeclaredVersion(pkg, dependency));
}

/**
 * Return dependencies needed to align React with the App Router Flight runtime.
 *
 * Stable React uses plugin-rsc's vendored runtime by default. Prerelease React
 * needs the exact matching RSDW release because its internal protocol may
 * differ from the stable vendor. An explicit app-level RSDW declaration opts
 * into plugin-rsc's override path, but the installed React, ReactDOM, and RSDW
 * versions must still form an exact release trio.
 */
export function getReactUpgradeDeps(root: string, vendoredRuntimeRoot?: string | null): string[] {
  const pkg = readProjectPackage(root);
  const declaredRsdwSpecifier =
    pkg?.dependencies?.[RSDW_PACKAGE] ?? pkg?.devDependencies?.[RSDW_PACKAGE] ?? null;
  const rsdwIsShadowed = pkg?.optionalDependencies?.[RSDW_PACKAGE] !== undefined;

  const installedReact = getInstalledPackage(root, "react");
  const installedReactDom = getInstalledPackage(root, "react-dom");
  const reactVersion = getEffectiveVersion(installedReact, pkg, "react");
  const reactDomVersion = getEffectiveVersion(installedReactDom, pkg, "react-dom");

  if (declaredRsdwSpecifier !== null) {
    const installedRsdw = getInstalledPackage(root, RSDW_PACKAGE);
    const targetVersion =
      parseExactVersion(declaredRsdwSpecifier) ??
      installedRsdw?.version ??
      reactVersion ??
      reactDomVersion;

    // A non-exact declaration with no installed packages cannot be aligned to
    // a release yet, but it must still be installed instead of being mistaken
    // for a usable override.
    if (!targetVersion) {
      return [`${RSDW_PACKAGE}@${declaredRsdwSpecifier}`];
    }

    const upgrades: string[] = [];
    if (reactVersion !== targetVersion) upgrades.push(`react@${targetVersion}`);
    if (reactDomVersion !== targetVersion) upgrades.push(`react-dom@${targetVersion}`);
    if (installedRsdw?.version !== targetVersion || rsdwIsShadowed) {
      upgrades.push(`${RSDW_PACKAGE}@${targetVersion}`);
    }
    return upgrades;
  }

  if (!reactVersion) return [];

  const prereleaseVersion = [reactVersion, reactDomVersion].find((version) =>
    version?.includes("-"),
  );
  if (prereleaseVersion) {
    if (
      reactVersion !== prereleaseVersion ||
      (reactDomVersion !== null && reactDomVersion !== prereleaseVersion)
    ) {
      return [
        `react@${prereleaseVersion}`,
        `react-dom@${prereleaseVersion}`,
        `${RSDW_PACKAGE}@${prereleaseVersion}`,
      ];
    }
    return [`${RSDW_PACKAGE}@${prereleaseVersion}`];
  }

  const vendoredReactVersion = getVendoredReactVersion(root, vendoredRuntimeRoot);
  if (reactDomVersion && reactVersion !== reactDomVersion) {
    const reactTuple = parseVersionTuple(reactVersion);
    const reactDomTuple = parseVersionTuple(reactDomVersion);
    const targetVersion =
      reactTuple && reactDomTuple && compareVersionTuples(reactTuple, reactDomTuple) < 0
        ? reactDomVersion
        : reactVersion;
    const targetTuple = parseVersionTuple(targetVersion);
    if (
      vendoredReactVersion &&
      (!targetTuple || compareVersionTuples(targetTuple, vendoredReactVersion) < 0)
    ) {
      return ["react@latest", "react-dom@latest"];
    }
    const upgrades: string[] = [];
    if (reactVersion !== targetVersion) upgrades.push(`react@${targetVersion}`);
    if (reactDomVersion !== targetVersion) upgrades.push(`react-dom@${targetVersion}`);
    return upgrades;
  }

  return vendoredReactVersion &&
    (isVersionBelow(reactVersion, vendoredReactVersion) ||
      (reactDomVersion !== null && isVersionBelow(reactDomVersion, vendoredReactVersion)))
    ? ["react@latest", "react-dom@latest"]
    : [];
}

/** Resolve the installed, validated app-level RSDW override package root. */
export function resolveReactServerDomWebpackOverride(root: string): string | null {
  const pkg = readProjectPackage(root);
  const hasExplicitOverride =
    pkg?.dependencies?.[RSDW_PACKAGE] !== undefined ||
    pkg?.devDependencies?.[RSDW_PACKAGE] !== undefined;
  if (!hasExplicitOverride || pkg?.optionalDependencies?.[RSDW_PACKAGE] !== undefined) return null;
  if (getReactUpgradeDeps(root).length > 0) return null;
  return getInstalledPackage(root, RSDW_PACKAGE)?.root ?? null;
}

function isVersionBelow(version: string, minimum: [number, number, number]): boolean {
  const current = version.split(".").map((part) => parseInt(part, 10));
  for (let index = 0; index < minimum.length; index++) {
    if ((current[index] ?? 0) !== minimum[index]) return (current[index] ?? 0) < minimum[index];
  }
  return false;
}

/** Walk up from a resolved module entry to find its package root and version. */
function findPackage(resolvedEntry: string, packageName: string): InstalledPackage | null {
  let dir = path.dirname(resolvedEntry);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (pkg.name === packageName && typeof pkg.version === "string") {
        return { root: dir, version: pkg.version };
      }
    } catch {
      // no package.json at this level, keep walking up
    }
    dir = path.dirname(dir);
  }
  return null;
}
