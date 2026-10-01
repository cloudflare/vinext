import type { Connect, ViteDevServer } from "vite";
import { hasBasePath } from "../utils/base-path.js";

/** Vite's internal middlewares that follow its base middleware. */
const VITE_MIDDLEWARES_AFTER_BASE = new Set([
  "viteHMRPingMiddleware",
  "viteServePublicMiddleware",
  "viteTransformMiddleware",
  "viteServeRawFsMiddleware",
  "viteServeStaticMiddleware",
  "viteTriggerLazyBundlingMiddleware",
  "viteMemoryFilesMiddleware",
  "viteHtmlFallbackMiddleware",
]);

function pathnameOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** The WHATWG-canonical pathname (dot segments resolved), as routing sees it. */
function canonicalPathname(pathname: string): string {
  try {
    return new URL(`http://vinext.local${pathname}`).pathname;
  } catch {
    return pathname;
  }
}

/**
 * Let requests that Vite's `base` middleware would reject reach vinext.
 *
 * vinext sets Vite's `base` to `basePath + "/"`. Vite's base middleware then
 * answers 404 for everything else, which differs from Next.js in two places:
 *
 * - The bare basePath (`/docs`) is the basePath root, not a miss.
 * - Requests outside basePath must still reach the router, where
 *   `basePath: false` rewrites, redirects and headers apply (and anything
 *   unclaimed gets the framework's own 404).
 *
 * The bare basePath is passed to Vite as `basePath + "/"`, or with
 * `trailingSlash: true` redirected there, as Next.js's built-in
 * `basePath -> basePath + "/"` redirect does. Requests outside
 * basePath are marked and passed on with their URL untouched. Vite's own
 * middlewares after the base middleware (public files, module transforms,
 * static files, the HTML fallback) must skip them, as they did when Vite
 * rejected them; middlewares from other plugins still run.
 *
 * Returns the function that installs that skip. Call it once vinext has
 * captured the Vite middlewares it invokes itself and replaced any of their
 * handles.
 */
export function patchViteBaseMiddleware(
  server: ViteDevServer,
  basePath: string,
  trailingSlash: boolean,
): () => void {
  if (!basePath) return () => {};
  const stack = server.middlewares.stack;
  const baseIndex = stack.findIndex(
    ({ handle }) => typeof handle === "function" && handle.name === "viteBaseMiddleware",
  );
  const viteBaseMiddleware = stack[baseIndex]?.handle as Connect.NextHandleFunction | undefined;
  if (!viteBaseMiddleware) return () => {};

  stack[baseIndex].handle = function vinextBaseMiddleware(req, res, next) {
    const url = req.url ?? "/";
    const rawPathname = pathnameOf(url);
    const rest = url.slice(rawPathname.length);
    // Classify the URL routing will see: `/outside/%2e%2e/base/hello` is
    // `/base/hello`, and Vite must be handed that spelling to strip the base.
    const pathname = canonicalPathname(rawPathname);
    if (pathname === basePath) {
      const baseRootUrl = `${basePath}/${rest}`;
      if (trailingSlash) {
        res.writeHead(308, { Location: baseRootUrl });
        res.end();
        return;
      }
      req.url = baseRootUrl;
      return viteBaseMiddleware(req, res, next);
    }
    if (!hasBasePath(pathname, basePath)) {
      req.__vinextOutsideBasePath = true;
      return next();
    }
    if (pathname !== rawPathname) req.url = pathname + rest;
    return viteBaseMiddleware(req, res, next);
  } satisfies Connect.NextHandleFunction;

  // Vite registers its own middlewares as one run right after the base
  // middleware, before any plugin's post hook.
  const viteEntries: typeof stack = [];
  for (const entry of stack.slice(baseIndex + 1)) {
    const name = typeof entry.handle === "function" ? entry.handle.name : "";
    if (entry.route !== "/__open-in-editor" && !VITE_MIDDLEWARES_AFTER_BASE.has(name)) break;
    viteEntries.push(entry);
  }

  return () => {
    for (const entry of viteEntries) {
      const handle = entry.handle;
      // Connect only calls 4-argument handles for errors; leave those alone.
      if (typeof handle !== "function" || handle.length === 4) continue;
      const middleware = handle as Connect.NextHandleFunction;
      entry.handle = function skipOutsideBasePath(req, res, next) {
        if (req.__vinextOutsideBasePath) return next();
        return middleware(req, res, next);
      } satisfies Connect.NextHandleFunction;
    }
  };
}
