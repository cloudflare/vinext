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
 *
 * ## Environment isolation note
 *
 * Vite runs RSC and SSR in separate module graph environments (each with their
 * own module instances). The vinext plugin calls `runInstrumentation()` from the
 * host Node.js process (Vite plugin context), but `reportRequestError()` is
 * imported and called from the *RSC* environment's copy of this module.
 *
 * Module-level variables like `let _onRequestError` are therefore NOT shared
 * between those two copies. To bridge the environments we store the handler on
 * `globalThis` — both environments run in the same Node.js process and share
 * the same global object, so the handler set by `runInstrumentation()` is
 * immediately visible to the RSC environment's `reportRequestError()`.
 */

import fs from "node:fs";
import path from "node:path";

/** Symbol used to store the handler on globalThis (avoids collisions). */
const ON_REQUEST_ERROR_KEY = "__vinext_onRequestError__";

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

/**
 * Get the registered onRequestError handler (if any).
 *
 * Reads from globalThis so it works across Vite environment boundaries.
 */
export function getOnRequestErrorHandler(): OnRequestErrorHandler | null {
  return (globalThis as any)[ON_REQUEST_ERROR_KEY] ?? null;
}

/**
 * Load and execute the instrumentation file.
 *
 * This should be called once during server startup. It:
 * 1. Loads the instrumentation module via the RSC environment runner (preferred)
 *    or falls back to Vite's SSR module loader
 * 2. Calls the `register()` function if exported
 * 3. Stores the `onRequestError()` handler on `globalThis` so it is visible
 *    to all Vite environment module graphs (RSC, SSR, and the host process)
 *
 * We use globalThis rather than a module-level variable because Vite runs the
 * RSC and SSR environments as separate module graphs: each environment gets its
 * own copy of every module, including this one. The Vite plugin calls
 * `runInstrumentation()` from the host process copy, but `reportRequestError()`
 * is invoked from the RSC environment copy. Both copies share the same
 * Node.js globalThis, so storing the handler there is the correct bridge.
 *
 * @param loader - RSC environment runner ({ import }) or Vite dev server ({ ssrLoadModule })
 * @param instrumentationPath - Absolute path to the instrumentation file
 */
export async function runInstrumentation(
  loader:
    | { import: (id: string) => Promise<Record<string, unknown>> }
    | { ssrLoadModule: (id: string) => Promise<Record<string, unknown>> },
  instrumentationPath: string,
): Promise<void> {
  try {
    const mod = await ("import" in loader
      ? loader.import(instrumentationPath)
      : loader.ssrLoadModule(instrumentationPath));

    // Call register() if exported
    if (typeof mod.register === "function") {
      await mod.register();
    }

    // Store onRequestError handler on globalThis so all Vite environments
    // (RSC runner, SSR runner, host process) can reach the same handler.
    if (typeof mod.onRequestError === "function") {
      (globalThis as any)[ON_REQUEST_ERROR_KEY] =
        mod.onRequestError as OnRequestErrorHandler;
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
 *
 * Reads the handler from globalThis so this function works correctly regardless
 * of which Vite environment module graph it is called from.
 */
export async function reportRequestError(
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  context: OnRequestErrorContext,
): Promise<void> {
  const handler = getOnRequestErrorHandler();
  if (!handler) return;
  try {
    await handler(error, request, context);
  } catch (reportErr) {
    console.error(
      "[vinext] onRequestError handler threw:",
      reportErr instanceof Error ? reportErr.message : String(reportErr),
    );
  }
}
