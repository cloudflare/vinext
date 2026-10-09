/**
 * Middleware before `public/` files on Nitro's Node-like presets.
 *
 * Nitro's static handler is the first middleware of the Nitro app, so it
 * answers a request for a `public/` file before the vinext service runs, and
 * Next.js middleware never sees it. Next.js runs middleware first for every
 * request its matcher covers, public files included (vinext's own production
 * server does the same).
 *
 * The build therefore lists the public files the middleware matcher can cover,
 * and a Nitro runtime plugin sends a GET/HEAD for one of them to the vinext
 * service, the same service Nitro's renderer calls. Middleware runs there; if
 * it lets the request continue, vinext fetches the file back through the Nitro
 * app (server/nitro-public-files.ts). That nested fetch, like any fetch made
 * while the plugin handles a request, goes to the Nitro app unchanged, so the
 * static handler serves the file and a rewrite destination never runs
 * middleware again. Every other request, build assets under `/_next/static/`
 * included, keeps Nitro's static fast path.
 */

import type { NextI18nConfig } from "../config/next-config.js";
import { matchesMiddlewarePathname, type MatcherConfig } from "../server/middleware-matcher.js";
import { scanPublicFileRoutes } from "../utils/public-routes.js";

export const NITRO_MIDDLEWARE_PUBLIC_FILES_PLUGIN_ID = "#vinext/nitro-middleware-public-files";

function decodePublicFileRoute(route: string): string {
  try {
    return decodeURIComponent(route);
  } catch {
    return route;
  }
}

/**
 * The `public/` files, as the decoded pathnames Nitro's static handler looks
 * them up by, whose pathname (or, for an `index.html`, its directory's) the
 * middleware matcher can match. `has`/`missing`
 * conditions are ignored (they depend on the request), and a matcher that
 * cannot be read statically (`undefined`) covers every file, so the list never
 * misses a file middleware could run for. Middleware evaluates the full matcher
 * per request; a file it does not match is then served as usual.
 */
export function collectMiddlewareCoveredPublicFiles(options: {
  root: string;
  publicDir: string | false;
  /** The statically extracted `config.matcher`, `undefined` when unreadable. */
  matcher: unknown;
  i18n?: NextI18nConfig | null;
}): string[] {
  const matcher = options.matcher as MatcherConfig | undefined;
  const covered = new Set<string>();
  for (const route of scanPublicFileRoutes(options.root, options.publicDir)) {
    // Nitro's static handler also serves `dir/index.html` at `/dir`.
    const pathnames = route.endsWith("/index.html")
      ? [route, route.slice(0, -"/index.html".length) || "/"]
      : [route];
    if (!pathnames.some((pathname) => matchesMiddlewarePathname(pathname, matcher, options.i18n))) {
      continue;
    }
    covered.add(decodePublicFileRoute(route));
  }
  return [...covered].sort();
}

/**
 * Source of the Nitro runtime plugin. It wraps `nitroApp.fetch`, which every
 * Nitro preset reads after plugins run.
 */
export function generateNitroMiddlewarePublicFilesPlugin(coveredPublicFiles: string[]): string {
  if (coveredPublicFiles.length === 0) return "export default function () {}\n";
  return `import { AsyncLocalStorage } from "node:async_hooks";
import { fetchViteEnv } from "nitro/vite/runtime";

const coveredPublicFiles = new Set(${JSON.stringify(coveredPublicFiles)});
// Set while a request from the server is handled, so a fetch nested inside it
// (vinext fetching a public file back) reaches the Nitro app unchanged.
const handling = new AsyncLocalStorage();

// The asset id Nitro's static handler derives from a pathname: one trailing
// slash dropped, then decoded except for encoded slashes.
function toAssetId(pathname) {
  let id = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (!id.startsWith("/")) id = "/" + id;
  try {
    return decodeURIComponent(id.replace(/%2f/gi, "%252F"));
  } catch {
    return id;
  }
}

// The static handler also serves a directory's index.html and the
// precompressed .gz/.br/.zst sibling of a file.
function coversAssetId(id) {
  return coveredPublicFiles.has(id) || coveredPublicFiles.has(id === "/" ? "/index.html" : id + "/index.html");
}

function isCoveredPublicFile(pathname) {
  const id = toAssetId(pathname);
  if (coversAssetId(id)) return true;
  const uncompressed = id.replace(/\\.(?:gz|br|zst)$/, "");
  return uncompressed !== id && coversAssetId(uncompressed);
}

export default function vinextMiddlewarePublicFiles(nitroApp) {
  const fetch = nitroApp.fetch;
  nitroApp.fetch = (request) => {
    if (handling.getStore()) return fetch(request);
    return handling.run(true, () =>
      (request.method === "GET" || request.method === "HEAD") &&
      isCoveredPublicFile(new URL(request.url).pathname)
        ? fetchViteEnv("ssr", request)
        : fetch(request),
    );
  };
}
`;
}
