import fs from "node:fs";
import path from "pathslash";
import { createRequire } from "node:module";

type DependencyUpgradeRecommendation = {
  minimumVersion: [major: number, minor: number, patch: number];
  upgrades: string[];
};

function getDependencyUpgradeDeps(
  root: string,
  recommendations: Record<string, DependencyUpgradeRecommendation>,
): string[] {
  const req = createRequire(path.join(root, "package.json"));
  for (const [dependency, recommendation] of Object.entries(recommendations)) {
    try {
      const version = findPackageVersion(req.resolve(dependency), dependency);
      if (version && isVersionBelow(version, recommendation.minimumVersion)) {
        return recommendation.upgrades;
      }
    } catch {
      continue;
    }
  }
  return [];
}

export function getReactUpgradeDeps(root: string): string[] {
  return getDependencyUpgradeDeps(root, {
    react: {
      minimumVersion: [19, 2, 6],
      upgrades: ["react@latest", "react-dom@latest"],
    },
  });
}

function isVersionBelow(version: string, minimum: [number, number, number]): boolean {
  const current = version.split(".").map((part) => parseInt(part, 10));
  for (let index = 0; index < minimum.length; index++) {
    if ((current[index] ?? 0) !== minimum[index]) return (current[index] ?? 0) < minimum[index];
  }
  return false;
}

/** Walk up from a resolved module entry to find its package version. */
function findPackageVersion(resolvedEntry: string, packageName: string): string | null {
  let dir = path.dirname(resolvedEntry);
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (pkg.name === packageName) {
        return pkg.version ?? null;
      }
    } catch {
      // no package.json at this level, keep walking up
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** Check the application's React capabilities and matching renderer versions. */
export function hasReactViewTransitionRuntime(root: string): boolean {
  const req = createRequire(path.join(root, "package.json"));
  try {
    const react: unknown = req("react");
    if (
      react === null ||
      typeof react !== "object" ||
      !("version" in react) ||
      typeof react.version !== "string" ||
      !("ViewTransition" in react) ||
      typeof react.ViewTransition !== "symbol" ||
      !("addTransitionType" in react) ||
      typeof react.addTransitionType !== "function"
    )
      return false;
    return ["react-dom", "react-server-dom-webpack"].every(
      (name) => findPackageVersion(req.resolve(`${name}/package.json`), name) === react.version,
    );
  } catch {
    // A missing or unloadable runtime cannot provide the animation contract.
    return false;
  }
}
