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

export interface InterceptingRoute {
  /** The interception convention: "." | ".." | "../.." | "..." */
  convention: string;
  /** The URL pattern this intercepts (e.g. "/photos/:id") */
  targetPattern: string;
  /** Absolute path to the intercepting page component */
  pagePath: string;
  /** Parameter names for dynamic segments */
  params: string[];
}

export interface ParallelSlot {
  /** Slot name (e.g. "team" from @team) */
  name: string;
  /** Absolute path to the slot's page component */
  pagePath: string | null;
  /** Absolute path to the slot's default.tsx fallback */
  defaultPath: string | null;
  /** Absolute path to the slot's layout component (wraps slot content) */
  layoutPath: string | null;
  /** Absolute path to the slot's loading component */
  loadingPath: string | null;
  /** Absolute path to the slot's error component */
  errorPath: string | null;
  /** Intercepting routes within this slot */
  interceptingRoutes: InterceptingRoute[];
  /**
   * The layout index (0-based, in route.layouts[]) that this slot belongs to.
   * Slots are passed as props to the layout at their directory level, not
   * necessarily the innermost layout. -1 means "innermost" (legacy default).
   */
  layoutIndex: number;
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
  /** Error component path (leaf directory only) */
  errorPath: string | null;
  /**
   * Per-layout error boundary paths, aligned with the layouts array.
   * Each entry is the error.tsx at the same directory level as the
   * corresponding layout (or null if that level has no error.tsx).
   * Used to interleave ErrorBoundary components with layouts so that
   * ancestor error boundaries catch errors from descendant segments.
   */
  layoutErrorPaths: (string | null)[];
  /** Not-found component path (nearest, walking up from page dir) */
  notFoundPath: string | null;
  /**
   * Not-found component paths per layout level (aligned with layouts array).
   * Each entry is the not-found.tsx at that layout's directory, or null.
   * Used to create per-layout NotFoundBoundary so that notFound() thrown from
   * a layout is caught by the parent layout's boundary (matching Next.js behavior).
   */
  notFoundPaths: (string | null)[];
  /** Forbidden component path (403) */
  forbiddenPath: string | null;
  /** Unauthorized component path (401) */
  unauthorizedPath: string | null;
  /**
   * URL segment depth for each layout in the layouts array.
   * Used by useSelectedLayoutSegments() to determine which segments are
   * below a given layout. For example, root layout has depth 0, a layout
   * at app/dashboard/ has depth 1 (one URL segment: "dashboard").
   * Route groups and parallel slots don't contribute to the depth.
   */
  layoutSegmentDepths: number[];
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

  // Discover sub-routes created by nested pages within parallel slots.
  // In Next.js, pages nested inside @slot directories create additional URL routes.
  // For example, @audience/demographics/page.tsx at app/parallel-routes/ creates
  // a route at /parallel-routes/demographics.
  const slotSubRoutes = discoverSlotSubRoutes(routes, appDir);
  routes.push(...slotSubRoutes);

  // Sort: static routes first, then dynamic, then catch-all
  routes.sort((a, b) => {
    const diff = routePrecedence(a.pattern) - routePrecedence(b.pattern);
    return diff !== 0 ? diff : a.pattern.localeCompare(b.pattern);
  });

  cachedRoutes = routes;
  cachedAppDir = appDir;
  return routes;
}

/**
 * Discover sub-routes created by nested pages within parallel slots.
 *
 * In Next.js, pages nested inside @slot directories create additional URL routes.
 * For example, given:
 *   app/parallel-routes/@audience/demographics/page.tsx
 * This creates a route at /parallel-routes/demographics where:
 * - children slot → parent's default.tsx
 * - @audience slot → @audience/demographics/page.tsx (matched)
 * - other slots → their default.tsx (fallback)
 */
function discoverSlotSubRoutes(
  routes: AppRoute[],
  _appDir: string,
): AppRoute[] {
  const syntheticRoutes: AppRoute[] = [];
  const existingPatterns = new Set(routes.map((r) => r.pattern));

  for (const parentRoute of routes) {
    if (parentRoute.parallelSlots.length === 0) continue;
    if (!parentRoute.pagePath) continue;

    const parentPageDir = path.dirname(parentRoute.pagePath);

    // Collect sub-paths from all slots.
    // Map: relative sub-path (e.g., "demographics") -> Map<slotName, pagePath>
    const subPathMap = new Map<string, Map<string, string>>();

    for (const slot of parentRoute.parallelSlots) {
      const slotDir = path.join(parentPageDir, `@${slot.name}`);
      if (!fs.existsSync(slotDir)) continue;

      const subPages = findSlotSubPages(slotDir);
      for (const { relativePath, pagePath } of subPages) {
        if (!subPathMap.has(relativePath)) {
          subPathMap.set(relativePath, new Map());
        }
        subPathMap.get(relativePath)!.set(slot.name, pagePath);
      }
    }

    if (subPathMap.size === 0) continue;

    // Find the default.tsx for the children slot at the parent directory
    const childrenDefault = findFile(parentPageDir, "default");

    for (const [subPath, slotPages] of subPathMap) {
      // Convert sub-path segments to URL pattern parts
      const subSegments = subPath.split(path.sep);
      const urlParts: string[] = [];
      const subParams: string[] = [];
      let subIsDynamic = false;

      for (const seg of subSegments) {
        // Route groups are transparent
        if (seg.startsWith("(") && seg.endsWith(")")) continue;

        const catchAllMatch = seg.match(/^\[\.\.\.(\w+)\]$/);
        if (catchAllMatch) {
          subIsDynamic = true;
          subParams.push(catchAllMatch[1]);
          urlParts.push(`:${catchAllMatch[1]}+`);
          continue;
        }
        const optionalCatchAllMatch = seg.match(/^\[\[\.\.\.(\w+)\]\]$/);
        if (optionalCatchAllMatch) {
          subIsDynamic = true;
          subParams.push(optionalCatchAllMatch[1]);
          urlParts.push(`:${optionalCatchAllMatch[1]}*`);
          continue;
        }
        const dynamicMatch = seg.match(/^\[(\w+)\]$/);
        if (dynamicMatch) {
          subIsDynamic = true;
          subParams.push(dynamicMatch[1]);
          urlParts.push(`:${dynamicMatch[1]}`);
          continue;
        }

        urlParts.push(seg);
      }

      const subUrlPath = urlParts.join("/");
      const pattern =
        parentRoute.pattern === "/"
          ? "/" + subUrlPath
          : parentRoute.pattern + "/" + subUrlPath;

      // Skip if this pattern already exists as a regular route
      if (existingPatterns.has(pattern)) continue;
      if (syntheticRoutes.some((r) => r.pattern === pattern)) continue;

      // Build parallel slots for this sub-route: matching slots get the sub-page,
      // non-matching slots get null pagePath (rendering falls back to defaultPath)
      const subSlots: ParallelSlot[] = parentRoute.parallelSlots.map(
        (slot) => ({
          ...slot,
          pagePath: slotPages.get(slot.name) || null,
        }),
      );

      syntheticRoutes.push({
        pattern,
        pagePath: childrenDefault, // children slot uses parent's default.tsx as page
        routePath: null,
        layouts: parentRoute.layouts,
        templates: parentRoute.templates,
        parallelSlots: subSlots,
        loadingPath: parentRoute.loadingPath,
        errorPath: parentRoute.errorPath,
        layoutErrorPaths: parentRoute.layoutErrorPaths,
        notFoundPath: parentRoute.notFoundPath,
        notFoundPaths: parentRoute.notFoundPaths,
        forbiddenPath: parentRoute.forbiddenPath,
        unauthorizedPath: parentRoute.unauthorizedPath,
        layoutSegmentDepths: parentRoute.layoutSegmentDepths,
        isDynamic: parentRoute.isDynamic || subIsDynamic,
        params: [...parentRoute.params, ...subParams],
      });
    }
  }

  return syntheticRoutes;
}

/**
 * Find all page files in subdirectories of a parallel slot directory.
 * Returns relative paths (from the slot dir) and absolute page paths.
 * Skips the root page.tsx (already handled as the slot's main page)
 * and intercepting route directories.
 */
function findSlotSubPages(
  slotDir: string,
): Array<{ relativePath: string; pagePath: string }> {
  const results: Array<{ relativePath: string; pagePath: string }> = [];

  function scan(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip intercepting route directories
      if (matchInterceptConvention(entry.name)) continue;
      // Skip private folders (prefixed with _)
      if (entry.name.startsWith("_")) continue;

      const subDir = path.join(dir, entry.name);
      const page = findFile(subDir, "page");
      if (page) {
        const relativePath = path.relative(slotDir, subDir);
        results.push({ relativePath, pagePath: page });
      }
      // Continue scanning deeper for nested sub-pages
      scan(subDir);
    }
  }

  scan(slotDir);
  return results;
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

    try {
      urlSegments.push(decodeURIComponent(segment));
    } catch {
      urlSegments.push(segment);
    }
  }

  const pattern = "/" + urlSegments.join("/");

  // Discover layouts and templates from root to leaf
  const layouts = discoverLayouts(segments, appDir);
  const templates = discoverTemplates(segments, appDir);

  // Compute the URL segment depth for each layout.
  // Each layout corresponds to a directory level. We need to count how many
  // of the filesystem segments up to that layout's level contribute URL segments
  // (i.e., are not route groups or parallel slots).
  const layoutSegmentDepths = computeLayoutSegmentDepths(
    segments,
    appDir,
    layouts,
  );

  // Discover per-layout error boundaries (aligned with layouts array).
  // In Next.js, each segment independently wraps its children with an ErrorBoundary.
  // This array enables interleaving error boundaries with layouts in the rendering.
  const layoutErrorPaths = discoverLayoutAlignedErrors(segments, appDir);

  // Discover loading, error in the route's directory
  const routeDir = dir === "." ? appDir : path.join(appDir, dir);
  const loadingPath = findFile(routeDir, "loading");
  const errorPath = findFile(routeDir, "error");

  // Discover not-found/forbidden/unauthorized: walk from route directory up to root (nearest wins).
  const notFoundPath = discoverBoundaryFile(segments, appDir, "not-found");
  const forbiddenPath = discoverBoundaryFile(segments, appDir, "forbidden");
  const unauthorizedPath = discoverBoundaryFile(
    segments,
    appDir,
    "unauthorized",
  );

  // Discover per-layout not-found files (one per layout directory).
  // These are used for per-layout NotFoundBoundary to match Next.js behavior where
  // notFound() thrown from a layout is caught by the parent layout's boundary.
  const notFoundPaths = discoverBoundaryFilePerLayout(layouts, "not-found");

  // Discover parallel slots (@team, @analytics, etc.).
  // Slots at the route's own directory use page.tsx; slots at ancestor directories
  // (inherited from parent layouts) use default.tsx as fallback.
  const parallelSlots = discoverInheritedParallelSlots(
    segments,
    appDir,
    routeDir,
  );

  return {
    pattern: pattern === "/" ? "/" : pattern,
    pagePath: type === "page" ? path.join(appDir, file) : null,
    routePath: type === "route" ? path.join(appDir, file) : null,
    layouts,
    templates,
    parallelSlots,
    loadingPath,
    errorPath,
    layoutErrorPaths,
    notFoundPath,
    notFoundPaths,
    forbiddenPath,
    unauthorizedPath,
    layoutSegmentDepths,
    isDynamic,
    params,
  };
}

/**
 * Compute the URL segment depth for each layout in the layouts array.
 * Root layout = 0, then each directory level that contributes a URL segment
 * increments the depth. Route groups and parallel slots don't contribute.
 */
function computeLayoutSegmentDepths(
  segments: string[],
  appDir: string,
  layouts: string[],
): number[] {
  // Build a map: layout file path → depth in URL segments
  // Walk the segments directory-by-directory, tracking cumulative URL depth
  const depthMap = new Map<string, number>();

  // Root layout (at appDir) always has depth 0
  const rootLayout = findFile(appDir, "layout");
  if (rootLayout) depthMap.set(rootLayout, 0);

  let urlDepth = 0;
  let currentDir = appDir;
  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);

    // Count URL-visible segments (skip route groups and parallel slots)
    const isRouteGroup = segment.startsWith("(") && segment.endsWith(")");
    const isParallelSlot = segment.startsWith("@");
    if (!isRouteGroup && !isParallelSlot) {
      urlDepth++;
    }

    const layout = findFile(currentDir, "layout");
    if (layout) {
      depthMap.set(layout, urlDepth);
    }
  }

  // Map the ordered layouts array to their depths
  return layouts.map((layoutPath) => depthMap.get(layoutPath) ?? 0);
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
 * Discover error.tsx files aligned with the layouts array.
 * Walks the same directory levels as discoverLayouts and, for each level
 * that contributes a layout entry, checks whether error.tsx also exists.
 * Returns an array of the same length as discoverLayouts() would return,
 * with the error path (or null) at each corresponding layout level.
 *
 * This enables interleaving ErrorBoundary components with layouts in the
 * rendering tree, matching Next.js behavior where each segment independently
 * wraps its children with an error boundary.
 */
function discoverLayoutAlignedErrors(
  segments: string[],
  appDir: string,
): (string | null)[] {
  const errors: (string | null)[] = [];

  // Root level (only if root has a layout — matching discoverLayouts logic)
  const rootLayout = findFile(appDir, "layout");
  if (rootLayout) {
    errors.push(findFile(appDir, "error"));
  }

  // Check each directory level
  let currentDir = appDir;
  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);
    const layout = findFile(currentDir, "layout");
    if (layout) {
      errors.push(findFile(currentDir, "error"));
    }
  }

  return errors;
}

/**
 * Discover the nearest boundary file (not-found, forbidden, unauthorized)
 * by walking from the route's directory up to the app root.
 * Returns the first (closest) file found, or null.
 */
function discoverBoundaryFile(
  segments: string[],
  appDir: string,
  fileName: string,
): string | null {
  // Build all directory paths from leaf to root
  const dirs: string[] = [];
  let dir = appDir;
  dirs.push(dir);
  for (const segment of segments) {
    dir = path.join(dir, segment);
    dirs.push(dir);
  }

  // Walk from leaf (last) to root (first)
  for (let i = dirs.length - 1; i >= 0; i--) {
    const f = findFile(dirs[i], fileName);
    if (f) return f;
  }
  return null;
}

/**
 * Discover boundary files (not-found, forbidden, unauthorized) at each layout directory.
 * Returns an array aligned with the layouts array, where each entry is the boundary
 * file at that layout's directory, or null if none exists there.
 *
 * This is used for per-layout error boundaries. In Next.js, each layout level
 * has its own boundary that wraps the layout's children. When notFound() is thrown
 * from a layout, it propagates up to the parent layout's boundary.
 */
function discoverBoundaryFilePerLayout(
  layouts: string[],
  fileName: string,
): (string | null)[] {
  return layouts.map((layoutPath) => {
    const layoutDir = path.dirname(layoutPath);
    return findFile(layoutDir, fileName);
  });
}

/**
 * Discover parallel slots inherited from ancestor directories.
 *
 * In Next.js, parallel slots belong to the layout that defines them. When a
 * child route is rendered, its parent layout's slots must still be present.
 * If the child doesn't have matching content in a slot, the slot's default.tsx
 * is rendered instead.
 *
 * Walk from appDir through each segment to the route's directory. At each level
 * that has @slot dirs, collect them. Slots at the route's own directory level
 * use page.tsx; slots at ancestor levels use default.tsx only.
 */
function discoverInheritedParallelSlots(
  segments: string[],
  appDir: string,
  routeDir: string,
): ParallelSlot[] {
  const slotMap = new Map<string, ParallelSlot>();

  // Walk from appDir through each segment, tracking layout indices.
  // layoutIndex tracks which position in the route's layouts[] array corresponds
  // to a given directory. Only directories with a layout.tsx file increment.
  let currentDir = appDir;
  const dirsToCheck: { dir: string; layoutIdx: number }[] = [];
  let layoutIdx = findFile(appDir, "layout") ? 0 : -1;
  dirsToCheck.push({ dir: appDir, layoutIdx: Math.max(layoutIdx, 0) });

  for (const segment of segments) {
    currentDir = path.join(currentDir, segment);
    if (findFile(currentDir, "layout")) {
      layoutIdx++;
    }
    dirsToCheck.push({ dir: currentDir, layoutIdx: Math.max(layoutIdx, 0) });
  }

  for (const { dir, layoutIdx: lvlLayoutIdx } of dirsToCheck) {
    const isOwnDir = dir === routeDir;
    const slotsAtLevel = discoverParallelSlots(dir, appDir);

    for (const slot of slotsAtLevel) {
      if (isOwnDir) {
        // At the route's own directory: use page.tsx (normal behavior)
        slot.layoutIndex = lvlLayoutIdx;
        slotMap.set(slot.name, slot);
      } else {
        // At an ancestor directory: use default.tsx as the page, not page.tsx
        // (the slot's page.tsx is for the parent route, not this child route)
        const inheritedSlot: ParallelSlot = {
          ...slot,
          pagePath: null, // Don't use ancestor's page.tsx
          layoutIndex: lvlLayoutIdx,
          // defaultPath, loadingPath, errorPath, interceptingRoutes remain
        };
        // Only inherit if we haven't seen this slot at a closer level
        if (!slotMap.has(slot.name)) {
          slotMap.set(slot.name, inheritedSlot);
        }
      }
    }
  }

  return Array.from(slotMap.values());
}

/**
 * Discover parallel route slots (@team, @analytics, etc.) in a directory.
 * Returns a ParallelSlot for each @-prefixed subdirectory that has a page or default component.
 */
function discoverParallelSlots(dir: string, appDir: string): ParallelSlot[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const slots: ParallelSlot[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;

    const slotName = entry.name.slice(1); // "@team" -> "team"
    const slotDir = path.join(dir, entry.name);

    const pagePath = findFile(slotDir, "page");
    const defaultPath = findFile(slotDir, "default");
    const interceptingRoutes = discoverInterceptingRoutes(slotDir, dir, appDir);

    // Only include slots that have at least a page, default, or intercepting route
    if (!pagePath && !defaultPath && interceptingRoutes.length === 0) continue;

    slots.push({
      name: slotName,
      pagePath,
      defaultPath,
      layoutPath: findFile(slotDir, "layout"),
      loadingPath: findFile(slotDir, "loading"),
      errorPath: findFile(slotDir, "error"),
      interceptingRoutes,
      layoutIndex: -1, // Will be set by discoverInheritedParallelSlots
    });
  }

  return slots;
}

/**
 * The interception convention prefix patterns.
 * (.) — same level, (..) — one level up, (..)(..)" — two levels up, (...) — root
 */
const INTERCEPT_PATTERNS = [
  { prefix: "(...)", convention: "..." },
  { prefix: "(..)(..)", convention: "../.." },
  { prefix: "(..)", convention: ".." },
  { prefix: "(.)", convention: "." },
] as const;

/**
 * Discover intercepting routes inside a parallel slot directory.
 *
 * Intercepting routes use conventions like (.)photo, (..)feed, (...), etc.
 * They intercept navigation to another route and render within the slot instead.
 *
 * @param slotDir - The parallel slot directory (e.g. app/feed/@modal)
 * @param routeDir - The directory of the route that owns this slot (e.g. app/feed)
 * @param appDir - The root app directory
 */
function discoverInterceptingRoutes(
  slotDir: string,
  routeDir: string,
  appDir: string,
): InterceptingRoute[] {
  if (!fs.existsSync(slotDir)) return [];

  const results: InterceptingRoute[] = [];

  // Recursively scan for page files inside intercepting directories
  scanForInterceptingPages(slotDir, routeDir, appDir, results);

  return results;
}

/**
 * Recursively scan a directory tree for page.tsx files that are inside
 * intercepting route directories.
 */
function scanForInterceptingPages(
  currentDir: string,
  routeDir: string,
  appDir: string,
  results: InterceptingRoute[],
): void {
  if (!fs.existsSync(currentDir)) return;

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Check if this directory name starts with an interception convention
    const interceptMatch = matchInterceptConvention(entry.name);

    if (interceptMatch) {
      // This directory is the start of an intercepting route
      // e.g. "(.)photos" means intercept same-level "photos" route
      const restOfName = entry.name.slice(interceptMatch.prefix.length);
      const interceptDir = path.join(currentDir, entry.name);

      // Find page files within this intercepting directory tree
      collectInterceptingPages(
        interceptDir,
        interceptDir,
        interceptMatch.convention,
        restOfName,
        routeDir,
        appDir,
        results,
      );
    } else {
      // Regular subdirectory — keep scanning for intercepting dirs
      scanForInterceptingPages(
        path.join(currentDir, entry.name),
        routeDir,
        appDir,
        results,
      );
    }
  }
}

/**
 * Match a directory name against interception convention prefixes.
 */
function matchInterceptConvention(
  name: string,
): { prefix: string; convention: string } | null {
  for (const pattern of INTERCEPT_PATTERNS) {
    if (name.startsWith(pattern.prefix)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Collect page.tsx files inside an intercepting route directory tree
 * and compute their target URL patterns.
 */
function collectInterceptingPages(
  currentDir: string,
  interceptRoot: string,
  convention: string,
  interceptSegment: string,
  routeDir: string,
  appDir: string,
  results: InterceptingRoute[],
): void {
  // Check for page.tsx in current directory
  const page = findFile(currentDir, "page");
  if (page) {
    const targetPattern = computeInterceptTarget(
      convention,
      interceptSegment,
      currentDir,
      interceptRoot,
      routeDir,
      appDir,
    );
    if (targetPattern) {
      results.push({
        convention,
        targetPattern: targetPattern.pattern,
        pagePath: page,
        params: targetPattern.params,
      });
    }
  }

  // Recurse into subdirectories for nested intercepting routes
  if (!fs.existsSync(currentDir)) return;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    collectInterceptingPages(
      path.join(currentDir, entry.name),
      interceptRoot,
      convention,
      interceptSegment,
      routeDir,
      appDir,
      results,
    );
  }
}

/**
 * Compute the target URL pattern for an intercepting route.
 *
 * - (.) same level: resolve relative to routeDir
 * - (..) one level up: resolve relative to parent of routeDir
 * - (..)(..)" two levels up: resolve relative to grandparent of routeDir
 * - (...) root: resolve from appDir
 */
function computeInterceptTarget(
  convention: string,
  interceptSegment: string,
  currentDir: string,
  interceptRoot: string,
  routeDir: string,
  appDir: string,
): { pattern: string; params: string[] } | null {
  // Determine the base directory for target resolution
  let baseDir: string;
  switch (convention) {
    case ".":
      baseDir = routeDir;
      break;
    case "..":
      baseDir = path.dirname(routeDir);
      break;
    case "../..":
      baseDir = path.dirname(path.dirname(routeDir));
      break;
    case "...":
      baseDir = appDir;
      break;
    default:
      return null;
  }

  // Build the target URL segments from baseDir relative to appDir
  const baseParts = path
    .relative(appDir, baseDir)
    .split(path.sep)
    .filter(Boolean);

  // Add the intercept segment and any nested path segments
  const nestedParts = path
    .relative(interceptRoot, currentDir)
    .split(path.sep)
    .filter(Boolean);
  const allSegments = [...baseParts, interceptSegment, ...nestedParts];

  // Convert segments to URL pattern
  const urlSegments: string[] = [];
  const params: string[] = [];

  for (const segment of allSegments) {
    if (segment === ".") continue;
    // Route groups and @ slots are transparent
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    if (segment.startsWith("@")) continue;

    // Dynamic segments
    const catchAllMatch = segment.match(/^\[\.\.\.(\w+)\]$/);
    if (catchAllMatch) {
      params.push(catchAllMatch[1]);
      urlSegments.push(`:${catchAllMatch[1]}+`);
      continue;
    }
    const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.(\w+)\]\]$/);
    if (optionalCatchAllMatch) {
      params.push(optionalCatchAllMatch[1]);
      urlSegments.push(`:${optionalCatchAllMatch[1]}*`);
      continue;
    }
    const dynamicMatch = segment.match(/^\[(\w+)\]$/);
    if (dynamicMatch) {
      params.push(dynamicMatch[1]);
      urlSegments.push(`:${dynamicMatch[1]}`);
      continue;
    }

    // Decode URL-encoded directory names (e.g., %5Fsites -> _sites)
    try {
      urlSegments.push(decodeURIComponent(segment));
    } catch {
      urlSegments.push(segment);
    }
  }

  const pattern = "/" + urlSegments.join("/");
  return { pattern: pattern === "/" ? "/" : pattern, params };
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

function matchPattern(
  url: string,
  pattern: string,
): Record<string, string | string[]> | null {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  const params: Record<string, string | string[]> = Object.create(null);

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
 * Route precedence — lower score is higher priority.
 * Matches Next.js specificity rules:
 * 1. Static routes first (scored by segment count, more = more specific)
 * 2. Dynamic segments penalized by position
 * 3. Catch-all comes after dynamic
 * 4. Optional catch-all last
 * 5. Lexicographic tiebreaker for determinism
 *
 * Key insight: routes with static prefix segments should have higher priority
 * than catch-all routes without them. E.g., /_sites/:subdomain/:slug* should
 * match before /:slug* because "_sites" must match exactly.
 */
function routePrecedence(pattern: string): number {
  const parts = pattern.split("/").filter(Boolean);
  let score = 0;
  let staticPrefixCount = 0;

  // Count static prefix segments (before first dynamic/catch-all)
  for (const p of parts) {
    if (p.startsWith(":") || p.endsWith("+") || p.endsWith("*")) break;
    staticPrefixCount++;
  }

  // Static prefix segments dramatically reduce score (increase priority).
  // Each static prefix segment gives -10000 priority boost.
  score -= staticPrefixCount * 10000;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.endsWith("+")) {
      score += 1000 + i; // catch-all: moderate penalty
    } else if (p.endsWith("*")) {
      score += 2000 + i; // optional catch-all: high penalty
    } else if (p.startsWith(":")) {
      score += 100 + i; // dynamic: small penalty by position
    }
    // static segments after first dynamic don't contribute extra
  }
  return score;
}
