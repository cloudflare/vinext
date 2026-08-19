type RscPrewarmManifest = {
  version: 1;
  paths: string[];
};

type RscPrewarmManifestState =
  | { kind: "ready"; paths: ReadonlySet<string> }
  | { kind: "unavailable" };

export type RscPrewarmEligibility = "eligible" | "ineligible" | "unknown";

const manifestUrl = process.env.__VINEXT_RSC_PREWARM_MANIFEST_URL ?? "";
let manifestPromise: Promise<RscPrewarmManifestState> | null = null;

/** Keep an unavailable optional manifest from visibly stalling a user click. */
export const RSC_PREWARM_NAVIGATION_TIMEOUT_MS = 250;

function parseManifest(value: unknown): ReadonlySet<string> | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Partial<RscPrewarmManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.paths)) return null;

  const paths = new Set<string>();
  for (const pathname of manifest.paths) {
    if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
    paths.add(pathname);
  }
  return paths;
}

async function loadManifest(): Promise<RscPrewarmManifestState> {
  if (!manifestUrl || typeof window === "undefined") return { kind: "unavailable" };
  try {
    const response = await fetch(manifestUrl, {
      cache: "force-cache",
      credentials: "same-origin",
    });
    if (!response.ok) return { kind: "unavailable" };
    const paths = parseManifest(await response.json());
    return paths ? { kind: "ready", paths } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export function preloadRscPrewarmManifest(): Promise<RscPrewarmManifestState> {
  return (manifestPromise ??= loadManifest());
}

function loadManifestWithin(timeoutMs: number): Promise<RscPrewarmManifestState | null> {
  const manifest = preloadRscPrewarmManifest();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
    void manifest.then((state) => {
      clearTimeout(timeout);
      resolve(state);
    });
  });
}

export async function resolveRscPrewarmEligibility(
  href: string,
  options?: { timeoutMs?: number },
): Promise<RscPrewarmEligibility> {
  if (!manifestUrl || typeof window === "undefined") return "ineligible";

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return "ineligible";
  }
  if (url.origin !== window.location.origin || url.search !== "") return "ineligible";
  const manifest = preloadRscPrewarmManifest();
  const state =
    options?.timeoutMs === undefined ? await manifest : await loadManifestWithin(options.timeoutMs);
  if (state === null || state.kind === "unavailable") return "unknown";
  return state.paths.has(url.pathname) ? "eligible" : "ineligible";
}

export async function isRscPrewarmEligibleHref(
  href: string,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  return (await resolveRscPrewarmEligibility(href, options)) === "eligible";
}
