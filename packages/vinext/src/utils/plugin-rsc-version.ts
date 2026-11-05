import { findPackageVersion, isVersionBelow } from "./react-version.js";

// 0.5.39 lets decodeReply/decodeAction/decodeFormState reject server
// references through `onServerReference` (vitejs/vite-plugin-react#1520).
// Older versions ignore the callback, so Server Actions would decode
// references owned by other routes. They are rejected rather than left to the
// optional peer range.
const MINIMUM_PLUGIN_RSC_VERSION: [number, number, number] = [0, 5, 39];

/** Throw if the installed @vitejs/plugin-rsc version is unsupported. */
export function assertPluginRscVersion(resolvedRscPath: string): void {
  const version = findPackageVersion(resolvedRscPath, "@vitejs/plugin-rsc");
  if (!version || isVersionBelow(version, MINIMUM_PLUGIN_RSC_VERSION)) {
    throw new Error(
      `vinext: App Router requires @vitejs/plugin-rsc ${MINIMUM_PLUGIN_RSC_VERSION.join(".")} or newer ` +
        `(found ${version ?? "an unknown version"}). Upgrade @vitejs/plugin-rsc.`,
    );
  }
}
