import path from "node:path";
import { compareRoutes, decodeRouteSegment } from "./utils.js";
import {
  createValidFileMatcher,
  scanWithExtensions,
  type ValidFileMatcher,
} from "./file-matcher.js";
import { patternToNextFormat, validateRoutePatterns } from "./route-validation.js";
import { createRouteTrieCache, matchRouteWithTrie } from "./route-matching.js";

export type Route = {
  /** URL pattern, e.g. "/" or "/about" or "/posts/:id" */
  pattern: string;
  /** Pre-split pattern segments (computed once at scan time, reused per request) */
  patternParts: string[];
  /** Absolute file path to the page component */
  filePath: string;
  /** Whether this is a dynamic route */
  isDynamic: boolean;
  /** Parameter names for dynamic segments */
  params: string[];
};

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

  validateRoutePatterns(routes.map((route) => route.pattern));

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

  // Convert Next.js dynamic segments to URL patterns.
  // Catch-all segments are only valid in terminal position.
  const urlSegments: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // Catch-all: [...slug] -> :slug+ (param names may contain any non-] chars)
    // Matches Next.js PARAMETER_PATTERN.
    const catchAllMatch = segment.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAllMatch) {
      if (i !== segments.length - 1) return null;
      // Guard: names ending in + or * would collide with internal pattern modifiers.
      if (catchAllMatch[1].endsWith("+") || catchAllMatch[1].endsWith("*")) return null;
      isDynamic = true;
      params.push(catchAllMatch[1]);
      urlSegments.push(`:${catchAllMatch[1]}+`);
      continue;
    }

    // Optional catch-all: [[...slug]] -> :slug* (param names may contain any non-] chars)
    const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optionalCatchAllMatch) {
      if (i !== segments.length - 1) return null;
      if (optionalCatchAllMatch[1].endsWith("+") || optionalCatchAllMatch[1].endsWith("*"))
        return null;
      isDynamic = true;
      params.push(optionalCatchAllMatch[1]);
      urlSegments.push(`:${optionalCatchAllMatch[1]}*`);
      continue;
    }

    // Dynamic segment: [id] -> :id (param names may contain any non-] chars)
    const dynamicMatch = segment.match(/^\[([^\]]+)\]$/);
    if (dynamicMatch) {
      if (dynamicMatch[1].endsWith("+") || dynamicMatch[1].endsWith("*")) return null;
      isDynamic = true;
      params.push(dynamicMatch[1]);
      urlSegments.push(`:${dynamicMatch[1]}`);
      continue;
    }

    urlSegments.push(decodeRouteSegment(segment));
  }

  const pattern = "/" + urlSegments.join("/");

  return {
    pattern: pattern === "/" ? "/" : pattern,
    patternParts: urlSegments.filter(Boolean),
    filePath: path.join(pagesDir, file),
    isDynamic,
    params,
  };
}

// Trie cache — keyed by route array identity (same array = same trie)
const trieCache = createRouteTrieCache<Route>();

/**
 * Match a URL path against a route pattern.
 * Returns the matched params or null if no match.
 */
export function matchRoute(
  url: string,
  routes: Route[],
): { route: Route; params: Record<string, string | string[]> } | null {
  return matchRouteWithTrie(url, routes, trieCache);
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
    for await (const file of scanWithExtensions(
      "**/*",
      apiDir,
      matcher.extensions,
      (name: string) => name.startsWith("_"),
    )) {
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

  validateRoutePatterns(routes.map((route) => route.pattern));

  // Sort same as page routes
  routes.sort(compareRoutes);

  return routes;
}

/**
 * Convert internal route pattern (e.g., "/posts/:id", "/docs/:slug+")
 * to Next.js bracket format (e.g., "/posts/[id]", "/docs/[...slug]").
 * Used for __NEXT_DATA__.page which apps expect in Next.js format.
 */
export { patternToNextFormat } from "./route-validation.js";
