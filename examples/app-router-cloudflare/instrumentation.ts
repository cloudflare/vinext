/**
 * instrumentation.ts for app-router-cloudflare example.
 *
 * This file exists specifically to exercise the startup crash regression:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * Root cause: when @cloudflare/vite-plugin is present, it registers a Vite
 * environment named "rsc". The vinext plugin detects server.environments["rsc"]
 * and assumes it is the @vitejs/plugin-rsc runner — but the Cloudflare plugin's
 * "rsc" environment has no .runner.import. The old code fell through to the
 * server.ssrLoadModule() fallback, which constructs SSRCompatModuleRunner
 * synchronously during configureServer(). At that point the server hasn't
 * started listening yet, so the hot channel's .api is undefined and the
 * constructor crashes.
 *
 * The fix: when no usable runner is found, defer loading until the
 * httpServer "listening" event fires, at which point ssrLoadModule is safe.
 *
 * If the regression is present, `vinext dev` exits with a non-zero code
 * before the server ever starts listening, and the e2e startup test can
 * never pass.
 */

import {
  markRegisterCalled,
  recordRequestError,
} from "./lib/instrumentation-state";

export async function register(): Promise<void> {
  markRegisterCalled();
}

export async function onRequestError(
  error: Error,
  request: { path: string; method: string; headers: Record<string, string> },
  context: {
    routerKind: string;
    routePath: string;
    routeType: string;
  },
): Promise<void> {
  recordRequestError({
    message: error.message,
    path: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
}
