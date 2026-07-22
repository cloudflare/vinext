import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "pathslash";
import { isInvisibleSegment } from "./routing/app-route-graph.js";
import { appRouteGraph } from "./routing/app-router.js";
import { patternToNextFormat } from "./routing/route-validation.js";
import { decodeRouteSegment } from "./routing/utils.js";
import { compareStrings } from "./utils/compare.js";
import { findDir } from "./utils/project.js";

type GenerateRouteTypesOptions = {
  root: string;
  appDir?: string | null;
  pageExtensions?: readonly string[];
};

export type GenerateRouteTypesResult = {
  routeTypesPath: string;
  nextEnvPath: string;
  nextEnvStatus: "created" | "updated" | "unchanged";
};

type ParamShape = Map<string, "string" | "string[]" | "string[]?">;

export function nextEnvFileContent(hasNext: boolean, hasAppDir: boolean, eol = "\n"): string {
  const typeReference = hasNext
    ? `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "vinext/types/augmentations";
`
    : `import "vinext/types";
`;

  return `${typeReference}import "./.next/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/${hasAppDir ? "app" : "pages"}/api-reference/config/typescript for more information.
`.replaceAll("\n", eol);
}

export async function generateRouteTypes(
  options: GenerateRouteTypesOptions,
): Promise<GenerateRouteTypesResult> {
  const root = path.resolve(options.root);
  const appDir =
    options.appDir === null
      ? null
      : options.appDir
        ? path.resolve(options.appDir)
        : findDir(root, "app", "src/app");
  const outPath = path.join(root, ".next", "types", "routes.d.ts");
  const pagesDir = findDir(root, "pages", "src/pages");

  const content = appDir
    ? renderRouteTypes(
        await collectRouteTypeModel(appDir, options.pageExtensions),
        pagesDir !== null,
      )
    : renderRouteTypes(emptyRouteTypeModel(), false);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, content, "utf-8");
  const nextEnv = await ensureNextEnvFile(root, appDir !== null);
  return {
    routeTypesPath: outPath,
    nextEnvPath: nextEnv.path,
    nextEnvStatus: nextEnv.status,
  };
}

async function ensureNextEnvFile(
  root: string,
  hasAppDir: boolean,
): Promise<{ path: string; status: GenerateRouteTypesResult["nextEnvStatus"] }> {
  const envPath = path.join(root, "next-env.d.ts");
  let eol = os.EOL;
  let existing: string | undefined;
  try {
    existing = await fs.readFile(envPath, "utf-8");
    const newline = existing.indexOf("\n", 1);
    if (newline !== -1) eol = existing[newline - 1] === "\r" ? "\r\n" : "\n";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const hasNext = await hasNextPackage(root);
  const content = nextEnvFileContent(hasNext, hasAppDir, eol);
  if (existing === content) return { path: envPath, status: "unchanged" };
  await fs.writeFile(envPath, content, "utf-8");
  return { path: envPath, status: existing === undefined ? "created" : "updated" };
}

async function hasNextPackage(root: string): Promise<boolean> {
  const manifestPath = path.join(root, "package.json");
  let declaresNext: boolean | undefined;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as Record<
      string,
      unknown
    >;
    declaresNext = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ].some((field) => {
      const dependencies = manifest[field];
      return (
        typeof dependencies === "object" &&
        dependencies !== null &&
        Object.hasOwn(dependencies, "next")
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (declaresNext === false) return false;

  try {
    const packageJsonPath = createRequire(manifestPath).resolve("next/package.json");
    // Node caches successful resolution paths. Confirm the package still
    // exists so a running dev process also handles Next.js being removed.
    await fs.access(packageJsonPath);
    return true;
  } catch {
    return false;
  }
}

type RouteTypeModel = {
  pageRoutes: string[];
  layoutRoutes: string[];
  routeHandlerRoutes: string[];
  params: Map<string, ParamShape>;
  layoutSlots: Map<string, string[]>;
};

function emptyRouteTypeModel(): RouteTypeModel {
  return {
    pageRoutes: [],
    layoutRoutes: [],
    routeHandlerRoutes: [],
    params: new Map(),
    layoutSlots: new Map(),
  };
}

async function collectRouteTypeModel(
  appDir: string,
  pageExtensions?: readonly string[],
): Promise<RouteTypeModel> {
  const graph = await appRouteGraph(appDir, pageExtensions);
  const model = emptyRouteTypeModel();
  const segmentGraph = graph.routeManifest.segmentGraph;
  const layoutRouteKeys = createLayoutRouteKeyMap(segmentGraph.layouts.values());
  const pageRouteSet = new Set<string>();
  const layoutRouteSet = new Set<string>();
  const routeHandlerRouteSet = new Set<string>();

  for (const route of segmentGraph.pages.values()) {
    const routeEntry = segmentGraph.routes.get(route.routeId);
    addRoute(
      model.pageRoutes,
      pageRouteSet,
      model.params,
      patternToNextFormat(route.pattern),
      paramsForPatternParts(routeEntry?.patternParts ?? []),
    );
  }

  for (const route of segmentGraph.routeHandlers.values()) {
    const routeEntry = segmentGraph.routes.get(route.routeId);
    addRoute(
      model.routeHandlerRoutes,
      routeHandlerRouteSet,
      model.params,
      patternToNextFormat(route.pattern),
      paramsForPatternParts(routeEntry?.patternParts ?? []),
    );
  }

  for (const layout of segmentGraph.layouts.values()) {
    const route = layoutRouteKeys.get(layout.treePath) ?? treePathToRouteLiteral(layout.treePath);
    addRoute(
      model.layoutRoutes,
      layoutRouteSet,
      model.params,
      route,
      paramsForPatternParts(layout.patternParts),
    );
  }

  const layoutSlotSets = new Map<string, Set<string>>();
  for (const slot of segmentGraph.slots.values()) {
    const layoutRoute = layoutRouteKeyForSlot(slot, segmentGraph.layouts, layoutRouteKeys);
    if (!layoutRoute) continue;

    let slotNames = layoutSlotSets.get(layoutRoute);
    if (!slotNames) {
      slotNames = new Set();
      layoutSlotSets.set(layoutRoute, slotNames);
      model.layoutSlots.set(layoutRoute, []);
    }
    if (!slotNames.has(slot.name)) {
      slotNames.add(slot.name);
      model.layoutSlots.get(layoutRoute)?.push(slot.name);
    }
  }

  // Sort all collected route lists once after collection. addRoute() and the
  // slot loop above intentionally skip per-insertion sorts to keep collection
  // O(n) — the rendered output relies on stable sorted order, so the single
  // pass here is enough.
  model.pageRoutes.sort(compareStrings);
  model.layoutRoutes.sort(compareStrings);
  model.routeHandlerRoutes.sort(compareStrings);
  for (const slotNames of model.layoutSlots.values()) slotNames.sort(compareStrings);

  return model;
}

function renderRouteTypes(model: RouteTypeModel, hasPagesCompat: boolean): string {
  const allRoutes = uniqueSorted([
    ...model.pageRoutes,
    ...model.layoutRoutes,
    ...model.routeHandlerRoutes,
  ]);

  const navigationCompat = hasPagesCompat
    ? `
declare module "next/navigation" {
  function useSearchParams(): import("next/navigation").ReadonlyURLSearchParams | null;
  function usePathname(): string | null;
  function useParams<
    T extends Record<string, string | string[]> = Record<string, string | string[]>,
  >(): T | null;
  function useSelectedLayoutSegments(): string[] | null;
  function useSelectedLayoutSegment(): string | null;
}
`
    : "";

  return `// This file is generated by vinext. Do not edit.
import type * as React from "react";

declare global {
  type PageProps<Route extends VinextRouteTypes.PageRoute = VinextRouteTypes.PageRoute> = {
    params: Promise<VinextRouteTypes.ParamMap[Route]>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  };

  type LayoutProps<Route extends VinextRouteTypes.LayoutRoute> = {
    params: Promise<VinextRouteTypes.ParamMap[Route]>;
    children: React.ReactNode;
  } & {
    [K in VinextRouteTypes.LayoutSlotMap[Route]]: React.ReactNode;
  };

  type RouteContext<Route extends VinextRouteTypes.RouteHandlerRoute = VinextRouteTypes.RouteHandlerRoute> = {
    params: Promise<VinextRouteTypes.ParamMap[Route]>;
  };
}

declare namespace VinextRouteTypes {
  type PageRoute = ${routeUnion(model.pageRoutes)};
  type LayoutRoute = ${routeUnion(model.layoutRoutes)};
  type RouteHandlerRoute = ${routeUnion(model.routeHandlerRoutes)};
  type AppRoute = ${routeUnion(allRoutes)};

  interface ParamMap {
${renderParamMap(allRoutes, model.params)}
  }

  interface LayoutSlotMap {
${renderLayoutSlotMap(model.layoutRoutes, model.layoutSlots)}
  }
}

${navigationCompat}

export {};
`;
}

function renderParamMap(
  routes: readonly string[],
  params: ReadonlyMap<string, ParamShape>,
): string {
  if (routes.length === 0) return "    [route: string]: {};\n";

  return routes
    .map((route) => `    ${quote(route)}: ${renderParamShape(params.get(route) ?? new Map())};`)
    .join("\n");
}

function renderParamShape(params: ParamShape): string {
  if (params.size === 0) return "{}";

  const fields = Array.from(params.entries())
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([name, kind]) => {
      const optional = kind === "string[]?";
      const valueType = optional ? "string[]" : kind;
      return `${propertyName(name)}${optional ? "?" : ""}: ${valueType};`;
    });

  return `{ ${fields.join(" ")} }`;
}

function renderLayoutSlotMap(
  layoutRoutes: readonly string[],
  layoutSlots: ReadonlyMap<string, readonly string[]>,
): string {
  if (layoutRoutes.length === 0) return "    [route: string]: never;\n";

  return layoutRoutes
    .map((route) => {
      const slots = layoutSlots.get(route) ?? [];
      return `    ${quote(route)}: ${routeUnion(slots)};`;
    })
    .join("\n");
}

function paramsForPatternParts(patternParts: readonly string[]): ParamShape {
  const params: ParamShape = new Map();
  for (const part of patternParts) {
    if (!part.startsWith(":")) continue;

    if (part.endsWith("+")) {
      params.set(part.slice(1, -1), "string[]");
    } else if (part.endsWith("*")) {
      params.set(part.slice(1, -1), "string[]?");
    } else {
      params.set(part.slice(1), "string");
    }
  }
  return params;
}

function createLayoutRouteKeyMap(layouts: Iterable<{ treePath: string }>): Map<string, string> {
  const treePathsByRoute = new Map<string, string[]>();
  for (const { treePath } of layouts) {
    const route = treePathToRouteLiteral(treePath);
    const treePaths = treePathsByRoute.get(route) ?? [];
    treePaths.push(treePath);
    treePathsByRoute.set(route, treePaths);
  }

  const keys = new Map<string, string>();
  for (const [route, treePaths] of treePathsByRoute) {
    for (const treePath of treePaths) {
      keys.set(
        treePath,
        treePaths.length === 1 ? route : treePathToScopedLayoutRouteLiteral(treePath),
      );
    }
  }
  return keys;
}

function layoutRouteKeyForSlot(
  slot: { id: string; ownerLayoutId: string | null },
  layouts: ReadonlyMap<string, { treePath: string }>,
  layoutRouteKeys: ReadonlyMap<string, string>,
): string | null {
  if (!slot.ownerLayoutId) return null;

  const layout = layouts.get(slot.ownerLayoutId);
  if (!layout) {
    throw new Error(
      `[vinext] App route graph invariant violated: slot ${slot.id} references missing owner layout ${slot.ownerLayoutId}`,
    );
  }

  return layoutRouteKeys.get(layout.treePath) ?? treePathToRouteLiteral(layout.treePath);
}

/** Convert a layout tree path to its URL route literal, stripping invisible segments. */
function treePathToRouteLiteral(treePath: string): string {
  if (treePath === "/") return "/";

  const segments = treePath
    .split("/")
    .filter(Boolean)
    .filter((segment) => !isInvisibleSegment(segment))
    .map((segment) => decodeRouteSegment(segment));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * Convert a layout tree path to a scoped route literal that preserves
 * route-group and `@slot` segments. Used only as a fallback key when multiple
 * layouts collapse to the same URL route literal, so consumers can keep their
 * slot/params typings distinct.
 */
function treePathToScopedLayoutRouteLiteral(treePath: string): string {
  if (treePath === "/") return "/";

  const segments = treePath
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== ".")
    .map((segment) => decodeRouteSegment(segment));
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function addRoute(
  routes: string[],
  seen: Set<string>,
  params: Map<string, ParamShape>,
  route: string,
  paramShape: ParamShape,
): void {
  if (!seen.has(route)) {
    seen.add(route);
    routes.push(route);
  }
  const existingParamShape = params.get(route);
  if (existingParamShape) {
    if (!paramShapesEqual(existingParamShape, paramShape)) {
      throw new Error(`[vinext] Conflicting route param shapes generated for ${route}`);
    }
    return;
  }
  params.set(route, paramShape);
}

function paramShapesEqual(left: ParamShape, right: ParamShape): boolean {
  if (left.size !== right.size) return false;
  for (const [name, kind] of left) {
    if (right.get(name) !== kind) return false;
  }
  return true;
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort(compareStrings);
}

function routeUnion(routes: readonly string[]): string {
  if (routes.length === 0) return "never";
  return routes.map(quote).join(" | ");
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
