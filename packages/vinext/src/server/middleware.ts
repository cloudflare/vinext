/**
 * proxy.ts / middleware.ts runner
 *
 * Loads and executes the user's proxy.ts (Next.js 16) or middleware.ts file
 * before routing. Runs in Node (not Edge Runtime), per the vinext design.
 *
 * In Next.js 16, proxy.ts replaces middleware.ts:
 * - proxy.ts: default export OR named `proxy` function, runs on Node.js runtime
 * - middleware.ts: deprecated but still supported for Edge runtime use cases
 *
 * The proxy/middleware receives a NextRequest and can:
 * - Return NextResponse.next() to continue to the route
 * - Return NextResponse.redirect() to redirect
 * - Return NextResponse.rewrite() to rewrite the URL
 * - Set/modify headers and cookies
 * - Return a Response directly (e.g., for auth guards)
 *
 * Supports the `config.matcher` export for path filtering.
 */

import type { ModuleRunner } from "vite/module-runner";
import fs from "node:fs";
import path from "node:path";
import type { NextI18nConfig } from "../config/next-config.js";
import { ValidFileMatcher } from "../routing/file-matcher.js";
import {
  resolveMiddlewareModuleHandler,
  runGeneratedMiddleware,
  type MiddlewareModule,
  type MiddlewareResult,
} from "./middleware-runtime.js";

export { matchPattern, matchesMiddleware } from "./middleware-matcher.js";

/**
 * Determine whether a middleware/proxy file path refers to a proxy file.
 * proxy.ts files accept `proxy` or `default` exports.
 * middleware.ts files accept `middleware` or `default` exports.
 *
 * Matches Next.js behavior where each file type only accepts its own
 * named export or a default export:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/templates/middleware.ts
 */
export function isProxyFile(filePath: string): boolean {
  const base = path.basename(filePath).replace(/\.\w+$/, "");
  return base === "proxy";
}

/**
 * Resolve the middleware/proxy handler function from a module's exports.
 * Matches Next.js behavior: for proxy files, check `proxy` then `default`;
 * for middleware files, check `middleware` then `default`.
 *
 * Throws if the file exists but doesn't export a valid function, matching
 * Next.js's ProxyMissingExportError behavior.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/build/templates/middleware.ts
 * @see https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/proxy-missing-export/proxy-missing-export.test.ts
 */
export function resolveMiddlewareHandler(mod: MiddlewareModule, filePath: string) {
  return resolveMiddlewareModuleHandler(mod, {
    filePath,
    isProxy: isProxyFile(filePath),
  });
}

const MIDDLEWARE_LOCATIONS = ["", "src/"];

/**
 * Find the proxy or middleware file in the project root.
 * Checks for proxy.ts (Next.js 16) first, then falls back to middleware.ts.
 * If middleware.ts is found, logs a deprecation warning.
 */
export function findMiddlewareFile(root: string, fileMatcher: ValidFileMatcher): string | null {
  // Check proxy.ts first (Next.js 16 replacement for middleware.ts)
  for (const dir of MIDDLEWARE_LOCATIONS) {
    for (const ext of fileMatcher.dottedExtensions) {
      const fullPath = path.join(root, dir, `proxy${ext}`);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  // Fall back to middleware.ts (deprecated in Next.js 16)
  for (const dir of MIDDLEWARE_LOCATIONS) {
    for (const ext of fileMatcher.dottedExtensions) {
      const fullPath = path.join(root, dir, `middleware${ext}`);
      if (fs.existsSync(fullPath)) {
        console.warn(
          "[vinext] middleware.ts is deprecated in Next.js 16. " +
            "Rename to proxy.ts and export a default or named proxy function.",
        );
        return fullPath;
      }
    }
  }
  return null;
}

function isMiddlewareModule(value: unknown): value is MiddlewareModule {
  return !!value && typeof value === "object";
}

/**
 * Load and execute middleware for a given request.
 *
 * @param runner - A ModuleRunner used to load the middleware module.
 *   Must be a long-lived instance created once (e.g. in configureServer) via
 *   createDirectRunner() — NOT recreated per request. Using server.ssrLoadModule
 *   directly crashes with `outsideEmitter` when @cloudflare/vite-plugin is
 *   present because SSRCompatModuleRunner reads environment.hot.api synchronously.
 * @param middlewarePath - Absolute path to the middleware file
 * @param request - The incoming Request object
 * @returns Middleware result describing what action to take
 */
export async function runMiddleware(
  runner: ModuleRunner,
  middlewarePath: string,
  request: Request,
  i18nConfig?: NextI18nConfig | null,
  basePath?: string,
): Promise<MiddlewareResult> {
  // Load the middleware module via the direct-call ModuleRunner.
  // This bypasses the hot channel entirely and is safe with all Vite plugin
  // combinations, including @cloudflare/vite-plugin.
  const mod = await runner.import(middlewarePath);
  if (!isMiddlewareModule(mod)) {
    throw new Error(`Middleware module "${middlewarePath}" did not evaluate to an object.`);
  }

  return runGeneratedMiddleware({
    basePath,
    filePath: middlewarePath,
    i18nConfig,
    includeErrorDetails: process.env.NODE_ENV !== "production",
    isProxy: isProxyFile(middlewarePath),
    module: mod,
    request,
  });
}
