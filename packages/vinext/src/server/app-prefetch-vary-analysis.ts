import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";

export type AppPrefetchCapabilityAnalysis = {
  canPrefetchFullStaticRoute: boolean;
  canPrefetchRuntimeShell: boolean;
  canPrefetchStaticRoute: boolean;
};

function readSource(filePath: string | null | undefined): string {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function sourceAllowsRuntimePrefetch(source: string): boolean {
  return (
    /\bexport\s+const\s+prefetch\s*=\s*["']allow-runtime["']/.test(source) ||
    /\bexport\s+const\s+unstable_instant\b[\s\S]*?\bprefetch\s*:\s*["']runtime["']/.test(source)
  );
}

function sourceHasGenerateStaticParams(source: string): boolean {
  return /\bexport\s+(?:async\s+)?function\s+generateStaticParams\b/.test(source);
}

/**
 * Build-time analysis is deliberately limited to route capabilities. Vary
 * identities are learned from the server render's observed params/searchParams
 * reads and attached to the completed RSC response. Dependency inference from
 * source text cannot follow imported helpers or model runtime boundaries such
 * as `connection()` correctly.
 */
export function analyzeAppPrefetchCapabilities(route: AppRoute): AppPrefetchCapabilityAnalysis {
  const pageSource = readSource(route.pagePath);
  const pageHasGenerateStaticParams = sourceHasGenerateStaticParams(pageSource);
  const fullDepthLayoutHasGenerateStaticParams = route.layouts.some(
    (layoutPath, index) =>
      (route.layoutTreePositions[index] ?? 0) >= route.routeSegments.length &&
      sourceHasGenerateStaticParams(readSource(layoutPath)),
  );
  return {
    canPrefetchFullStaticRoute:
      !route.isDynamic || pageHasGenerateStaticParams || fullDepthLayoutHasGenerateStaticParams,
    canPrefetchRuntimeShell: sourceAllowsRuntimePrefetch(pageSource),
    canPrefetchStaticRoute:
      !route.isDynamic ||
      pageHasGenerateStaticParams ||
      route.layouts.some((layoutPath) => sourceHasGenerateStaticParams(readSource(layoutPath))),
  };
}
