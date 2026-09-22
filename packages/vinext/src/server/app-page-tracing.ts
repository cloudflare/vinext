import { patternToNextFormat } from "../routing/route-validation.js";
import { recordFrameworkSpanError, type FrameworkSpan } from "./framework-tracer.js";
import { getDigestForWellKnownError, isAppRenderAbortError } from "./app-rsc-errors.js";
import { frameworkTracer } from "./tracer.js";

export function traceAppPageRender<T>(
  routePattern: string,
  operation: "prerender" | "render",
  callback: (span: FrameworkSpan) => T,
): T {
  return frameworkTracer.trace(
    createAppPageRenderSpanDescriptor(routePattern, operation),
    callback,
  );
}

export function createAppPageRenderSpanDescriptor(
  routePattern: string,
  operation: "prerender" | "render",
) {
  const route = patternToNextFormat(routePattern);
  return {
    attributes: { "next.route": route },
    name: `${operation} route (app) ${route}`,
    type: "AppRender.getBodyResult",
  } as const;
}

export function createGetLayoutOrPageModuleSpanDescriptor(segment: string) {
  return {
    attributes: { "next.segment": segment },
    name: "resolve segment modules",
    type: "NextNodeServer.getLayoutOrPageModule",
  } as const;
}

export function createComponentTreeSpanDescriptor() {
  return {
    name: "build component tree",
    type: "NextNodeServer.createComponentTree",
  } as const;
}

export function traceCreateComponentTree<T>(callback: () => T): T {
  return frameworkTracer.trace(createComponentTreeSpanDescriptor(), callback);
}

export function traceGetLayoutOrPageModule<T>(segment: string, callback: () => T): T {
  return frameworkTracer.trace(createGetLayoutOrPageModuleSpanDescriptor(segment), callback);
}

export function resolveAppPageModuleTraceSegment(
  routeSegments: readonly string[],
  treePosition: number,
): string {
  return treePosition === 0 ? "" : (routeSegments[treePosition - 1] ?? "");
}

export function recordAppPageRenderError(span: FrameworkSpan, error: unknown): void {
  if (isAppRenderAbortError(error) || getDigestForWellKnownError(error) !== undefined) return;
  recordFrameworkSpanError(span, error);
}

export function resolveAppPageTraceOperation(options: {
  hasRequestSearchParams: boolean;
  isDynamicError: boolean;
  isForceStatic: boolean;
  isKnownPrerenderedRoute: boolean;
  isPrerender: boolean;
}): "prerender" | "render" {
  // Workers span names are immutable, so only select prerender from facts
  // already established before rendering. A successful build prerender for
  // any path proves the route's fallback renders are SSG too. Query-bearing
  // requests that miss cache proof remain request-specific in vinext.
  if (options.isPrerender || options.isForceStatic || options.isDynamicError) return "prerender";
  if (options.hasRequestSearchParams) return "render";
  return options.isKnownPrerenderedRoute ? "prerender" : "render";
}
