import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import { extractExportConstString } from "./report.js";

export type AppRouteRuntime = "edge" | "nodejs";

function readSegmentRuntime(filePath: string): AppRouteRuntime | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const runtime = extractExportConstString(source, "runtime");
  if (runtime === "edge" || runtime === "experimental-edge") return "edge";
  if (runtime === "nodejs") return "nodejs";
  return null;
}

export function resolveAppRouteBuildRuntime(route: AppRoute): AppRouteRuntime {
  if (route.routePath) {
    return readSegmentRuntime(route.routePath) ?? "nodejs";
  }

  let primaryRuntime: AppRouteRuntime | null = null;
  for (const filePath of [...route.layouts, route.pagePath]) {
    if (!filePath) continue;
    primaryRuntime = readSegmentRuntime(filePath) ?? primaryRuntime;
  }
  if (primaryRuntime) return primaryRuntime;

  // Match resolveAppPageSegmentConfig: primary branch config is authoritative.
  // Slot-only config is considered in active branch order, from the slot
  // layout through nested config layouts to its active page/default module.
  for (const slot of route.parallelSlots) {
    const activePagePath = slot.pagePath ?? slot.defaultPath;
    for (const filePath of [slot.layoutPath, ...(slot.configLayoutPaths ?? []), activePagePath]) {
      if (!filePath) continue;
      const runtime = readSegmentRuntime(filePath);
      if (runtime) return runtime;
    }
  }

  return "nodejs";
}
