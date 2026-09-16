import type { VinextResponseStageCacheability } from "./multi-stage.js";

export function isSerializedHeaders(value: unknown): value is Array<[string, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

export function isResponseStageCacheability(
  value: unknown,
): value is VinextResponseStageCacheability {
  if (!value || typeof value !== "object") return false;
  const cacheability = value as Partial<VinextResponseStageCacheability>;
  return (
    (cacheability.probeMode === null ||
      cacheability.probeMode === "probe" ||
      cacheability.probeMode === "identity") &&
    (cacheability.policyHeaders === null || isSerializedHeaders(cacheability.policyHeaders)) &&
    (cacheability.representation === undefined ||
      cacheability.representation === "app-route" ||
      cacheability.representation === "html" ||
      cacheability.representation === "pages-data" ||
      cacheability.representation === "rsc-full" ||
      cacheability.representation === "rsc-loading-shell") &&
    typeof cacheability.resolvedRoutePathname === "string" &&
    cacheability.resolvedRoutePathname.startsWith("/")
  );
}
