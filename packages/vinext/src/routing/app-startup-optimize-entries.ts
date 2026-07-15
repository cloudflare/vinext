import path, { toSlash } from "pathslash";
import { appRouteGraph } from "./app-router.js";
import type { ValidFileMatcher } from "./file-matcher.js";
import {
  getAppRootBoundaryPath,
  getAppRootLayoutPaths,
  matchAppRootRoute,
  selectAppRootBoundaryRoute,
  visitAppRouteModulePaths,
} from "./app-route-module-load-plan.js";

export type CollectAppRouterStartupOptimizeEntriesOptions = {
  root: string;
  appDir: string;
  matcher: ValidFileMatcher;
  globalErrorPath?: string | null;
  globalNotFoundPath?: string | null;
};

/**
 * Compute the App Router dev-server `optimizeDeps.entries` as a projection of
 * the canonical route graph: exactly the convention modules that rendering the
 * root URL ("/") loads, made relative to the project root.
 *
 * Why a projection and not a bespoke filesystem walk: App Router startup
 * semantics (transparent `@children`, slot root pages discovered through route
 * groups, which route-group branch actually resolves to "/", which slot layout
 * the renderer wraps with) already live in `appRouteGraph`. Re-deriving a
 * subset by hand drifts from those facts — it both misses real startup modules
 * (an `app/@children/page.tsx` root page) and over-includes non-startup ones (an
 * `app/(admin)/layout.tsx` that only wraps `/dashboard`). Deriving the set from
 * the graph keeps a single source of truth: whatever the graph loads to render
 * "/" is precisely what we pre-optimize, and nothing else.
 *
 * Route modules below "/" stay out of the set on purpose — they are lazy
 * `import()` thunks in the generated RSC manifest, discovered when their route
 * is first requested, so the first dev response no longer scales with total
 * route count.
 */
export async function collectAppRouterStartupOptimizeEntries({
  root,
  appDir,
  matcher,
  globalErrorPath,
  globalNotFoundPath,
}: CollectAppRouterStartupOptimizeEntriesOptions): Promise<string[]> {
  const entries = new Set<string>();
  const add = (absPath: string | null | undefined): void => {
    if (absPath) entries.add(toSlash(path.relative(root, absPath)));
  };

  const { routes } = await appRouteGraph(appDir, undefined, matcher);
  const matchedRootRoute = matchAppRootRoute(routes);
  const rootBoundaryRoute = selectAppRootBoundaryRoute(routes, matchedRootRoute);

  add(globalErrorPath);
  getAppRootLayoutPaths(rootBoundaryRoute).forEach(add);
  add(
    getAppRootBoundaryPath(
      rootBoundaryRoute,
      rootBoundaryRoute?.notFoundPaths,
      rootBoundaryRoute?.notFoundPath,
    ),
  );
  add(
    getAppRootBoundaryPath(
      rootBoundaryRoute,
      rootBoundaryRoute?.forbiddenPaths,
      rootBoundaryRoute?.forbiddenPath,
    ),
  );
  add(
    getAppRootBoundaryPath(
      rootBoundaryRoute,
      rootBoundaryRoute?.unauthorizedPaths,
      rootBoundaryRoute?.unauthorizedPath,
    ),
  );

  if (matchedRootRoute) {
    visitAppRouteModulePaths(
      matchedRootRoute,
      {
        includeBaseModules: true,
        includeSlotModules: true,
        includeInterceptions: false,
      },
      add,
    );
  } else {
    // A route-miss request loads global-not-found lazily when the experiment is
    // enabled. It is not part of matched-root startup and stays code-split.
    add(globalNotFoundPath);
  }

  return [...entries];
}
