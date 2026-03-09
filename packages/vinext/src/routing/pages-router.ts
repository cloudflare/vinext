import path from "node:path";
import { compareRoutes } from "./utils.js";
import {
  createValidFileMatcher,
  scanWithExtensions,
  type ValidFileMatcher,
} from "./file-matcher.js";

export interface Route {
  /** URL pattern, e.g. "/" or "/about" or "/posts/:id" */
  pattern: string;
  /** Absolute file path to the page component */
  filePath: string;
  /** Whether this is a dynamic route */
  isDynamic: boolean;
  /** Parameter names for dynamic segments */
  params: string[];
}

// Route cache — invalidated when pages directory changes
const routeCache = new Map<string, { routes: Route[]; promise: Promise<Route[]> }>();

/**
 * Invalidate cached routes for a given pages directory.
 * Called by the file watcher when pages are added/removed.
 */
export function invalidateRouteCache(pagesDir: string): void {
  for (const key of routeCache.keys()) {
    if (key.startsWith(`pages:${pagesDir}:`) || key.startsWith(`api:${pagesDir}:`)) {
      routeCache.delete(key);
    }
  }
}

/**
 * Scan the pages/ directory and return a list of routes.
 * Results are cached — call invalidateRouteCache() when files change.
 *
 * Follows Next.js Pages Router conventions:
 * - pages/index.tsx -> /
 * - pages/about.tsx -> /about
 * - pages/posts/[id].tsx -> /posts/:id
 * - pages/[...slug].tsx -> /:slug+
 * - Ignores _app.tsx, _document.tsx, _error.tsx, files starting with _
 * - Ignores pages/api/ (handled separately later)
 */
export async function pagesRouter(
  pagesDir: string,
  pageExtensions?: readonly string[],
  matcher?: ValidFileMatcher,
): Promise<Route[]> {
  matcher ??= createValidFileMatcher(pageExtensions);
  const cacheKey = `pages:${pagesDir}:${JSON.stringify(matcher.extensions)}`;
  const cached = routeCache.get(cacheKey);
  if (cached) return cached.promise;

  const promise = scanPageRoutes(pagesDir, matcher);
  routeCache.set(cacheKey, { routes: [], promise });
  const routes = await promise;
  routeCache.set(cacheKey, { routes, promise });
  return routes;
}

async function scanPageRoutes(pagesDir: string, matcher: ValidFileMatcher): Promise<Route[]> {
  const routes: Route[] = [];

  // Use function form of exclude for Node < 22.14 compatibility (string arrays require >= 22.14)
  for await (const file of scanWithExtensions(
    "**/*",
    pagesDir,
    matcher.extensions,
    (name: string) => name === "api" || name.startsWith("_"),
  )) {
    const route = fileToRoute(file, pagesDir, matcher);
    if (route) routes.push(route);
  }

  // Sort: static routes first, then dynamic, then catch-all
  routes.sort(compareRoutes);

  return routes;
}

/**
 * Convert a file path relative to pages/ into a Route.
 */
function fileToRoute(file: string, pagesDir: string, matcher: ValidFileMatcher): Route | null {
  // Remove extension
  const withoutExt = matcher.stripExtension(file);
  if (withoutExt === file) return null;

  // Convert to URL segments
  const segments = withoutExt.split(path.sep);

  // Handle index files: pages/index.tsx -> /
  const lastSegment = segments[segments.length - 1];
  if (lastSegment === "index") {
    segments.pop();
  }

  const params: string[] = [];
  let isDynamic = false;

  // Convert Next.js dynamic segments to URL patterns
  const urlSegments = segments.map((segment) => {
    // Catch-all: [...slug] -> :slug+ (param names may contain hyphens)
    const catchAllMatch = segment.match(/^\[\.\.\.([\w-]+)\]$/);
    if (catchAllMatch) {
      isDynamic = true;
      params.push(catchAllMatch[1]);
      return `:${catchAllMatch[1]}+`;
    }

    // Optional catch-all: [[...slug]] -> :slug* (param names may contain hyphens)
    const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.([\w-]+)\]\]$/);
    if (optionalCatchAllMatch) {
      isDynamic = true;
      params.push(optionalCatchAllMatch[1]);
      return `:${optionalCatchAllMatch[1]}*`;
    }

    // Dynamic segment: [id] -> :id (param names may contain hyphens)
    const dynamicMatch = segment.match(/^\[([\w-]+)\]$/);
    if (dynamicMatch) {
      isDynamic = true;
      params.push(dynamicMatch[1]);
      return `:${dynamicMatch[1]}`;
    }

    return segment;
  });

  const pattern = "/" + urlSegments.join("/");

  return {
    pattern: pattern === "/" ? "/" : pattern,
    filePath: path.join(pagesDir, file),
    isDynamic,
    params,
  };
}

/**
 * Match a URL path against a route pattern.
 * Returns the matched params or null if no match.
 */
export function matchRoute(
  url: string,
  routes: Route[],
): { route: Route; params: Record<string, string | string[]> } | null {
  // Normalize: strip query string and trailing slash
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  try {
    normalizedUrl = decodeURIComponent(normalizedUrl);
  } catch {
    /* malformed percent-encoding — match as-is */
  }

  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) {
      return { route, params };
    }
  }

  return null;
}

/**
 * Scan the pages/api/ directory and return API routes.
 * Results are cached — call invalidateRouteCache() when files change.
 *
 * Follows Next.js conventions:
 * - pages/api/hello.ts -> /api/hello
 * - pages/api/users/[id].ts -> /api/users/:id
 */
export async function apiRouter(
  pagesDir: string,
  pageExtensions?: readonly string[],
  matcher?: ValidFileMatcher,
): Promise<Route[]> {
  matcher ??= createValidFileMatcher(pageExtensions);
  const cacheKey = `api:${pagesDir}:${JSON.stringify(matcher.extensions)}`;
  const cached = routeCache.get(cacheKey);
  if (cached) return cached.promise;

  const promise = scanApiRoutes(pagesDir, matcher);
  routeCache.set(cacheKey, { routes: [], promise });
  const routes = await promise;
  routeCache.set(cacheKey, { routes, promise });
  return routes;
}

async function scanApiRoutes(pagesDir: string, matcher: ValidFileMatcher): Promise<Route[]> {
  const apiDir = path.join(pagesDir, "api");
  let files: string[];
  try {
    files = [];
    for await (const file of scanWithExtensions("**/*", apiDir, matcher.extensions)) {
      files.push(file);
    }
  } catch {
    files = [];
  }

  const routes: Route[] = [];

  for (const file of files) {
    // Reuse fileToRoute but pretend the file is under a virtual "api/" prefix
    const route = fileToRoute(path.join("api", file), pagesDir, matcher);
    if (route) {
      routes.push(route);
    }
  }

  // Sort same as page routes
  routes.sort(compareRoutes);

  return routes;
}

function matchPattern(url: string, pattern: string): Record<string, string | string[]> | null {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  const params: Record<string, string | string[]> = Object.create(null);

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];

    // Catch-all: :slug+
    if (pp.endsWith("+")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }

    // Optional catch-all: :slug*
    if (pp.endsWith("*")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      params[paramName] = remaining;
      return params;
    }

    // Dynamic segment: :id
    if (pp.startsWith(":")) {
      const paramName = pp.slice(1);
      if (i >= urlParts.length) return null;
      params[paramName] = urlParts[i];
      continue;
    }

    // Static segment
    if (i >= urlParts.length || urlParts[i] !== pp) return null;
  }

  // All pattern parts matched - check url doesn't have extra segments
  if (urlParts.length !== patternParts.length) return null;

  return params;
}

/**
 * Convert internal route pattern (e.g., "/posts/:id", "/docs/:slug+")
 * to Next.js bracket format (e.g., "/posts/[id]", "/docs/[...slug]").
 * Used for __NEXT_DATA__.page which apps expect in Next.js format.
 */
export function patternToNextFormat(pattern: string): string {
  return pattern
    .replace(/:([\w-]+)\*/g, "[[...$1]]") // optional catch-all :slug* -> [[...slug]]
    .replace(/:([\w-]+)\+/g, "[...$1]") // catch-all :slug+ -> [...slug]
    .replace(/:([\w-]+)/g, "[$1]"); // dynamic :id -> [id]
}
