/**
 * Serve Vite's module URLs before the Cloudflare plugin applies
 * `assets.runWorkerFirst` during development.
 *
 * `vinext init` generates `runWorkerFirst: ["/*", "!/_next/static/*", ...]` so
 * middleware runs for `public/` files. In dev, the Cloudflare plugin sends every
 * request matching those patterns to the Worker before Vite's own middlewares
 * run. That includes Vite's module URLs (`/@vite/client`, `/@id/*`, `/@fs/*`,
 * source files such as `/app/globals.css`), which have no production
 * equivalent, so the Worker answers them with the app's 404 page and nothing
 * hydrates.
 *
 * This plugin registers a pre-middleware ahead of the Cloudflare plugin's and
 * gives Vite's module-serving middlewares the first chance to handle each
 * request. Vite decides what it serves: page navigations, non-GET requests, and
 * unknown paths fall through to the Cloudflare plugin unchanged.
 *
 * The same change was made in the Cloudflare plugin itself in
 * https://github.com/cloudflare/workers-sdk/pull/16281.
 *
 * See https://github.com/cloudflare/vinext/issues/4005.
 */
import path from "pathslash";
import type { Connect, Plugin, ViteDevServer } from "vite";

/**
 * Vite's internal middlewares that serve module requests (`/@vite/client`,
 * `/@id/*`, JS and CSS source files) and `/@fs/*` paths, preceded by the one
 * that strips a non-root `base` from the URL and the one that answers the HMR
 * client's reconnect ping (`Accept: text/x-vite-ping`) with a 204 instead of
 * the Worker rendering a page for it. If Vite renames them, none are found and
 * every request falls through, which is the behavior without this plugin.
 *
 * `viteServePublicMiddleware` is deliberately excluded so that `public/` files
 * reach the Worker and middleware, as they do in production.
 */
const VITE_MODULE_MIDDLEWARE_NAMES = new Set([
  "viteBaseMiddleware",
  "viteHMRPingMiddleware",
  "viteTransformMiddleware",
  "viteServeRawFsMiddleware",
]);

/**
 * Vite's internal middleware that serves files under the project root. Vite
 * gives imported assets root-relative URLs (`import logo from "./logo.svg"`
 * and CSS `url(./bg.png)` both resolve to paths like `/app/logo.svg`), and only
 * this middleware serves them. It also serves every other project file, and a
 * Worker route can share its path with one (e.g. an `api/` directory and an
 * `/api/*` route handler), so it only runs for referenced assets. See
 * `isReferencedAsset`.
 */
const VITE_STATIC_MIDDLEWARE_NAME = "viteServeStaticMiddleware";

type CloudflareDevModuleUrlsOptions = {
  /** Whether the Cloudflare Vite plugin is present. Read when the dev server starts. */
  isEnabled: () => boolean;
};

/**
 * Creates the plugin that lets Vite serve its module URLs before the Cloudflare
 * plugin's `runWorkerFirst` routing in dev.
 *
 * @param options - Plugin options
 * @returns The Vite plugin
 */
export function createCloudflareDevModuleUrlsPlugin(
  options: CloudflareDevModuleUrlsOptions,
): Plugin {
  return {
    name: "vinext:cloudflare-dev-module-urls",
    apply: "serve",
    // Pre-middlewares run in plugin order, and the Cloudflare plugin does not
    // set `enforce`, so this keeps vinext's middleware ahead of it regardless
    // of where the user lists `vinext()`.
    enforce: "pre",
    configureServer(server) {
      if (!options.isEnabled()) return;

      server.middlewares.use(function vinextCloudflareDevModuleUrls(req, res, next) {
        runViteModuleMiddlewares(server, req, res, next);
      });
    },
  };
}

/**
 * Runs Vite's module-serving middlewares in order, calling `next` once none of
 * them handle the request.
 *
 * @param server - The Vite dev server whose middleware stack is searched
 * @param req - The incoming request
 * @param res - The outgoing response
 * @param next - Called when no middleware handles the request, or with an error
 */
function runViteModuleMiddlewares(
  server: ViteDevServer,
  req: Connect.IncomingMessage,
  res: Parameters<Connect.NextHandleFunction>[1],
  next: Connect.NextFunction,
): void {
  // With a non-root `base` (vinext sets it to `basePath + "/"`), Vite only
  // serves URLs under it, so any other request goes straight to the Worker.
  const url = req.url;
  if (!url?.startsWith(server.config.base)) {
    next();
    return;
  }
  // Read the stack per request because Vite adds its internal middlewares
  // after the plugins' `configureServer` hooks have run. The base middleware is
  // only present with a non-root `base`, and strips it from `req.url` before
  // the module middlewares see the request.
  const handles = server.middlewares.stack.flatMap((layer): Connect.NextHandleFunction[] => {
    const handle = layer.handle;
    if (typeof handle !== "function") return [];
    if (VITE_MODULE_MIDDLEWARE_NAMES.has(handle.name)) {
      return [handle as Connect.NextHandleFunction];
    }
    if (handle.name === VITE_STATIC_MIDDLEWARE_NAME) {
      const serveStatic = handle as Connect.NextHandleFunction;
      return [
        (req, res, next) =>
          isReferencedAsset(server, req.url) ? serveStatic(req, res, next) : next(),
      ];
    }
    return [];
  });
  let index = 0;

  const tryNext = (error?: unknown): void => {
    if (error) {
      next(error);
      return;
    }

    const handle = handles[index++];
    if (!handle) {
      // The Cloudflare plugin matches `runWorkerFirst` against `req.url`, and
      // the Worker routes on it, so undo any rewrite by Vite's middlewares.
      req.url = url;
      next();
      return;
    }

    try {
      // Some of Vite's middlewares are async
      const result: unknown = handle(req, res, tryNext);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (e) {
      next(e);
    }
  };

  tryNext();
}

/**
 * Whether a request URL, with any `base` already stripped, is the URL of an
 * asset that Vite gave to a module.
 *
 * The browser only learns an asset URL from a module Vite has transformed: a
 * JS module that imports the asset, or a CSS file that references it with
 * `url()`. Both are recorded as importers of the asset's file in the module
 * graph, and their transformed code contains the URL. Other project files can
 * also be in the graph (Tailwind reports every file it scans as a dependency
 * of the stylesheet), but no importer's code contains their URL, so they keep
 * reaching the Worker.
 *
 * @param server - The Vite dev server whose module graphs are searched
 * @param url - The request URL, with any `base` stripped
 * @returns `true` if an importer of the file references its URL
 */
function isReferencedAsset(server: ViteDevServer, url: string | undefined): boolean {
  if (!url) return false;
  const { pathname } = new URL(url, "http://localhost");
  let decodedPathname: string;
  try {
    decodedPathname = decodeURI(pathname);
  } catch {
    return false;
  }
  // Server environments import the asset without the base, and the client
  // environment with it
  const base = server.config.base;
  const urls = new Set([pathname, decodedPathname].flatMap((p) => [p, base + p.slice(1)]));
  const file = path.join(server.config.root, decodedPathname);

  for (const environment of Object.values(server.environments)) {
    for (const module of environment.moduleGraph.getModulesByFile(file) ?? []) {
      for (const importer of module.importers) {
        const code = importer.transformResult?.code;
        if (code && [...urls].some((assetUrl) => containsUrl(code, assetUrl))) return true;
      }
    }
  }
  return false;
}

/**
 * Whether `code` contains `url` as a whole URL path, not as the end of a longer
 * path (`/a.png` in `/assets/a.png`) or the start of a longer name (`/a.png` in
 * `/a.pngx`).
 *
 * @param code - Transformed module code
 * @param url - The URL path to look for
 * @returns `true` if the URL appears delimited in the code
 */
function containsUrl(code: string, url: string): boolean {
  for (let index = code.indexOf(url); index !== -1; index = code.indexOf(url, index + 1)) {
    const before = code[index - 1];
    const after = code[index + url.length];
    if (!isUrlPathChar(before) && !isUrlPathChar(after)) return true;
  }
  return false;
}

function isUrlPathChar(char: string | undefined): boolean {
  return char !== undefined && /[\w.~%@/-]/.test(char);
}
