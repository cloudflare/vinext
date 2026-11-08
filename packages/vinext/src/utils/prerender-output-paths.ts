/**
 * Map a prerendered URL to the file path its artifacts are written under, as
 * Next.js's `normalizePagePath` does. `/index` becomes `/index/index` (and
 * `/index/foo` becomes `/index/index/foo`) so it never shares `/`'s files.
 * Unlike Next.js, dynamic fallback-shell paths such as `/index/[slug]` are
 * also prefixed; build and seed both use this mapping, so they stay in step.
 * Source: https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/page-path/normalize-page-path.ts
 */
import path from "pathslash";

function toOutputUrlPath(urlPath: string): string {
  return /^\/index(?:\/|$)/.test(urlPath) ? `/index${urlPath}` : urlPath;
}

/**
 * Next.js throws NormalizeError when `posix.normalize` changes the page path.
 * A relative result that is already `../` is normalized and still escapes
 * `path.join(outDir, relative)`, so that shape is rejected too.
 */
function containedOutputPath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized !== relativePath ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`[vinext] Requested and resolved page mismatch: ${relativePath} ${normalized}`);
  }
  return relativePath;
}

/**
 * Determine the HTML output file path for a prerendered URL.
 * Respects trailingSlash config.
 */
export function getOutputPath(urlPath: string, trailingSlash: boolean, basePath = ""): string {
  if (urlPath === "/" && basePath === "") return containedOutputPath("index.html");
  const outputUrlPath =
    basePath === ""
      ? toOutputUrlPath(urlPath)
      : urlPath === "/"
        ? trailingSlash
          ? `${basePath}/`
          : basePath
        : `${basePath}${toOutputUrlPath(urlPath)}`;
  const clean = outputUrlPath.replace(/^\//, "").replace(/\/$/, "");
  if (trailingSlash) return containedOutputPath(`${clean}/index.html`);
  return containedOutputPath(`${clean}.html`);
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
      return containedOutputPath(cleanBasePath ? `${cleanBasePath}/index.txt` : "index.txt");
    }
    const outputUrlPath = `${options.basePath ?? ""}${toOutputUrlPath(urlPath)}`;
    const clean = outputUrlPath.replace(/^\//, "").replace(/\/$/, "");
    return containedOutputPath(options.trailingSlash ? `${clean}/index.txt` : `${clean}.txt`);
  }

  if (urlPath === "/") return containedOutputPath("index.rsc");
  return containedOutputPath(toOutputUrlPath(urlPath).replace(/^\//, "") + ".rsc");
}

/** Determine the binary artifact path for a prerendered App Route response. */
export function getAppRouteOutputPath(urlPath: string): string {
  if (urlPath === "/") return containedOutputPath("index.route");
  return containedOutputPath(toOutputUrlPath(urlPath).replace(/^\//, "") + ".route");
}
