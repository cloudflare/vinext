import { parseWorkersDevUrl } from "./workers-dev-url.js";

export function parseWorkerDeploymentUrl(output: string): string | null {
  return parseWorkersDevUrl(output) ?? parseCustomDomainUrl(output);
}

/**
 * Derive the workers.dev origin production traffic reads from the version
 * preview URL `wrangler versions upload` prints.
 *
 * Warmup needs that origin *before* promotion, and no command run by then
 * reports it: `wrangler versions deploy` prints traffic splits rather than
 * URLs, and `wrangler triggers deploy` only runs after promotion. Upload is
 * the sole pre-promotion source, but its URL is version-scoped
 * (`https://{versionId first 8}-{worker}.{subdomain}`) and the version prefix
 * makes it a different hostname, so a different cache key — warming it would
 * confirm a partition production never reads.
 *
 * Inverting Wrangler's own construction keeps the resolution exact instead of
 * guessing at an account subdomain: without the expected version prefix this
 * returns null so callers fall back to refusing rather than warming a host
 * this deployment may not answer on.
 */
export function parseWorkersDevProductionUrl(
  previewUrl: string | null | undefined,
  versionId: string,
): string | null {
  if (!previewUrl || versionId.length < 8) return null;
  let hostname: string;
  try {
    ({ hostname } = new URL(previewUrl));
  } catch {
    return null;
  }
  if (hostname !== "workers.dev" && !hostname.endsWith(".workers.dev")) return null;
  const versionPrefix = `${versionId.slice(0, 8).toLowerCase()}-`;
  if (!hostname.startsWith(versionPrefix)) return null;
  const productionHostname = hostname.slice(versionPrefix.length);
  if (productionHostname.startsWith(".")) return null;
  return `https://${productionHostname}`;
}

function parseCustomDomainUrl(output: string): string | null {
  // Wrangler adds a scheme only to workers.dev targets. A successful custom-domain
  // deployment is printed as a bare hostname with this explicit route-type marker.
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*(\S+)\s+\(custom domain(?: - zone (?:id|name): [^)]+)?\)(?: \[([^\]\r\n]+)\])?\s*$/.exec(
        line,
      );
    const hostname = match?.[1];
    if (!hostname) continue;
    if (match[2]?.split(",").some((flag) => flag.trim() === "disabled")) continue;

    try {
      const url = new URL(`https://${hostname}`);
      if (
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        continue;
      }
      return url.origin;
    } catch {
      continue;
    }
  }

  return null;
}
