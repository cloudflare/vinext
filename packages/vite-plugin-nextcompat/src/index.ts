import type { Plugin, ViteDevServer } from "vite";
import { pagesRouter, apiRouter, invalidateRouteCache } from "./routing/pages-router.js";
import { createSSRHandler } from "./server/dev-server.js";
import { handleApiRoute } from "./server/api-handler.js";
import {
  loadNextConfig,
  resolveNextConfig,
  type ResolvedNextConfig,
  type NextRedirect,
  type NextRewrite,
} from "./config/next-config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface NextcompatOptions {
  /** Root directory of the Next.js app (default: Vite root) */
  appDir?: string;
}

export default function nextcompat(options: NextcompatOptions = {}): Plugin[] {
  let root: string;
  let pagesDir: string;
  let nextConfig: ResolvedNextConfig;

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

  return [
    {
      name: "nextcompat:config",
      enforce: "pre",

      async config(config) {
        root = config.root ?? process.cwd();
        pagesDir = path.join(options.appDir ?? root, "pages");

        // Load next.config.js if present
        const rawConfig = await loadNextConfig(options.appDir ?? root);
        nextConfig = await resolveNextConfig(rawConfig);

        // Merge env from next.config.js with NEXT_PUBLIC_* env vars
        const defines = getNextPublicEnvDefines();
        for (const [key, value] of Object.entries(nextConfig.env)) {
          defines[`process.env.${key}`] = JSON.stringify(value);
        }

        return {
          // Disable Vite's default HTML serving - we handle all routing
          appType: "custom",
          // Externalize React packages from SSR transform — they are CJS and
          // must be loaded natively by Node, not through Vite's ESM evaluator.
          ssr: {
            external: ["react", "react-dom", "react-dom/server"],
          },
          resolve: {
            alias: {
              "next/link": path.join(shimsDir, "link"),
              "next/head": path.join(shimsDir, "head"),
              "next/router": path.join(shimsDir, "router"),
              "next/image": path.join(shimsDir, "image"),
              "next/dynamic": path.join(shimsDir, "dynamic"),
              "next/app": path.join(shimsDir, "app"),
              "next/document": path.join(shimsDir, "document"),
            },
          },
          // Enable JSX in .tsx/.jsx files
          esbuild: {
            jsx: "automatic",
          },
          // Define env vars for client bundle
          define: defines,
          // Set base path if configured
          ...(nextConfig.basePath ? { base: nextConfig.basePath + "/" } : {}),
        };
      },
    },
    {
      name: "nextcompat:pages-router",

      configureServer(server: ViteDevServer) {
        // Watch pages directory for file additions/removals to invalidate route cache.
        // Content changes don't affect routing, only new/deleted files do.
        const pageExtensions = /\.(tsx?|jsx?)$/;
        server.watcher.on("add", (filePath: string) => {
          if (filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
        });
        server.watcher.on("unlink", (filePath: string) => {
          if (filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
        });

        // Return a function to register middleware AFTER Vite's built-in middleware
        return () => {
          server.middlewares.use(async (req: any, res: any, next: any) => {
            try {
              const url: string = req.url ?? "/";

              // Skip Vite internal requests and static files
              if (
                url.startsWith("/@") ||
                url.startsWith("/__vite") ||
                url.startsWith("/node_modules")
              ) {
                return next();
              }

              // Skip requests for files with extensions (static assets)
              const pathname = url.split("?")[0];
              if (pathname.includes(".") && !pathname.endsWith(".html")) {
                return next();
              }

              // Apply custom headers from next.config.js
              if (nextConfig?.headers.length) {
                applyHeaders(pathname, res, nextConfig.headers);
              }

              // Apply redirects from next.config.js
              if (nextConfig?.redirects.length) {
                const redirected = applyRedirects(
                  pathname,
                  res,
                  nextConfig.redirects,
                );
                if (redirected) return;
              }

              // Apply rewrites from next.config.js (beforeFiles)
              let resolvedUrl = url;
              if (nextConfig?.rewrites.beforeFiles.length) {
                resolvedUrl =
                  applyRewrites(pathname, nextConfig.rewrites.beforeFiles) ??
                  url;
              }

              // Handle API routes first (pages/api/*)
              const resolvedPathname = resolvedUrl.split("?")[0];
              if (
                resolvedPathname.startsWith("/api/") ||
                resolvedPathname === "/api"
              ) {
                const apiRoutes = await apiRouter(pagesDir);
                const handled = await handleApiRoute(
                  server,
                  req,
                  res,
                  resolvedUrl,
                  apiRoutes,
                );
                if (handled) return;
                // No API route matched — fall through to 404
                res.statusCode = 404;
                res.end("404 - API route not found");
                return;
              }

              const routes = await pagesRouter(pagesDir);
              const handler = createSSRHandler(server, routes, pagesDir);
              await handler(req, res, resolvedUrl);
            } catch (e) {
              next(e);
            }
          });
        };
      },
    },
  ];
}

/**
 * Collect all NEXT_PUBLIC_* env vars and create Vite define entries
 * so they get inlined into the client bundle.
 */
function getNextPublicEnvDefines(): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value !== undefined) {
      defines[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  return defines;
}

/**
 * Match a Next.js route pattern (e.g. "/blog/:slug") against a pathname.
 * Returns matched params or null.
 */
function matchConfigPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  // Convert Next.js-style :param to regex
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (parts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      params[parts[i].slice(1)] = pathParts[i];
    } else if (parts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Apply redirect rules from next.config.js.
 * Returns true if a redirect was applied.
 */
function applyRedirects(
  pathname: string,
  res: any,
  redirects: NextRedirect[],
): boolean {
  for (const redirect of redirects) {
    const params = matchConfigPattern(pathname, redirect.source);
    if (params) {
      // Replace :param placeholders in destination
      let dest = redirect.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}`, value);
      }
      res.writeHead(redirect.permanent ? 308 : 307, { Location: dest });
      res.end();
      return true;
    }
  }
  return false;
}

/**
 * Apply rewrite rules from next.config.js.
 * Returns the rewritten URL or null if no rewrite matched.
 */
function applyRewrites(
  pathname: string,
  rewrites: NextRewrite[],
): string | null {
  for (const rewrite of rewrites) {
    const params = matchConfigPattern(pathname, rewrite.source);
    if (params) {
      let dest = rewrite.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}`, value);
      }
      return dest;
    }
  }
  return null;
}

/**
 * Apply custom header rules from next.config.js.
 */
function applyHeaders(
  pathname: string,
  res: any,
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>,
): void {
  for (const rule of headers) {
    // Simple match: exact or glob-like (just check if source matches)
    // Next.js uses path-to-regexp for matching; we use a simpler approach
    const sourceRegex = new RegExp(
      "^" + rule.source.replace(/\*/g, ".*").replace(/:\w+/g, "[^/]+") + "$",
    );
    if (sourceRegex.test(pathname)) {
      for (const header of rule.headers) {
        res.setHeader(header.key, header.value);
      }
    }
  }
}
