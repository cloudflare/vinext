import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "../server/normalize-path.js";
import { removeTrailingSlash, stripBasePath } from "../utils/base-path.js";

export const RSC_PREWARM_MANIFEST_META_NAME = "vinext-rsc-prewarm-manifest";

type RscPrewarmManifest = {
  version: 1;
  paths: string[];
};

declare global {
  var __VINEXT_RSC_PREWARMABLE_PATHS: unknown;
}

let manifestPromise: Promise<ReadonlySet<string>> | null = null;
let serverPathsSource: unknown;
let serverPaths = new Set<string>();

export function normalizeRscPrewarmPath(pathname: string, basePath = ""): string {
  return removeTrailingSlash(
    normalizePath(normalizePathnameForRouteMatch(stripBasePath(pathname, basePath))),
  );
}

function parseRscPrewarmManifest(value: unknown): ReadonlySet<string> {
  if (!value || typeof value !== "object") return new Set();
  const manifest = value as Partial<RscPrewarmManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.paths)) return new Set();

  const paths = new Set<string>();
  for (const pathname of manifest.paths) {
    if (typeof pathname !== "string" || !pathname.startsWith("/")) return new Set();
    paths.add(normalizeRscPrewarmPath(pathname));
  }
  return paths;
}

async function loadRscPrewarmManifest(): Promise<ReadonlySet<string>> {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") {
    return new Set();
  }
  const meta = document.querySelector(`meta[name="${RSC_PREWARM_MANIFEST_META_NAME}"]`);
  const manifestUrl = meta?.getAttribute("content");
  if (!manifestUrl) return new Set();

  try {
    const response = await fetch(manifestUrl, {
      cache: "force-cache",
      credentials: "same-origin",
    });
    if (!response.ok) return new Set();
    return parseRscPrewarmManifest(await response.json());
  } catch {
    // Eligibility is an optimization. Missing or unreadable metadata fails
    // closed so the request retains the normal Next-compatible header shape.
    return new Set();
  }
}

export function preloadRscPrewarmManifest(): Promise<ReadonlySet<string>> {
  manifestPromise ??= loadRscPrewarmManifest();
  return manifestPromise;
}

export async function isRscPrewarmEligibleHref(href: string, basePath = ""): Promise<boolean> {
  if (typeof window === "undefined") return false;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin || url.search !== "") return false;

  const paths = await preloadRscPrewarmManifest();
  return paths.has(normalizeRscPrewarmPath(url.pathname, basePath));
}

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

/** Test-only reset for isolated browser-global fixtures. */
export function resetRscPrewarmManifestForTesting(): void {
  manifestPromise = null;
  serverPathsSource = undefined;
  serverPaths = new Set();
}
