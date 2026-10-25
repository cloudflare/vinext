import fs from "node:fs";
import { createRequire } from "node:module";
import path from "pathslash";
import { findPackageVersion, isVersionBelow } from "./react-version.js";

// The floor of the `^5.1.4 || ^6.0.0` peer range. Node never checks peer
// ranges, so a project-side lookup can load any copy it reaches. For example,
// pnpm's bin shims put node_modules/.pnpm/node_modules on NODE_PATH, which
// exposes copies hoisted for other workspace packages. Older versions append a
// React Refresh footer that breaks under vinext's import.meta.url rewrite.
const MINIMUM_PLUGIN_REACT_VERSION: [number, number, number] = [5, 1, 4];

type ResolvedPluginReact = { path: string; version: string | null };

function resolveFrom(from: string): ResolvedPluginReact | null {
  try {
    const resolved = createRequire(from).resolve("@vitejs/plugin-react");
    return { path: resolved, version: findPackageVersion(resolved, "@vitejs/plugin-react") };
  } catch {
    return null;
  }
}

function isSupported(plugin: ResolvedPluginReact): boolean {
  return plugin.version !== null && !isVersionBelow(plugin.version, MINIMUM_PLUGIN_REACT_VERSION);
}

/**
 * Resolve @vitejs/plugin-react from the project, falling back to vinext's own
 * install when the project has none or reaches an unsupported version.
 * Returns null when it is not installed, and throws when every copy found is
 * unsupported.
 */
export function resolvePluginReactPath(
  projectRoot: string,
  fallbackFrom: string = import.meta.url,
): string | null {
  const project = resolveFrom(path.join(projectRoot, "package.json"));
  if (project && isSupported(project)) return project.path;

  const fallback = resolveFrom(fallbackFrom);
  if (fallback && isSupported(fallback)) {
    if (project) {
      console.warn(
        `[vinext] Ignoring @vitejs/plugin-react ${project.version ?? "(unknown version)"} at ` +
          `${project.path}: vinext requires ${MINIMUM_PLUGIN_REACT_VERSION.join(".")} or newer. ` +
          `Using ${fallback.version} instead. Add @vitejs/plugin-react to your app's ` +
          `devDependencies to choose the version explicitly.`,
      );
    }
    return fallback.path;
  }

  const found = project ?? fallback;
  if (!found) return null;
  throw new Error(
    `vinext: @vitejs/plugin-react ${MINIMUM_PLUGIN_REACT_VERSION.join(".")} or newer is required ` +
      `(found ${found.version ?? "an unknown version"} at ${found.path}). ` +
      `Add @vitejs/plugin-react@^6 to your app's devDependencies.`,
  );
}

/**
 * The @vitejs/plugin-react upgrade vinext init must install before vinext.
 * A declared copy below the floor conflicts with vinext's peer range: npm stops
 * with ERESOLVE, and pnpm installs but vinext refuses to start.
 */
export function getPluginReactUpgradeDeps(root: string): string[] {
  const manifest = path.join(root, "package.json");
  let declared: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    declared =
      pkg.dependencies?.["@vitejs/plugin-react"] ?? pkg.devDependencies?.["@vitejs/plugin-react"];
  } catch {
    return [];
  }
  if (typeof declared !== "string") return [];

  // A simple range's newest match keeps its major, so a declared major below
  // the floor's can never install a supported version. Comparator sets and
  // unions (`<5`, `4 || ^6`) are left to the installed check below and to
  // vinext's startup check.
  const major = /^[~^]?(\d+)(?:\.(?:\d+|[x*])){0,2}$/.exec(declared.trim())?.[1];
  if (major !== undefined && Number(major) < MINIMUM_PLUGIN_REACT_VERSION[0]) {
    return ["@vitejs/plugin-react@latest"];
  }
  // A lockfile can still hold an older match of a supported major, or a
  // prerelease, which vinext's `^5.1.4 || ^6.0.0` peer range never matches.
  const installed = resolveFrom(manifest);
  return installed && (!isSupported(installed) || installed.version?.includes("-"))
    ? ["@vitejs/plugin-react@latest"]
    : [];
}
