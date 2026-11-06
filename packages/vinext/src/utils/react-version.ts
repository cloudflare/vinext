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

/**
 * Lowest React accepted for App Router builds. react-server-dom-webpack 19.3.0
 * shares typed-array buffers across Flight chunks, fixed in 19.3.1.
 */
export const MINIMUM_REACT_VERSION: [number, number, number] = [19, 3, 1];

export function getReactUpgradeDeps(
  root: string,
  options: { fromManifest?: boolean; installing?: boolean } = {},
): string[] {
  if (options.fromManifest) {
    // Config-only init may have no node_modules. Compare the declared lower
    // bounds so its next install cannot keep an incompatible React pin.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of ["react", "react-dom", "react-server-dom-webpack"]) {
      const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      // An installing init resolves ranges to their newest match, so only an
      // exact pin can keep a version below the floor.
      const pattern = options.installing
        ? /^([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/
        : /^[~^]?([0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z.*-]+)?)(?:\.[x*])?$/;
      const version = pattern.exec(declared ?? "")?.[1];
      // Config-only init will install stable RSDW. A declared React canary must
      // move with it, even when its numeric version is above the stable floor.
      // An installing init checks the resolved canary instead.
      const canary = !options.installing && version?.includes("-");
      if (version && (canary || isVersionBelow(version, MINIMUM_REACT_VERSION))) {
        const upgrades = ["react@latest", "react-dom@latest"];
        const rsdw =
          pkg.dependencies?.["react-server-dom-webpack"] ??
          pkg.devDependencies?.["react-server-dom-webpack"];
        if (rsdw && rsdw !== "latest") upgrades.push("react-server-dom-webpack@latest");
        return upgrades;
      }
    }
    return [];
  }
  return getDependencyUpgradeDeps(root, {
    // An installed RSDW below the floor moves with React: RSDW pins its React
    // peer to its own version.
    "react-server-dom-webpack": {
      minimumVersion: MINIMUM_REACT_VERSION,
      upgrades: ["react@latest", "react-dom@latest", "react-server-dom-webpack@latest"],
    },
    react: {
      minimumVersion: MINIMUM_REACT_VERSION,
      upgrades: ["react@latest", "react-dom@latest"],
    },
    "react-dom": {
      minimumVersion: MINIMUM_REACT_VERSION,
      upgrades: ["react@latest", "react-dom@latest"],
    },
  });
}

export function reactUpgradeRequiredMessage(
  installCommand: string,
  upgrades: string[],
  pluginRscVersion?: string,
): string {
  return (
    `vinext: App Router requires react, react-dom, and react-server-dom-webpack ${MINIMUM_REACT_VERSION.join(".")} or later.\n` +
    (pluginRscVersion
      ? `@vitejs/plugin-rsc ${pluginRscVersion} bundles an older react-server-dom-webpack, so install the latest in your app.\n`
      : "") +
    `Run: ${installCommand} ${upgrades.join(" ")}`
  );
}

export function isVersionBelow(version: string, minimum: [number, number, number]): boolean {
  const current = version.split(".").map((part) => parseInt(part, 10));
  for (let index = 0; index < minimum.length; index++) {
    if ((current[index] ?? 0) !== minimum[index]) return (current[index] ?? 0) < minimum[index];
  }
  return false;
}

/** Walk up from a resolved module entry to find its package version. */
export function findPackageVersion(resolvedEntry: string, packageName: string): string | null {
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
