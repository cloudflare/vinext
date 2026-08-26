/**
 * Determine the HTML output file path for a prerendered URL.
 * Respects trailingSlash config.
 */
export function getOutputPath(urlPath: string, trailingSlash: boolean): string {
  if (urlPath === "/") return "index.html";
  const clean = urlPath.replace(/^\//, "");
  if (trailingSlash) return `${clean}/index.html`;
  return `${clean}.html`;
}

/** Determine the Flight payload path for a prerendered App Router URL. */
export function getRscOutputPath(
  urlPath: string,
  options: { mode: "default" | "export"; trailingSlash: boolean } = {
    mode: "default",
    trailingSlash: false,
  },
): string {
  if (options.mode === "export") {
    if (urlPath === "/") return "index.txt";
    const clean = urlPath.replace(/^\//, "").replace(/\/$/, "");
    return options.trailingSlash ? `${clean}/index.txt` : `${clean}.txt`;
  }

  if (urlPath === "/") return "index.rsc";
  return urlPath.replace(/^\//, "") + ".rsc";
}

/** Determine the binary artifact path for a prerendered App Route response. */
export function getAppRouteOutputPath(urlPath: string): string {
  if (urlPath === "/") return "index.route";
  return urlPath.replace(/^\//, "") + ".route";
}
