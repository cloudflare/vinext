/**
 * instrumentation.ts for pages-basic test fixture.
 *
 * This file exercises the instrumentation.ts support for Pages Router apps.
 * The key regression it covers: calling server.ssrLoadModule() during
 * configureServer() (at startup, before the server is listening) crashes in
 * Vite 7 with:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * because SSRCompatModuleRunner requires a hot channel that doesn't exist yet.
 * Pages Router apps have no RSC environment, so the loader selection in
 * index.ts falls back to `server` (ssrLoadModule). The fix must avoid calling
 * ssrLoadModule at startup — if the dev server crashes before it starts
 * listening, the e2e test for register() being called will never pass.
 */

import { markRegisterCalled, recordRequestError } from "./instrumentation-state";

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
