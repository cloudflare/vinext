import {
  normalizeRscPrewarmPath,
  RSC_PREWARM_MANIFEST_META_NAME,
} from "../server/rsc-prewarm-path.js";

export { normalizeRscPrewarmPath, RSC_PREWARM_MANIFEST_META_NAME };
// Keep the optimization off the critical path: a very early click may briefly
// wait for the already-started static asset, then falls back to the normal
// contextual request if the asset is slow or unavailable.
export const RSC_PREWARM_MANIFEST_WAIT_MS = 250;

type RscPrewarmManifest = {
  version: 1;
  paths: string[];
};

let manifestPromise: Promise<ReadonlySet<string>> | null = null;
let loadedManifestPaths: ReadonlySet<string> | null = null;

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

/**
 * Background prefetch eligibility has no user-visible critical path, so it can
 * wait for the already-started manifest without falling back to a contextual
 * request. A click cancels the pending prefetch setup and performs its own
 * bounded eligibility check through `isRscPrewarmEligibleHref`.
 */
export async function isRscPrewarmEligibleHrefForPrefetch(
  href: string,
  basePath = "",
): Promise<boolean> {
  const pathname = resolveEligibleHrefPathname(href, basePath);
  if (pathname === null) return false;
  const paths = loadedManifestPaths ?? (await preloadRscPrewarmManifest());
  return paths.has(pathname);
}

/**
 * Synchronous eligibility check once the manifest has loaded. `null` means the
 * manifest is still pending, while `false` means it loaded and did not list the
 * href. Callers that preserve same-task navigation commits need that distinction
 * so an already-settled negative result does not introduce an unnecessary await.
 */
export function getLoadedRscPrewarmEligibility(href: string, basePath = ""): boolean | null {
  if (loadedManifestPaths === null) return null;
  const pathname = resolveEligibleHrefPathname(href, basePath);
  return pathname !== null && loadedManifestPaths.has(pathname);
}

/** Synchronous boolean check retained for callers that only need a positive hit. */
export function isLoadedRscPrewarmEligibleHref(href: string, basePath = ""): boolean {
  return getLoadedRscPrewarmEligibility(href, basePath) === true;
}

/** Test-only reset for isolated browser-global fixtures. */
export function resetRscPrewarmManifestForTesting(): void {
  manifestPromise = null;
  loadedManifestPaths = null;
}
