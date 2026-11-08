import path from "pathslash";

/**
 * A prerendered URL with a `.` or `..` segment, which `posix.normalize` would
 * resolve to another path, so its artifacts would land outside their output
 * directory. Next.js's `normalizePagePath` throws the same message, which
 * fails `next build` in every output mode.
 */
export class PagePathMismatchError extends Error {}

/**
 * Map a prerendered URL to the file path its artifacts are written under, as
 * Next.js's `normalizePagePath` does. `/index` becomes `/index/index` (and
 * `/index/foo` becomes `/index/index/foo`) so it never shares `/`'s files.
 * Unlike Next.js, dynamic fallback-shell paths such as `/index/[slug]` are
 * also prefixed; build and seed both use this mapping, so they stay in step.
 * Throws a {@link PagePathMismatchError} for a path with a dot segment.
 * Source: https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/page-path/normalize-page-path.ts
 */
function toOutputUrlPath(urlPath: string): string {
  const outputUrlPath = /^\/index(?:\/|$)/.test(urlPath) ? `/index${urlPath}` : urlPath;
  if (outputUrlPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new PagePathMismatchError(
      `Requested and resolved page mismatch: ${outputUrlPath} ${path.posix.normalize(outputUrlPath)}`,
    );
  }
  return outputUrlPath;
}

/** Throw a {@link PagePathMismatchError} when `urlPath` has a dot segment. */
export function assertNormalizedPagePath(urlPath: string): void {
  toOutputUrlPath(urlPath);
}

/**
 * Determine the HTML output file path for a prerendered URL.
 * Respects trailingSlash config.
 */
export function getOutputPath(urlPath: string, trailingSlash: boolean, basePath = ""): string {
  if (urlPath === "/" && basePath === "") return "index.html";
  const outputUrlPath =
    basePath === ""
      ? toOutputUrlPath(urlPath)
      : urlPath === "/"
        ? trailingSlash
          ? `${basePath}/`
          : basePath
        : `${basePath}${toOutputUrlPath(urlPath)}`;
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
    const outputUrlPath = `${options.basePath ?? ""}${toOutputUrlPath(urlPath)}`;
    const clean = outputUrlPath.replace(/^\//, "").replace(/\/$/, "");
    return options.trailingSlash ? `${clean}/index.txt` : `${clean}.txt`;
  }

  if (urlPath === "/") return "index.rsc";
  return toOutputUrlPath(urlPath).replace(/^\//, "") + ".rsc";
}

/** Determine the binary artifact path for a prerendered App Route response. */
export function getAppRouteOutputPath(urlPath: string): string {
  if (urlPath === "/") return "index.route";
  return toOutputUrlPath(urlPath).replace(/^\//, "") + ".route";
}
