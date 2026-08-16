import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import { extractExportConstString } from "./report.js";

export type AppRouteRuntime = "edge" | "nodejs";
type ReadSegmentRuntime = (filePath: string) => AppRouteRuntime | null;

function extractMdxEsmSource(source: string): string {
  const lines = source.split(/\r?\n/);
  const blocks: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? "";
    const trimmed = line.slice(leadingWhitespace.length);
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch && leadingWhitespace.length <= 3) {
      const marker = fenceMatch[1]![0]!;
      const length = fenceMatch[1]!.length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length) fence = null;
      continue;
    }
    if (fence || leadingWhitespace.length > 3 || !/^(?:export|import)\s/.test(trimmed)) {
      continue;
    }

    const block: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "") {
      block.push(lines[index]!);
      index += 1;
    }
    blocks.push(block.join("\n"));
  }

  return blocks.join("\n");
}

function readSegmentRuntime(filePath: string): AppRouteRuntime | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const analyzableSource = filePath.toLowerCase().endsWith(".mdx")
    ? extractMdxEsmSource(source)
    : source;
  const runtime = extractExportConstString(analyzableSource, "runtime");
  if (runtime === "edge" || runtime === "experimental-edge") return "edge";
  if (runtime === "nodejs") return "nodejs";
  return null;
}

function resolveAppRouteBuildRuntimeWithReader(
  route: AppRoute,
  readRuntime: ReadSegmentRuntime,
): AppRouteRuntime {
  if (route.routePath) {
    return readRuntime(route.routePath) ?? "nodejs";
  }

  let primaryRuntime: AppRouteRuntime | null = null;
  for (const filePath of [...route.layouts, route.pagePath]) {
    if (!filePath) continue;
    primaryRuntime = readRuntime(filePath) ?? primaryRuntime;
  }
  if (primaryRuntime) return primaryRuntime;

  // Match resolveAppPageSegmentConfig: primary branch config is authoritative.
  // Slot-only config is considered in active branch order, from the slot
  // layout through nested config layouts to its active page/default module.
  for (const slot of route.parallelSlots) {
    const activePagePath = slot.pagePath ?? slot.defaultPath;
    for (const filePath of [slot.layoutPath, ...(slot.configLayoutPaths ?? []), activePagePath]) {
      if (!filePath) continue;
      const runtime = readRuntime(filePath);
      if (runtime) return runtime;
    }
  }

  return "nodejs";
}

export function resolveAppRouteBuildRuntime(route: AppRoute): AppRouteRuntime {
  return resolveAppRouteBuildRuntimeWithReader(route, readSegmentRuntime);
}

export function resolveAppRouteBuildRuntimes(
  routes: readonly AppRoute[],
): readonly AppRouteRuntime[] {
  const runtimeByPath = new Map<string, AppRouteRuntime | null>();
  const readRuntime = (filePath: string): AppRouteRuntime | null => {
    if (runtimeByPath.has(filePath)) return runtimeByPath.get(filePath) ?? null;
    const runtime = readSegmentRuntime(filePath);
    runtimeByPath.set(filePath, runtime);
    return runtime;
  };
  return routes.map((route) => resolveAppRouteBuildRuntimeWithReader(route, readRuntime));
}

/**
 * Build a stable snapshot of the runtime-qualified route loader graph.
 *
 * The App Router dev entry bakes each route's effective runtime into its
 * generated imports. Route module HMR handles ordinary source edits, but a
 * runtime change needs the virtual entry itself to be regenerated.
 */
export function createAppRouteRuntimeFingerprint(
  routes: readonly AppRoute[],
  runtimes: readonly AppRouteRuntime[] = resolveAppRouteBuildRuntimes(routes),
): string {
  return JSON.stringify(
    routes.map((route, index) => [
      route.ids?.route ?? `${route.pattern}\0${route.pagePath ?? route.routePath ?? ""}`,
      runtimes[index],
    ]),
  );
}
