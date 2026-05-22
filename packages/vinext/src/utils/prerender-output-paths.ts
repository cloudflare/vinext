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

/**
 * Determine the RSC output file path for a prerendered URL.
 * "/blog/hello-world" -> "blog/hello-world.rsc"
 * "/"                 -> "index.rsc"
 */
export function getRscOutputPath(urlPath: string): string {
  if (urlPath === "/") return "index.rsc";
  return urlPath.replace(/^\//, "") + ".rsc";
}
