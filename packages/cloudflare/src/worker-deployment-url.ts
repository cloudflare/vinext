import { parseWorkersDevUrl } from "./workers-dev-url.js";

export function parseWorkerDeploymentUrl(output: string): string | null {
  return parseWorkersDevUrl(output) ?? parseCustomDomainUrl(output);
}

/**
 * Parse the concrete hostname that Wrangler reports after applying Worker
 * triggers. Catch-all routes are valid warmup targets even though they are not
 * canonical deployment URLs for general CLI reporting.
 */
export function parseCdnWarmupDeploymentUrl(output: string): string | null {
  return (
    parseCustomDomainUrl(output) ??
    parseCatchAllWorkerRouteOrigin(output) ??
    parseWorkersDevUrl(output)
  );
}

function parseCatchAllWorkerRouteOrigin(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const route = line.trim().split(/\s+/, 1)[0];
    if (!route || !route.endsWith("/*")) continue;

    try {
      const url = new URL(route.includes("://") ? route : `https://${route}`);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.hostname.includes("*") ||
        url.username !== "" ||
        url.password !== "" ||
        url.port !== "" ||
        url.pathname !== "/*" ||
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
