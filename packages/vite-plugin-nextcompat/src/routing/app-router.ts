/**
 * App Router file-system routing.
 *
 * Scans the app/ directory following Next.js App Router conventions:
 * - app/page.tsx -> /
 * - app/about/page.tsx -> /about
 * - app/blog/[slug]/page.tsx -> /blog/:slug
 * - app/[...catchAll]/page.tsx -> /:catchAll+
 * - app/route.ts -> / (API route)
 * - app/(group)/page.tsx -> / (route groups are transparent)
 * - Layouts: app/layout.tsx wraps all children
 * - Loading: app/loading.tsx -> Suspense fallback
 * - Error: app/error.tsx -> ErrorBoundary
 * - Not Found: app/not-found.tsx
 */
import { glob } from "glob";
import path from "node:path";
import fs from "node:fs";

export interface AppRoute {
  /** URL pattern, e.g. "/" or "/about" or "/blog/:slug" */
  pattern: string;
  /** Absolute file path to the page component */
  pagePath: string | null;
  /** Absolute file path to the route handler (route.ts) */
  routePath: string | null;
  /** Ordered list of layout files from root to leaf */
  layouts: string[];
  /** Ordered list of template files from root to leaf (parallel to layouts) */
  templates: string[];
  /** Loading component path */
  loadingPath: string | null;
  /** Error component path */
  errorPath: string | null;
  /** Not-found component path */
  notFoundPath: string | null;
  /** Whether this is a dynamic route */
  isDynamic: boolean;
  /** Parameter names for dynamic segments */
  params: string[];
}

// Cache for app routes
let cachedRoutes: AppRoute[] | null = null;
let cachedAppDir: string | null = null;

export function invalidateAppRouteCache(): void {
  cachedRoutes = null;
  cachedAppDir = null;
}

/**
 * Scan the app/ directory and return a list of routes.
 */
export async function appRouter(appDir: string): Promise<AppRoute[]> {
  if (cachedRoutes && cachedAppDir === appDir) return cachedRoutes;

  // Find all page.tsx and route.ts files
  const pageFiles = await glob("**/page.{tsx,ts,jsx,js}", { cwd: appDir });
  const routeFiles = await glob("**/route.{tsx,ts,jsx,js}", { cwd: appDir });

  const routes: AppRoute[] = [];

  // Process page files
  for (const file of pageFiles) {
    const route = fileToAppRoute(file, appDir, "page");
    if (route) routes.push(route);
  }

  // Process route handler files (API routes)
  for (const file of routeFiles) {
    const route = fileToAppRoute(file, appDir, "route");
    if (route) routes.push(route);
  }

  // Sort: static routes first, then dynamic, then catch-all
  routes.sort(
    (a, b) => routePrecedence(a.pattern) - routePrecedence(b.pattern),
  );

  cachedRoutes = routes;
  cachedAppDir = appDir;
  return routes;
}

/**
 * Convert a file path relative to app/ into an AppRoute.
 */
function fileToAppRoute(
  file: string,
  appDir: string,
  type: "page" | "route",
): AppRoute | null {
  // Remove the filename (page.tsx or route.ts)
  const dir = path.dirname(file);
  const segments = dir === "." ? [] : dir.split(path.sep);

  const params: string[] = [];
  let isDynamic = false;

  // Convert segments to URL pattern, stripping route groups
  const urlSegments: string[] = [];
  for (const segment of segments) {
    // Route groups: (group) -> skip (transparent in URL)
    if (segment.startsWith("(") && segment.endsWith(")")) {
      continue;
    }

    // Catch-all: [...slug]
    const catchAllMatch = segment.match(/^\[\.\.\.(\w+)\]$/);
    if (catchAllMatch) {
      isDynamic = true;
      params.push(catchAllMatch[1]);
      urlSegments.push(`:${catchAllMatch[1]}+`);
      continue;
    }

    // Optional catch-all: [[...slug]]
    const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.(\w+)\]\]$/);
    if (optionalCatchAllMatch) {
      isDynamic = true;
      params.push(optionalCatchAllMatch[1]);
      urlSegments.push(`:${optionalCatchAllMatch[1]}*`);
      continue;
    }

    // Dynamic segment: [id]
    const dynamicMatch = segment.match(/^\[(\w+)\]$/);
    if (dynamicMatch) {
      isDynamic = true;
      params.push(dynamicMatch[1]);
      urlSegments.push(`:${dynamicMatch[1]}`);
      continue;
    }

    urlSegments.push(segment);
  }

  const pattern = "/" + urlSegments.join("/");

  // Discover layouts and templates from root to leaf
  const layouts = discoverLayouts(segments, appDir);
  const templates = discoverTemplates(segments, appDir);

  // Discover loading, error, not-found in the route's directory
  const routeDir = dir === "." ? appDir : path.join(appDir, dir);
  const loadingPath = findFile(routeDir, "loading");
  const errorPath = findFile(routeDir, "error");
  const notFoundPath = findFile(routeDir, "not-found");

  return {
    pattern: pattern === "/" ? "/" : pattern,
    pagePath: type === "page" ? path.join(appDir, file) : null,
    routePath: type === "route" ? path.join(appDir, file) : null,
    layouts,
    templates,
    loadingPath,
    errorPath,
    notFoundPath,
    isDynamic,
    params,
  };
}

/**
 * Discover all layout files from root to the given directory.
 * Each level of the directory tree may have a layout.tsx.
 */
function discoverLayouts(segments: string[], appDir: string): string[] {
  const layouts: string[] = [];

  // Check root layout
  const rootLayout = findFile(appDir, "layout");
  if (rootLayout) layouts.push(rootLayout);

  // Check each directory level
  let currentDir = appDir;
  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);
    const layout = findFile(currentDir, "layout");
    if (layout) layouts.push(layout);
  }

  return layouts;
}

/**
 * Discover all template files from root to the given directory.
 * Each level of the directory tree may have a template.tsx.
 * Templates are like layouts but re-mount on navigation.
 */
function discoverTemplates(segments: string[], appDir: string): string[] {
  const templates: string[] = [];

  // Check root template
  const rootTemplate = findFile(appDir, "template");
  if (rootTemplate) templates.push(rootTemplate);

  // Check each directory level
  let currentDir = appDir;
  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);
    const template = findFile(currentDir, "template");
    if (template) templates.push(template);
  }

  return templates;
}

/**
 * Find a file by name (without extension) in a directory.
 * Checks .tsx, .ts, .jsx, .js extensions.
 */
function findFile(dir: string, name: string): string | null {
  const extensions = [".tsx", ".ts", ".jsx", ".js"];
  for (const ext of extensions) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Match a URL against App Router routes.
 */
export function matchAppRoute(
  url: string,
  routes: AppRoute[],
): { route: AppRoute; params: Record<string, string | string[]> } | null {
  const pathname = url.split("?")[0];
  const normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\/$/, "");

  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) {
      return { route, params };
    }
  }

  return null;
}

function matchPattern(
  url: string,
  pattern: string,
): Record<string, string | string[]> | null {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  const params: Record<string, string | string[]> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];

    if (pp.endsWith("+")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }

    if (pp.endsWith("*")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      params[paramName] = remaining;
      return params;
    }

    if (pp.startsWith(":")) {
      const paramName = pp.slice(1);
      if (i >= urlParts.length) return null;
      params[paramName] = urlParts[i];
      continue;
    }

    if (i >= urlParts.length || urlParts[i] !== pp) return null;
  }

  if (urlParts.length !== patternParts.length) return null;

  return params;
}

/**
 * Route precedence — lower is higher priority.
 */
function routePrecedence(pattern: string): number {
  if (pattern.includes(":") && pattern.includes("+")) return 3;
  if (pattern.includes(":") && pattern.includes("*")) return 4;
  if (pattern.includes(":")) return 2;
  return 1;
}
