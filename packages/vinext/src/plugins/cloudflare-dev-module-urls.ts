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
import { isCSSRequest, type Connect, type Plugin, type ViteDevServer } from "vite";

/**
 * Vite's internal middlewares that serve module requests (`/@vite/client`,
 * `/@id/*`, JS and CSS source files) and `/@fs/*` paths, preceded by the one
 * that strips a non-root `base` from the URL and the one that answers the HMR
 * client's reconnect ping (`Accept: text/x-vite-ping`) with a 204 instead of
 * the Worker rendering a page for it. If Vite renames them, none are found and
 * every request falls through, which is the behavior without this plugin.
 *
 * `viteServePublicMiddleware` is deliberately excluded so that `public/` files
 * reach the Worker and middleware, as they do in production. Without it, the
 * transform middleware reports a public `.js` or `.css` file as an
 * `ERR_LOAD_PUBLIC_URL` error, which is treated as a fall-through.
 */
export const VITE_MODULE_MIDDLEWARE_NAMES = new Set([
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
 * `isReferencedAsset`. Navigations to a referenced asset
 * are served too: in production its URL is under `/_next/static/`, which never
 * reaches the Worker.
 */
export const VITE_STATIC_MIDDLEWARE_NAME = "viteServeStaticMiddleware";

/**
 * The Cloudflare plugin's middleware that sends requests matching
 * `runWorkerFirst` to the Worker. It's only registered when `runWorkerFirst` is
 * set, and without it Vite's middlewares already run in their usual order.
 */
const CLOUDFLARE_PRE_MIDDLEWARE_NAME = "cloudflarePreMiddleware";

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
  // Vite only serves module URLs and files for GET and HEAD, and with a
  // non-root `base` (vinext sets it to `basePath + "/"`) only under it, so any
  // other request goes straight to the Worker.
  const url = req.url;
  if ((req.method !== "GET" && req.method !== "HEAD") || !url?.startsWith(server.config.base)) {
    next();
    return;
  }
  // Read the stack per request because Vite adds its internal middlewares
  // after the plugins' `configureServer` hooks have run. The base middleware is
  // only present with a non-root `base`, and strips it from `req.url` before
  // the module middlewares see the request.
  const stack = server.middlewares.stack;
  if (!stack.some((layer) => getHandleName(layer.handle) === CLOUDFLARE_PRE_MIDDLEWARE_NAME)) {
    next();
    return;
  }
  const handles = stack.flatMap((layer): Connect.NextHandleFunction[] => {
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
    if (isPublicFileLoadError(error)) {
      req.url = url;
      next();
      return;
    }
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

function getHandleName(handle: unknown): string | undefined {
  return typeof handle === "function" ? handle.name : undefined;
}

/**
 * Whether the transform middleware rejected a request because it is for a
 * `public/` file, which `viteServePublicMiddleware` would normally serve.
 */
function isPublicFileLoadError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_LOAD_PUBLIC_URL"
  );
}

/**
 * Whether a request URL, with any `base` already stripped, is the URL of an
 * asset that Vite gave to a module.
 *
 * The browser only learns an asset URL from a module Vite has transformed:
 * - The asset's own JS module (`import logo from "./logo.svg"` or `?url`),
 *   whose code is `export default "<url>"`, possibly followed by a query or
 *   fragment (`?t=` after HMR). Only files Vite treats as assets and `?url`
 *   imports count: other modules, such as JSON or `?raw` and `?inline`
 *   imports, export the file's contents, which could look like a URL.
 * - A JS module that uses `new URL("./logo.svg", import.meta.url)`, which Vite
 *   rewrites to `new URL("<url>", '' + import.meta.url)`.
 * - A stylesheet whose `url()` or `image-set()` Vite resolved.
 *
 * The importers of the asset's file in the module graph cover the last two.
 * Other project files can also be in the graph (Tailwind reports every file it
 * scans as a dependency of the stylesheet), and other imports name the file
 * with a query (`?raw` inlines its contents), but no module's code contains
 * their bare URL in one of these forms, so they keep reaching the Worker.
 *
 * @param server - The Vite dev server whose module graphs are searched
 * @param url - The request URL, with any `base` stripped
 * @returns `true` if a module emitted the URL for the file
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
  // environment with the decoded base, prefixed with `server.origin` when it's
  // set. JS has the URL encoded, and CSS may not.
  const base = server.config.base;
  let decodedBase = base;
  try {
    decodedBase = decodeURI(base);
  } catch {}
  const origin = server.config.server.origin?.replace(/\/+$/, "");
  const urls = [
    ...new Set(
      [pathname, decodedPathname].flatMap((p) => {
        const underBase = [base, decodedBase].map((b) => b + p.slice(1));
        return [p, ...underBase, ...(origin ? underBase.map((u) => origin + u) : [])];
      }),
    ),
  ];
  const file = resolveStaticFile(server, decodedPathname);
  const isAsset = server.config.assetsInclude(file);

  for (const environment of Object.values(server.environments)) {
    for (const module of environment.moduleGraph.getModulesByFile(file) ?? []) {
      const code = module.transformResult?.code;
      if (
        code &&
        isAssetUrlModule(module.url, isAsset) &&
        urls.some((u) => containsAssetUrl(code, u))
      ) {
        return true;
      }
      for (const importer of module.importers) {
        const code = importer.transformResult?.code;
        if (!code) continue;
        const css = isCSSRequest(importer.url);
        if (
          urls.some((u) =>
            css ? containsCssUrl(code, u) : code.includes(`new URL("${u}", '' + import.meta.url)`),
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Whether a module for the file exports the file's URL: a `?url` import, or an
 * import of an asset without Vite's `raw` or `inline` queries, which export its
 * contents.
 */
function isAssetUrlModule(moduleUrl: string, isAsset: boolean): boolean {
  if (/[?&]url(?:&|$)/.test(moduleUrl)) return true;
  return isAsset && !/[?&](?:raw|inline)(?:&|$)/.test(moduleUrl);
}

/**
 * Whether an asset module's code exports `url` as a JS string, possibly with a
 * query or fragment, as Vite's asset plugin emits it.
 */
function containsAssetUrl(code: string, url: string): boolean {
  return [`"${url}"`, `"${url}?`, `"${url}#`].some((literal) => code.includes(literal));
}

/**
 * The file `viteServeStaticMiddleware` serves for a decoded pathname, applying
 * `resolve.alias` the same way it does, so the file checked is the file served.
 *
 * @param server - The Vite dev server
 * @param pathname - The decoded request pathname, with any `base` stripped
 * @returns The absolute file path
 */
function resolveStaticFile(server: ViteDevServer, pathname: string): string {
  const root = server.config.root;
  for (const { find, replacement } of server.config.resolve.alias) {
    if (typeof find === "string" ? pathname.startsWith(find) : find.test(pathname)) {
      const redirected = pathname.replace(find, replacement);
      return path.join(
        root,
        redirected.startsWith(root + "/") ? redirected.slice(root.length) : redirected,
      );
    }
  }
  return path.join(root, pathname);
}

/**
 * Whether stylesheet code contains `url` as a resolved `url()` or `image-set()`
 * reference, the only places Vite rewrites asset URLs in CSS. The code may be
 * the CSS itself or a JS string of it, and the URL may be quoted and may keep a
 * query or fragment from the source.
 *
 * @param code - Transformed stylesheet code
 * @param url - The URL path to look for
 * @returns `true` if the URL appears as a CSS URL
 */
function containsCssUrl(code: string, url: string): boolean {
  for (let index = code.indexOf(url); index !== -1; index = code.indexOf(url, index + 1)) {
    const after = code[index + url.length];
    if (after === undefined || !/[)"',?#\\\s]/.test(after)) continue;
    const start = Math.max(0, index - 32);
    const before = code.slice(start, index);
    // `url(/a.png)`, `url("/a.png")`, or `url(\"/a.png\")` in a JS string, with
    // the same boundary before `url(` as Vite's own CSS URL matching
    const urlFunction = /(^|[^\w\-\u0080-\uffff])url\(\s*\\?["']?$/.exec(before);
    if (urlFunction && (urlFunction[1] !== "" || start === 0)) return true;
    // A quoted entry in an `image-set()` list in the same declaration
    if (!/["']$/.test(before)) continue;
    const imageSet = code.lastIndexOf("image-set(", index);
    if (imageSet !== -1 && !/[;{}]/.test(code.slice(imageSet, index))) return true;
  }
  return false;
}
