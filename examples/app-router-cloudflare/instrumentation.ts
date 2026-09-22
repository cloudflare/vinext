/**
 * instrumentation.ts for app-router-cloudflare example.
 *
 * This file exercises the instrumentation.ts feature with @cloudflare/vite-plugin.
 *
 * ## How it works (new approach)
 *
 * The generated RSC entry awaits register() from its cached request-time
 * initializer before importing application modules. This means it runs:
 *
 *   - Inside the Cloudflare Worker subprocess (miniflare) when
 *     @cloudflare/vite-plugin is present — the same process as the API routes.
 *   - Inside the RSC Vite environment when @vitejs/plugin-rsc is used standalone.
 *
 * In both cases, register() runs in the same process/environment as request
 * handling, which preserves Next.js's guarantee that registration completes
 * before user modules and request handling.
 *
 * The @vercel/otel registration mirrors Next.js's on-request-error OTel E2E:
 * https://github.com/vercel/next.js/blob/canary/test/e2e/on-request-error/otel/instrumentation.js
 *
 * ## State visibility
 *
 * Because register() and the API routes now run in the same Worker module graph,
 * plain module-level variables in instrumentation-state.ts are shared between
 * them. No temp-file bridge or globalThis tricks are needed.
 */

import { registerOTel } from "@vercel/otel";
import { trace } from "@opentelemetry/api";
import {
  markRegisterCalled,
  recordRequestError,
  recordSpan,
} from "./instrumentation-state";

export async function register(): Promise<void> {
  registerOTel({
    serviceName: "vinext-app-router-cloudflare",
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) {
          recordSpan({
            name: span.name,
            serviceName: span.resource.attributes["service.name"],
            spanId: span.spanContext().spanId,
            traceId: span.spanContext().traceId,
          });
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });

  trace.getTracer("vinext-otel-e2e").startSpan("vinext.otel.registration").end();
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
