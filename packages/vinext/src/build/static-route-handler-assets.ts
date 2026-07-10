import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import { extractExportConstNumber, extractExportConstString, hasNamedExport } from "./report.js";

type RouteHandlerCandidate = Pick<AppRoute, "pagePath" | "routePath" | "isDynamic">;

export function isExplicitStaticGetRouteHandler(route: RouteHandlerCandidate): boolean {
  if (route.routePath === null || route.pagePath !== null || route.isDynamic) return false;

  let code: string;
  try {
    code = fs.readFileSync(route.routePath, "utf-8");
  } catch {
    return false;
  }

  if (!hasNamedExport(code, "GET")) return false;

  const dynamic = extractExportConstString(code, "dynamic");
  const revalidate = extractExportConstNumber(code, "revalidate");

  if (dynamic === "force-dynamic" || revalidate === 0) return false;
  if (typeof revalidate === "number" && Number.isFinite(revalidate)) return false;

  return dynamic === "force-static" || dynamic === "error" || revalidate === Infinity;
}

export function getRouteHandlerAssetOutputPath(pathname: string): string | null {
  if (!pathname.startsWith("/") || pathname === "/") return null;

  const segments = pathname.slice(1).split("/");
  if (segments.some((segment) => !isSafeAssetPathSegment(segment))) return null;

  return segments.join("/");
}

function isSafeAssetPathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

export function getStaticRouteHandlerResponseHeaders(headers: Headers): Record<string, string> {
  const contentType = headers.get("content-type");
  return contentType ? { "content-type": contentType } : {};
}
