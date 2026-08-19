type RscPrewarmManifest = {
  version: 1;
  paths: string[];
};

const manifestUrl = process.env.__VINEXT_RSC_PREWARM_MANIFEST_URL ?? "";
let manifestPromise: Promise<ReadonlySet<string>> | null = null;

/** Keep an unavailable optional manifest from visibly stalling a user click. */
export const RSC_PREWARM_NAVIGATION_TIMEOUT_MS = 250;

function parseManifest(value: unknown): ReadonlySet<string> {
  if (!value || typeof value !== "object") return new Set();
  const manifest = value as Partial<RscPrewarmManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.paths)) return new Set();

  const paths = new Set<string>();
  for (const pathname of manifest.paths) {
    if (typeof pathname !== "string" || !pathname.startsWith("/")) return new Set();
    paths.add(pathname);
  }
  return paths;
}

async function loadManifest(): Promise<ReadonlySet<string>> {
  if (!manifestUrl || typeof window === "undefined") return new Set();
  try {
    const response = await fetch(manifestUrl, {
      cache: "force-cache",
      credentials: "same-origin",
    });
    if (!response.ok) return new Set();
    return parseManifest(await response.json());
  } catch {
    // This is an optimization. A missing/stale asset keeps the contextual
    // request shape rather than changing navigation behavior.
    return new Set();
  }
}

export function preloadRscPrewarmManifest(): Promise<ReadonlySet<string>> {
  return (manifestPromise ??= loadManifest());
}

function loadManifestWithin(timeoutMs: number): Promise<ReadonlySet<string>> {
  const manifest = preloadRscPrewarmManifest();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(new Set()), Math.max(0, timeoutMs));
    void manifest.then((paths) => {
      clearTimeout(timeout);
      resolve(paths);
    });
  });
}

export async function isRscPrewarmEligibleHref(
  href: string,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  if (!manifestUrl || typeof window === "undefined") return false;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin || url.search !== "") return false;
  const manifest = preloadRscPrewarmManifest();
  const paths =
    options?.timeoutMs === undefined ? await manifest : await loadManifestWithin(options.timeoutMs);
  return paths.has(url.pathname);
}
