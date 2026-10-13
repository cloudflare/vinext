import { findPackageVersion, isVersionBelow } from "./react-version.js";

// 0.5.37 binds encrypted "use server" closures to their action id
// (vitejs/vite-plugin-react#1499). Older versions let one inline Server
// Action's closure decrypt as another's captures, so they are rejected rather
// than left to the optional peer range.
const MINIMUM_PLUGIN_RSC_VERSION: [number, number, number] = [0, 5, 37];

/** Range to install, so package managers never pick a version vinext rejects. */
export const PLUGIN_RSC_VERSION_RANGE = `^${MINIMUM_PLUGIN_RSC_VERSION.join(".")}`;

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
