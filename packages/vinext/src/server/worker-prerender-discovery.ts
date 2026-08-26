import type { ExecutionContextLike } from "vinext/shims/request-context";
import {
  VINEXT_PRERENDER_METADATA_ROUTES_PATH,
  VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH,
  VINEXT_PRERENDER_SECRET_HEADER,
  VINEXT_PRERENDER_STATIC_PARAMS_PATH,
} from "./headers.js";

const PRERENDER_DISCOVERY_PATHS = new Set([
  VINEXT_PRERENDER_STATIC_PARAMS_PATH,
  VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH,
  VINEXT_PRERENDER_METADATA_ROUTES_PATH,
]);

export function isWorkerPrerenderDiscoveryPath(pathname: string): boolean {
  return PRERENDER_DISCOVERY_PATHS.has(pathname);
}

function secretsMatch(provided: string, expected: string): boolean {
  // The generated secret is fixed-width hex, so always scan the full expected
  // value and fold the length mismatch into the result. Do not use ordinary
  // string equality for this externally supplied capability.
  let mismatch = provided.length ^ expected.length;
  for (let index = 0; index < expected.length; index++) {
    mismatch |= (provided.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Mark only a request carrying the current build's capability as an internal
 * path-discovery request. The capability is compiled into the Worker entry and
 * rotated on every build; the public version override proves which staged
 * version Cloudflare invoked but is deliberately not treated as authorization.
 */
export function createWorkerPrerenderDiscoveryContext(
  base: ExecutionContextLike,
  request: Request,
  expectedSecret: string | null | undefined,
): ExecutionContextLike {
  // Ordinary traffic never carries this capability. Reject it before URL
  // parsing so staged discovery adds no URL work to the common request path.
  const providedSecret = request.headers.get(VINEXT_PRERENDER_SECRET_HEADER);
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return base;
  }

  const pathname = new URL(request.url).pathname;
  if (!isWorkerPrerenderDiscoveryPath(pathname)) return base;

  return { ...base, isPrerenderPathDiscovery: true };
}
