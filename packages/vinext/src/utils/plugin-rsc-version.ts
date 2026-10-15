import fs from "node:fs";
import { createRequire } from "node:module";
import path from "pathslash";
import { findPackageVersion, isVersionBelow, MINIMUM_REACT_VERSION } from "./react-version.js";

// 0.5.37 binds encrypted "use server" closures to their action id
// (vitejs/vite-plugin-react#1499). Older versions let one inline Server
// Action's closure decrypt as another's captures, so they are rejected rather
// than left to the optional peer range.
const MINIMUM_PLUGIN_RSC_VERSION: [number, number, number] = [0, 5, 37];

/** Return the installed @vitejs/plugin-rsc version, or throw if it is unsupported. */
export function assertPluginRscVersion(resolvedRscPath: string): string {
  const version = findPackageVersion(resolvedRscPath, "@vitejs/plugin-rsc");
  if (!version || isVersionBelow(version, MINIMUM_PLUGIN_RSC_VERSION)) {
    throw new Error(
      `vinext: App Router requires @vitejs/plugin-rsc ${MINIMUM_PLUGIN_RSC_VERSION.join(".")} or newer ` +
        `(found ${version ?? "an unknown version"}). Upgrade @vitejs/plugin-rsc.`,
    );
  }
  return version;
}

// 0.5.37 and older bundle react-server-dom-webpack 19.3.0, below the React
// floor. plugin-rsc uses the app's own copy instead only when the package.json
// closest to the working directory declares it and it is installed, so that
// copy must be at the floor too.
const FIRST_PLUGIN_RSC_WITH_SUPPORTED_RSDW: [number, number, number] = [0, 5, 38];

/** Whether the package owning `dir` must install its own react-server-dom-webpack. */
export function needsAppReactServerDom(dir: string, pluginRscVersion: string): boolean {
  if (!isVersionBelow(pluginRscVersion, FIRST_PLUGIN_RSC_WITH_SUPPORTED_RSDW)) return false;
  // plugin-rsc reads the closest package.json at or above the working directory.
  let manifest = path.join(dir, "package.json");
  while (!fs.existsSync(manifest)) {
    const parent = path.dirname(path.dirname(manifest));
    if (parent === path.dirname(manifest)) return true;
    manifest = path.join(parent, "package.json");
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (
      !pkg.dependencies?.["react-server-dom-webpack"] &&
      !pkg.devDependencies?.["react-server-dom-webpack"]
    ) {
      return true;
    }
    const version = findPackageVersion(
      createRequire(manifest).resolve("react-server-dom-webpack"),
      "react-server-dom-webpack",
    );
    return !version || isVersionBelow(version, MINIMUM_REACT_VERSION);
  } catch {
    return true;
  }
}
