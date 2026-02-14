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

export interface ParallelSlot {
  /** Slot name (e.g. "team" from @team) */
  name: string;
  /** Absolute path to the slot's page component */
  pagePath: string | null;
  /** Absolute path to the slot's default.tsx fallback */
  defaultPath: string | null;
  /** Absolute path to the slot's loading component */
  loadingPath: string | null;
  /** Absolute path to the slot's error component */
  errorPath: string | null;
}

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
  /** Parallel route slots (from @slot directories at the route's directory level) */
  parallelSlots: ParallelSlot[];
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

  // Find all page.tsx and route.ts files, excluding @slot directories
  // (slot pages are not standalone routes — they're rendered as props of their parent layout)
  const allPageFiles = await glob("**/page.{tsx,ts,jsx,js}", { cwd: appDir });
  const pageFiles = allPageFiles.filter(
    (f) => !f.split(path.sep).some((s) => s.startsWith("@")),
  );
  const allRouteFiles = await glob("**/route.{tsx,ts,jsx,js}", { cwd: appDir });
  const routeFiles = allRouteFiles.filter(
    (f) => !f.split(path.sep).some((s) => s.startsWith("@")),
  );

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

  // Convert segments to URL pattern, stripping route groups and parallel slots
  const urlSegments: string[] = [];
  for (const segment of segments) {
    // Route groups: (group) -> skip (transparent in URL)
    if (segment.startsWith("(") && segment.endsWith(")")) {
      continue;
    }

    // Parallel slots: @slot -> skip (invisible in URL, content passed as layout props)
    if (segment.startsWith("@")) {
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

  // Discover parallel slots (@team, @analytics, etc.) at the route's directory
  const parallelSlots = discoverParallelSlots(routeDir);

  return {
    pattern: pattern === "/" ? "/" : pattern,
    pagePath: type === "page" ? path.join(appDir, file) : null,
    routePath: type === "route" ? path.join(appDir, file) : null,
    layouts,
    templates,
    parallelSlots,
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
 * Discover parallel route slots (@team, @analytics, etc.) in a directory.
 * Returns a ParallelSlot for each @-prefixed subdirectory that has a page or default component.
 */
function discoverParallelSlots(dir: string): ParallelSlot[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const slots: ParallelSlot[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;

    const slotName = entry.name.slice(1); // "@team" -> "team"
    const slotDir = path.join(dir, entry.name);

    const pagePath = findFile(slotDir, "page");
    const defaultPath = findFile(slotDir, "default");

    // Only include slots that have at least a page or default component
    if (!pagePath && !defaultPath) continue;

    slots.push({
      name: slotName,
      pagePath,
      defaultPath,
      loadingPath: findFile(slotDir, "loading"),
      errorPath: findFile(slotDir, "error"),
    });
  }

  return slots;
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
