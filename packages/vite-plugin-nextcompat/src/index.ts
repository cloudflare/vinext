import type { Plugin, ViteDevServer } from "vite";
import { pagesRouter, apiRouter } from "./routing/pages-router.js";
import { createSSRHandler } from "./server/dev-server.js";
import { handleApiRoute } from "./server/api-handler.js";
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

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

  return [
    {
      name: "nextcompat:config",
      enforce: "pre",

      config(config) {
        root = config.root ?? process.cwd();
        pagesDir = path.join(options.appDir ?? root, "pages");

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
          // Define NEXT_PUBLIC_* env vars for client bundle
          define: getNextPublicEnvDefines(),
        };
      },
    },
    {
      name: "nextcompat:pages-router",

      configureServer(server: ViteDevServer) {
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

              // Handle API routes first (pages/api/*)
              if (pathname.startsWith("/api/") || pathname === "/api") {
                const apiRoutes = await apiRouter(pagesDir);
                const handled = await handleApiRoute(
                  server,
                  req,
                  res,
                  url,
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
              await handler(req, res, url);
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
