import { resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import type { AppRoute } from "../routing/app-router.js";
import { normalizePathSeparators } from "../utils/path.js";

/**
 * Generate the virtual SSR entry module.
 *
 * This runs in the `ssr` Vite environment. It receives an RSC stream,
 * deserializes it to a React tree, and renders to HTML.
 *
 * When `hasPagesDir` is true (hybrid App + Pages Router project), the SSR
 * entry also re-exports selected Pages server entry hooks from
 * `virtual:vinext-server-entry` so the RSC bundle can access Pages Router
 * route metadata and fallback dispatchers via `import("./ssr/index.js")`.
 *
 * Route handlers (for example `app/api/<segment>/route.ts`) are loaded on demand from the
 * RSC environment via `import.meta.viteRsc.loadModule("ssr", "index")` to
 * avoid the `react-server` condition being applied to modules that need
 * `react-dom/server` to construct NextResponse / Response bodies.
 */
export function generateSsrEntry(routes: AppRoute[] = [], hasPagesDir = false): string {
  const entryPath = resolveRuntimeEntryModule("app-ssr-entry");
  const routeHandlerImports: string[] = [];
  const routeHandlerEntries: string[] = [];
  let routeHandlerIndex = 0;
  for (const route of routes) {
    if (!route.routePath) continue;
    const routeHandlerVar = `__appRouteHandler_${routeHandlerIndex++}`;
    routeHandlerImports.push(
      `import * as ${routeHandlerVar} from ${JSON.stringify(normalizePathSeparators(route.routePath))};`,
    );
    routeHandlerEntries.push(`  ${JSON.stringify(route.pattern)}: ${routeHandlerVar},`);
  }

  return `
${routeHandlerImports.join("\n")}
export * from ${JSON.stringify(entryPath)};
export { default } from ${JSON.stringify(entryPath)};
const __appRouteHandlers = {
${routeHandlerEntries.join("\n")}
};
export function loadAppRouteHandler(pattern) {
	return __appRouteHandlers[pattern] ?? null;
}
${
  hasPagesDir
    ? `
export { handleApiRoute, pageRoutes, renderPage } from "virtual:vinext-server-entry";
`
    : ""
}`;
}
