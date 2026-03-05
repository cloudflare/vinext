/**
 * instrumentation.ts for app-router-cloudflare example.
 *
 * This file exercises the instrumentation.ts feature with @cloudflare/vite-plugin.
 *
 * ## How it works (new approach)
 *
 * register() is emitted as a top-level `await` inside the generated RSC entry
 * module by `generateRscEntry` in `app-dev-server.ts`. This means it runs:
 *
 *   - Inside the Cloudflare Worker subprocess (miniflare) when
 *     @cloudflare/vite-plugin is present — the same process as the API routes.
 *   - Inside the RSC Vite environment when @vitejs/plugin-rsc is used standalone.
 *
 * In both cases, register() runs in the same process/environment as request
 * handling, which is exactly what Next.js specifies: "called once when the
 * server starts, before any request handling."
 *
 * ## Why the old approach was broken
 *
 * The previous implementation called runInstrumentation() from configureServer()
 * in the host Node.js process. With @cloudflare/vite-plugin, the Worker runs in
 * a miniflare subprocess — a completely separate process with its own isolated
 * globalThis. Any state set by register() in the host was invisible to the Worker
 * where the API routes execute.
 *
 * Additionally, the old code crashed before the server ever started because it
 * fell through to server.ssrLoadModule() (or attempted to build a ModuleRunner
 * via the hot channel) during configureServer(), before the dev server was
 * listening — triggering:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * ## State visibility
 *
 * Because register() and the API routes now run in the same Worker module graph,
 * plain module-level variables in instrumentation-state.ts are shared between
 * them. No temp-file bridge or globalThis tricks are needed.
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
