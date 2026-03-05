import { NextRequest, NextResponse } from "next/server";

/**
 * Middleware for app-router-cloudflare example.
 *
 * This file exists to reproduce the `ssrLoadModule` / `outsideEmitter` crash
 * that occurs when @cloudflare/vite-plugin is present and a middleware.ts file
 * exists. The Pages Router connect handler in index.ts calls:
 *
 *   runMiddleware(server, middlewarePath, request)
 *
 * which in turn calls server.ssrLoadModule(). With @cloudflare/vite-plugin,
 * server.ssrLoadModule() constructs an SSRCompatModuleRunner synchronously and
 * immediately calls connect() on its transport, which reads
 * environment.hot.api.outsideEmitter — a property that doesn't exist on the
 * Cloudflare DevEnvironment:
 *
 *   TypeError: Cannot read properties of undefined (reading 'outsideEmitter')
 *
 * If the regression is present, the first request to any route crashes the
 * dev server. The e2e test in cloudflare-dev/middleware.spec.ts reproduces
 * this by making a request and asserting a successful response.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("x-middleware-ran", "true");
  return response;
}

export const config = {
  matcher: ["/api/:path*", "/"],
};
