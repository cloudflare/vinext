import { parseWorkersDevUrl } from "./workers-dev-url.js";

export function parseWorkerDeploymentUrl(output: string): string | null {
  return parseWorkersDevUrl(output) ?? parseCustomDomainUrl(output);
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
