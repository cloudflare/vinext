import { normalizeRscPrewarmPath } from "./rsc-prewarm-path.js";

declare global {
  var __VINEXT_RSC_PREWARMABLE_PATHS: unknown;
}

let serverPathsSource: unknown;
let serverPaths = new Set<string>();

/** Server-side enforcement for the browser eligibility manifest. */
export function isServerRscPrewarmEligiblePathname(pathname: string, basePath = ""): boolean {
  const source = globalThis.__VINEXT_RSC_PREWARMABLE_PATHS;
  if (source !== serverPathsSource) {
    serverPathsSource = source;
    serverPaths = new Set();
    if (Array.isArray(source)) {
      for (const value of source) {
        if (typeof value !== "string" || !value.startsWith("/")) {
          serverPaths.clear();
          break;
        }
        serverPaths.add(normalizeRscPrewarmPath(value));
      }
    }
  }
  return serverPaths.has(normalizeRscPrewarmPath(pathname, basePath));
}

/** Test-only reset for isolated server-global fixtures. */
export function resetServerRscPrewarmEligibilityForTesting(): void {
  serverPathsSource = undefined;
  serverPaths = new Set();
}
