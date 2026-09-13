/**
 * Determine the HTML output file path for a prerendered URL.
 * Respects trailingSlash config.
 */
export function getOutputPath(urlPath: string, trailingSlash: boolean, basePath = ""): string {
  if (urlPath === "/" && basePath === "") return "index.html";
  const outputUrlPath =
    basePath === ""
      ? urlPath
      : urlPath === "/"
        ? trailingSlash
          ? `${basePath}/`
          : basePath
        : `${basePath}${urlPath}`;
  const clean = outputUrlPath.replace(/^\//, "").replace(/\/$/, "");
  if (trailingSlash) return `${clean}/index.html`;
  return `${clean}.html`;
}

/** Determine the Flight payload path for a prerendered App Router URL. */
export function getRscOutputPath(
  urlPath: string,
  options: { mode: "default" | "export"; trailingSlash: boolean; basePath?: string } = {
    mode: "default",
    trailingSlash: false,
  },
): string {
  if (options.mode === "export") {
    if (urlPath === "/") {
      const cleanBasePath = options.basePath?.replace(/^\//, "");
      return cleanBasePath ? `${cleanBasePath}/index.txt` : "index.txt";
    }
    const outputUrlPath = options.basePath ? `${options.basePath}${urlPath}` : urlPath;
    const clean = outputUrlPath.replace(/^\//, "").replace(/\/$/, "");
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
