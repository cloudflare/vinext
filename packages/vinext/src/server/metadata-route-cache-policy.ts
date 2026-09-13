export function isMetadataResponseCacheable(response: { headers: Headers }): boolean {
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  return !cacheControl
    .split(",")
    .map((directive) => directive.trim().split("=", 1)[0])
    .some((directive) => directive === "no-cache" || directive === "no-store");
}
