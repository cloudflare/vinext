/**
 * instrumentation.ts support
 *
 * Next.js supports an `instrumentation.ts` file at the project root that
 * exports a `register()` function. This function is called once when the
 * server starts, before any request handling. It's the recommended way to
 * set up observability tools (Sentry, Datadog, OpenTelemetry, etc.).
 *
 * Optionally, it can also export `onRequestError()` which is called when
 * an unhandled error occurs during request handling.
 *
 * References:
 * - https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import fs from "node:fs";
import path from "node:path";

/** Possible instrumentation file names. */
const INSTRUMENTATION_FILES = [
  "instrumentation.ts",
  "instrumentation.tsx",
  "instrumentation.js",
  "instrumentation.mjs",
  "src/instrumentation.ts",
  "src/instrumentation.tsx",
  "src/instrumentation.js",
  "src/instrumentation.mjs",
];

/**
 * Find the instrumentation file in the project root.
 */
export function findInstrumentationFile(root: string): string | null {
  for (const file of INSTRUMENTATION_FILES) {
    const fullPath = path.join(root, file);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * The onRequestError handler type from Next.js instrumentation.
 *
 * Called when an unhandled error occurs during request handling.
 * Provides the error, the request info, and an error context.
 */
export interface OnRequestErrorContext {
  /** The route path (e.g., '/blog/[slug]') */
  routerKind: "Pages Router" | "App Router";
  /** The matched route pattern */
  routePath: string;
  /** The route type */
  routeType: "render" | "route" | "action" | "middleware";
  /** HTTP status code that will be sent */
  revalidateReason?: "on-demand" | "stale" | undefined;
}

export type OnRequestErrorHandler = (
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  context: OnRequestErrorContext,
) => void | Promise<void>;

/** Module-level reference to the onRequestError handler. */
let _onRequestError: OnRequestErrorHandler | null = null;

/**
 * Get the registered onRequestError handler (if any).
 */
export function getOnRequestErrorHandler(): OnRequestErrorHandler | null {
  return _onRequestError;
}

/**
 * Load and execute the instrumentation file.
 *
 * This should be called once during server startup. It:
 * 1. Loads the instrumentation module via Vite's SSR module loader
 * 2. Calls the `register()` function if exported
 * 3. Stores the `onRequestError()` handler if exported
 *
 * @param server - Vite dev server (for SSR module loading)
 * @param instrumentationPath - Absolute path to the instrumentation file
 */
export async function runInstrumentation(
  server: { ssrLoadModule: (id: string) => Promise<Record<string, unknown>> },
  instrumentationPath: string,
): Promise<void> {
  try {
    const mod = await server.ssrLoadModule(instrumentationPath);

    // Call register() if exported
    if (typeof mod.register === "function") {
      await mod.register();
    }

    // Store onRequestError handler if exported
    if (typeof mod.onRequestError === "function") {
      _onRequestError = mod.onRequestError as OnRequestErrorHandler;
    }
  } catch (err) {
    console.error(
      "[vinext] Failed to load instrumentation:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Report a request error via the instrumentation handler.
 *
 * No-op if no onRequestError handler is registered.
 */
export async function reportRequestError(
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  context: OnRequestErrorContext,
): Promise<void> {
  if (!_onRequestError) return;
  try {
    await _onRequestError(error, request, context);
  } catch (reportErr) {
    console.error(
      "[vinext] onRequestError handler threw:",
      reportErr instanceof Error ? reportErr.message : String(reportErr),
    );
  }
}
