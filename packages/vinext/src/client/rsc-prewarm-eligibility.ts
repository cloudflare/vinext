import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "../server/normalize-path.js";
import { removeTrailingSlash, stripBasePath } from "../utils/base-path.js";

export const RSC_PREWARM_MANIFEST_META_NAME = "vinext-rsc-prewarm-manifest";
// Keep the optimization off the critical path: a very early click may briefly
// wait for the already-started static asset, then falls back to the normal
// contextual request if the asset is slow or unavailable.
export const RSC_PREWARM_MANIFEST_WAIT_MS = 250;

type RscPrewarmManifest = {
  version: 1;
  paths: string[];
};

declare global {
  var __VINEXT_RSC_PREWARMABLE_PATHS: unknown;
}

let manifestPromise: Promise<ReadonlySet<string>> | null = null;
let loadedManifestPaths: ReadonlySet<string> | null = null;
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
  manifestPromise ??= loadRscPrewarmManifest().then((paths) => {
    loadedManifestPaths = paths;
    return paths;
  });
  return manifestPromise;
}

function resolveEligibleHrefPathname(href: string, basePath: string): string | null {
  if (typeof window === "undefined") return null;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin || url.search !== "") return null;
  return normalizeRscPrewarmPath(url.pathname, basePath);
}

export async function isRscPrewarmEligibleHref(href: string, basePath = ""): Promise<boolean> {
  const pathname = resolveEligibleHrefPathname(href, basePath);
  if (pathname === null) return false;
  if (loadedManifestPaths !== null) return loadedManifestPaths.has(pathname);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), RSC_PREWARM_MANIFEST_WAIT_MS);
  });
  const paths = await Promise.race([preloadRscPrewarmManifest(), timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  return paths?.has(pathname) ?? false;
}

/** Synchronous check for callers that cannot await the manifest preload. */
export function isLoadedRscPrewarmEligibleHref(href: string, basePath = ""): boolean {
  if (loadedManifestPaths === null) return false;
  const pathname = resolveEligibleHrefPathname(href, basePath);
  return pathname !== null && loadedManifestPaths.has(pathname);
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
  loadedManifestPaths = null;
  serverPathsSource = undefined;
  serverPaths = new Set();
}
