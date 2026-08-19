import { normalizePathTrailingSlash } from "vinext/shims/url-utils";

type RscPrewarmManifest = {
  version: 1;
  paths: string[];
};

type RscPrewarmManifestState =
  | { kind: "ready"; paths: ReadonlySet<string> }
  | { kind: "unavailable" };

export type RscPrewarmEligibility = "eligible" | "ineligible";

const manifestUrl = process.env.__VINEXT_RSC_PREWARM_MANIFEST_URL ?? "";
const trailingSlash = process.env.__VINEXT_TRAILING_SLASH === "true";
let manifestPromise: Promise<RscPrewarmManifestState> | null = null;
let manifestState: RscPrewarmManifestState | null = null;

/** Bound the single eager eligibility request before retaining contextual RSC behavior. */
export const RSC_PREWARM_MANIFEST_FETCH_TIMEOUT_MS = 5_000;

export function normalizeRscPrewarmHref(href: string): string {
  if (typeof window === "undefined") return href;
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return href;
    url.pathname = normalizePathTrailingSlash(url.pathname, trailingSlash);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

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
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = (async (): Promise<RscPrewarmManifestState> => {
      const response = await fetch(manifestUrl, {
        cache: "force-cache",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) return { kind: "unavailable" };
      const paths = parseManifest(await response.json());
      return paths ? { kind: "ready", paths } : { kind: "unavailable" };
    })();
    const deadline = new Promise<RscPrewarmManifestState>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({ kind: "unavailable" });
      }, RSC_PREWARM_MANIFEST_FETCH_TIMEOUT_MS);
    });
    return await Promise.race([request, deadline]);
  } catch {
    return { kind: "unavailable" };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function preloadRscPrewarmManifest(): Promise<RscPrewarmManifestState> {
  return (manifestPromise ??= loadManifest().then((state) => (manifestState = state)));
}

function resolveEligibilityFromState(
  href: string,
  state: RscPrewarmManifestState,
): RscPrewarmEligibility {
  if (!manifestUrl || typeof window === "undefined") return "ineligible";

  let url: URL;
  try {
    url = new URL(normalizeRscPrewarmHref(href), window.location.href);
  } catch {
    return "ineligible";
  }
  if (url.origin !== window.location.origin || url.search !== "") return "ineligible";
  // The manifest only opts proven routes into the shared canonical request.
  // If it is unavailable, preserve ordinary contextual RSC behavior.
  if (state.kind === "unavailable") return "ineligible";
  return state.paths.has(url.pathname) ? "eligible" : "ineligible";
}

export async function resolveRscPrewarmEligibility(href: string): Promise<RscPrewarmEligibility> {
  return resolveEligibilityFromState(href, await preloadRscPrewarmManifest());
}

/** Preserve synchronous click navigation while the eager manifest request is still pending. */
export function resolveLoadedRscPrewarmEligibility(href: string): RscPrewarmEligibility {
  void preloadRscPrewarmManifest();
  return manifestState ? resolveEligibilityFromState(href, manifestState) : "ineligible";
}

export async function isRscPrewarmEligibleHref(href: string): Promise<boolean> {
  return (await resolveRscPrewarmEligibility(href)) === "eligible";
}
