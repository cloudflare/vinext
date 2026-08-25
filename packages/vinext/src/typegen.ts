import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "pathslash";
import { isInvisibleSegment } from "./routing/app-route-graph.js";
import { appRouteGraph } from "./routing/app-router.js";
import { apiRouter, pagesRouter } from "./routing/pages-router.js";
import { patternToNextFormat } from "./routing/route-validation.js";
import { decodeRouteSegment } from "./routing/utils.js";
import { compareStrings } from "./utils/compare.js";
import { findDir } from "./utils/project.js";

type GenerateRouteTypesOptions = {
  root: string;
  appDir?: string | null;
  pagesDir?: string | null;
  pageExtensions?: readonly string[];
  typedRoutes?: boolean;
};

export type GenerateRouteTypesResult = {
  routeTypesPath: string;
  linkTypesPath: string | null;
  nextEnvPath: string;
  nextEnvStatus: "created" | "updated" | "unchanged";
};

type ParamShape = Map<string, "string" | "string[]" | "string[]?">;

function nextEnvFileContent(
  hasNext: boolean,
  hasAppDir: boolean,
  typedRoutes: boolean,
  eol = "\n",
): string {
  const typeReference = hasNext
    ? `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "vinext/types/augmentations";
`
    : `import "vinext/types";
`;
  const routeTypeImports = typedRoutes
    ? `import "./.next/types/routes.d.ts";
import "./.next/types/link.d.ts";`
    : `import "./.next/types/routes.d.ts";`;

  return `${typeReference}${routeTypeImports}

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
  const linkPath = path.join(root, ".next", "types", "link.d.ts");
  const pagesDir =
    options.pagesDir === null
      ? null
      : options.pagesDir
        ? path.resolve(options.pagesDir)
        : findDir(root, "pages", "src/pages");
  const model = appDir
    ? await collectRouteTypeModel(root, appDir, options.pageExtensions)
    : emptyRouteTypeModel();
  if (options.typedRoutes === true && pagesDir) {
    await collectPagesRouterLinkRoutes(root, pagesDir, options.pageExtensions, model);
  }

  const content = renderRouteTypes(model, appDir !== null && pagesDir !== null);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, content, "utf-8");
  if (options.typedRoutes === true) {
    await fs.writeFile(linkPath, generateLinkTypesFile(model), "utf-8");
  } else {
    // Next.js wipes .next on build, but vinext regenerates in place. Remove a
    // stale declaration so a migrated tsconfig with
    // include: [".next/types/**/*.ts"] cannot keep applying it.
    await fs.rm(linkPath, { force: true });
  }
  const nextEnv = await ensureNextEnvFile(root, appDir !== null, options.typedRoutes === true);
  return {
    routeTypesPath: outPath,
    linkTypesPath: options.typedRoutes === true ? linkPath : null,
    nextEnvPath: nextEnv.path,
    nextEnvStatus: nextEnv.status,
  };
}

async function ensureNextEnvFile(
  root: string,
  hasAppDir: boolean,
  typedRoutes: boolean,
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
  const content = nextEnvFileContent(hasNext, hasAppDir, typedRoutes, eol);
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
  appPageLinkRoutes: LinkRouteEntry[];
  pagesRouterLinkRoutes: LinkRouteEntry[];
  appRouteHandlerLinkRoutes: LinkRouteEntry[];
  params: Map<string, ParamShape>;
  layoutSlots: Map<string, string[]>;
};

type RouteTypeInfo = { isDynamic: boolean; routeType: string };
type LinkRouteEntry = RouteTypeInfo & { cause: string };

function emptyRouteTypeModel(): RouteTypeModel {
  return {
    pageRoutes: [],
    layoutRoutes: [],
    routeHandlerRoutes: [],
    appPageLinkRoutes: [],
    pagesRouterLinkRoutes: [],
    appRouteHandlerLinkRoutes: [],
    params: new Map(),
    layoutSlots: new Map(),
  };
}

async function collectRouteTypeModel(
  root: string,
  appDir: string,
  pageExtensions?: readonly string[],
): Promise<RouteTypeModel> {
  const graph = await appRouteGraph(appDir, pageExtensions);
  const model = emptyRouteTypeModel();
  const segmentGraph = graph.routeManifest.segmentGraph;
  const graphRoutesById = new Map<string, (typeof graph.routes)[number]>();
  for (const route of graph.routes) {
    if (!graphRoutesById.has(route.ids.route)) graphRoutesById.set(route.ids.route, route);
  }
  const layoutRouteKeys = createLayoutRouteKeyMap(segmentGraph.layouts.values());
  const pageRouteSet = new Set<string>();
  const layoutRouteSet = new Set<string>();
  const routeHandlerRouteSet = new Set<string>();

  for (const route of segmentGraph.pages.values()) {
    const routeEntry = segmentGraph.routes.get(route.routeId);
    const routeLiteral = patternToNextFormat(route.pattern);
    addRoute(
      model.pageRoutes,
      pageRouteSet,
      model.params,
      routeLiteral,
      paramsForPatternParts(routeEntry?.patternParts ?? []),
    );
    const pagePath = graphRoutesById.get(route.routeId)?.pagePath;
    model.appPageLinkRoutes.push(
      createLinkRouteEntry(
        routeLiteral,
        routeEntry?.patternParts,
        pagePath ? path.relative(root, pagePath) : routeLiteral,
      ),
    );
  }

  for (const route of segmentGraph.routeHandlers.values()) {
    const routeEntry = segmentGraph.routes.get(route.routeId);
    const routeLiteral = patternToNextFormat(route.pattern);
    addRoute(
      model.routeHandlerRoutes,
      routeHandlerRouteSet,
      model.params,
      routeLiteral,
      paramsForPatternParts(routeEntry?.patternParts ?? []),
    );
    const routePath = graphRoutesById.get(route.routeId)?.routePath;
    model.appRouteHandlerLinkRoutes.push(
      createLinkRouteEntry(
        routeLiteral,
        routeEntry?.patternParts,
        routePath ? path.relative(root, routePath) : routeLiteral,
      ),
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
  model.appPageLinkRoutes.sort(compareLinkRouteEntries);
  model.appRouteHandlerLinkRoutes.sort(compareLinkRouteEntries);
  for (const slotNames of model.layoutSlots.values()) slotNames.sort(compareStrings);

  return model;
}

/**
 * Collect Pages Router page and API routes for the typed-link unions. Next.js
 * folds these into `StaticRoutes`/`DynamicRoutes` alongside App Router routes.
 * They deliberately stay out of `routes.d.ts`, which models the app dir only.
 */
async function collectPagesRouterLinkRoutes(
  root: string,
  pagesDir: string,
  pageExtensions: readonly string[] | undefined,
  model: RouteTypeModel,
): Promise<void> {
  // Next.js emits raw `pages/api/*` file paths into the unions (its manifest
  // stores page API routes as file paths); vinext emits their URL routes
  // instead, matching how App Router route handlers are treated.
  for (const route of [
    ...(await pagesRouter(pagesDir, pageExtensions)),
    ...(await apiRouter(pagesDir, pageExtensions)),
  ]) {
    const routeLiteral = patternToNextFormat(route.pattern);
    model.pagesRouterLinkRoutes.push(
      createLinkRouteEntry(routeLiteral, route.patternParts, path.relative(root, route.filePath)),
    );
  }
  model.pagesRouterLinkRoutes.sort(compareLinkRouteEntries);
}

/**
 * Derive a route's typed-link template from the scanners' pattern parts
 * (`:param` markers with pre-decoded static segments) instead of re-parsing
 * the decoded route string. Percent-encoded literal bracket segments (e.g.
 * `%5Bslug%5D`) decode to `[slug]`, which string-based classification would
 * misread as a dynamic parameter.
 */
function patternPartsToRouteTypeInfo(patternParts: readonly string[]): RouteTypeInfo {
  let isDynamic = false;
  const segments = patternParts.map((part) => {
    if (part.startsWith(":")) {
      isDynamic = true;
      if (part.endsWith("+")) return "${CatchAllSlug<T>}";
      if (part.endsWith("*")) return "${OptionalCatchAllSlug<T>}";
      return "${SafeSlug<T>}";
    }
    return part;
  });
  return { isDynamic, routeType: segments.length === 0 ? "/" : `/${segments.join("/")}` };
}

// Ported from Next.js: packages/next/src/server/lib/router-utils/typegen.ts (generateLinkTypesFile)
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/typegen.ts
const DYNAMIC_ROUTE = /\/\[[^/]+?\](?=\/|$)/;

function isDynamicRoute(route: string): boolean {
  return DYNAMIC_ROUTE.test(route);
}

// Helper function to format routes to route types (matches the plugin logic exactly)
function formatRouteToRouteType(route: string) {
  const isDynamic = isDynamicRoute(route);
  if (isDynamic) {
    route = route
      .split("/")
      .map((part) => {
        if (part.startsWith("[") && part.endsWith("]")) {
          if (part.startsWith("[...")) {
            // /[...slug]
            return `\${CatchAllSlug<T>}`;
          } else if (part.startsWith("[[...") && part.endsWith("]]")) {
            // /[[...slug]]
            return `\${OptionalCatchAllSlug<T>}`;
          }
          // /[slug]
          return `\${SafeSlug<T>}`;
        }
        return part;
      })
      .join("/");
  }

  return {
    isDynamic,
    routeType: route,
  };
}

function createLinkRouteEntry(
  route: string,
  patternParts: readonly string[] | undefined,
  cause: string,
): LinkRouteEntry {
  return {
    ...(patternParts ? patternPartsToRouteTypeInfo(patternParts) : formatRouteToRouteType(route)),
    cause,
  };
}

function compareLinkRouteEntries(left: LinkRouteEntry, right: LinkRouteEntry): number {
  return compareStrings(left.routeType, right.routeType) || compareStrings(left.cause, right.cause);
}

// Helper function to serialize route types (matches the plugin logic exactly)
// Each entry is a [routeType, source] tuple.
function serializeRouteTypes(routeTypes: [routeType: string, cause: string][]) {
  // Route collection is not deterministic. Use the repo comparator instead
  // of localeCompare so output stays stable across host locales.
  routeTypes.sort(([a], [b]) => compareStrings(a, b));
  let union = "";
  for (let i = 0; i < routeTypes.length; i++) {
    const [route, cause] = routeTypes[i];
    union += `\n    | \`${route}\` // ${cause}`;
  }
  return union;
}

function generateLinkTypesFile(model: RouteTypeModel): string {
  const visited = new Set<string>();
  const staticRouteTypes: [routeType: string, cause: string][] = [];
  const dynamicRouteTypes: [routeType: string, cause: string][] = [];

  // Matches Next.js's manifest iteration order: app routes, then Pages Router
  // routes, then app route handlers — first visit wins on duplicate route
  // templates. Use the scanner-derived template rather than the decoded route
  // literal as the identity so `[id]` and the literal `%5Bid%5D` can coexist.
  for (const routes of [
    model.appPageLinkRoutes,
    model.pagesRouterLinkRoutes,
    model.appRouteHandlerLinkRoutes,
  ]) {
    for (const route of routes) {
      if (visited.has(route.routeType)) {
        continue;
      }
      visited.add(route.routeType);

      if (route.isDynamic) {
        dynamicRouteTypes.push([route.routeType, route.cause]);
      } else {
        staticRouteTypes.push([route.routeType, route.cause]);
      }
    }
  }

  const serializedStaticRouteTypes = serializeRouteTypes(staticRouteTypes);
  const serializedDynamicRouteTypes = serializeRouteTypes(dynamicRouteTypes);

  // If both StaticRoutes and DynamicRoutes are empty, fallback to type 'string & {}'.
  const routeTypesFallback =
    !serializedStaticRouteTypes && !serializedDynamicRouteTypes ? "string & {}" : "";

  return `// This file is generated automatically by Next.js
// Do not edit this file manually

// Type definitions for Next.js routes

/**
 * Internal types used by the Next.js router and Link component.
 * These types are not meant to be used directly.
 * @internal
 */
declare namespace __next_route_internal_types__ {
  type SearchOrHash = \`?\${string}\` | \`#\${string}\`
  type WithProtocol = \`\${string}:\${string}\`

  type Suffix = '' | SearchOrHash

  type SafeSlug<S extends string> = S extends \`\${string}/\${string}\`
    ? never
    : S extends \`\${string}\${SearchOrHash}\`
    ? never
    : S extends ''
    ? never
    : S

  type CatchAllSlug<S extends string> = S extends \`\${string}\${SearchOrHash}\`
    ? never
    : S extends ''
    ? never
    : S

  type OptionalCatchAllSlug<S extends string> =
    S extends \`\${string}\${SearchOrHash}\` ? never : S

  type StaticRoutes = ${serializedStaticRouteTypes || "never"}
  type DynamicRoutes<T extends string = string> = ${serializedDynamicRouteTypes || "never"}

  type RouteImpl<T> = ${
    routeTypesFallback ||
    `
    ${
      // This keeps autocompletion working for static routes.
      "| StaticRoutes"
    }
    | SearchOrHash
    | WithProtocol
    | \`\${StaticRoutes}\${SearchOrHash}\`
    | (T extends \`\${DynamicRoutes<infer _>}\${Suffix}\` ? T : never)
    `
  }
}

declare module 'next' {
  export { default } from 'next/types.js'
  export * from 'next/types.js'

  export type Route<T extends string = string> =
    __next_route_internal_types__.RouteImpl<T>
}

declare module 'next/link' {
  export { useLinkStatus } from 'next/dist/client/link.js'

  import type { LinkProps as OriginalLinkProps } from 'next/dist/client/link.js'
  import type { AnchorHTMLAttributes, DetailedHTMLProps } from 'react'
  import type { UrlObject } from 'url'

  type LinkRestProps = Omit<
    Omit<
      DetailedHTMLProps<
        AnchorHTMLAttributes<HTMLAnchorElement>,
        HTMLAnchorElement
      >,
      keyof OriginalLinkProps
    > &
      OriginalLinkProps,
    'href'
  >

  export type LinkProps<RouteInferType> = LinkRestProps & {
    /**
     * The path or URL to navigate to. This is the only required prop. It can also be an object.
     * @see https://nextjs.org/docs/api-reference/next/link
     */
    href: __next_route_internal_types__.RouteImpl<RouteInferType> | UrlObject
  }

  export default function Link<RouteType>(props: LinkProps<RouteType>): JSX.Element
}

declare module 'next/navigation' {
  export * from 'next/dist/client/components/navigation.js'

  import type { NavigateOptions, AppRouterInstance as OriginalAppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
  import type { RedirectType } from 'next/dist/client/components/redirect-error.js'
${"  "}
  interface AppRouterInstance extends OriginalAppRouterInstance {
    /**
     * Navigate to the provided href.
     * Pushes a new history entry.
     */
    push<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: NavigateOptions): void
    /**
     * Navigate to the provided href.
     * Replaces the current history entry.
     */
    replace<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>, options?: NavigateOptions): void
    /**
     * Prefetch the provided href.
     */
    prefetch<RouteType>(href: __next_route_internal_types__.RouteImpl<RouteType>): void
  }

  export function useRouter(): AppRouterInstance;
${"  "}
  /**
   * This function allows you to redirect the user to another URL. It can be used in
   * [Server Components](https://nextjs.org/docs/app/building-your-application/rendering/server-components),
   * [Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers), and
   * [Server Actions](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations).
   *
   * - In a Server Component, this will insert a meta tag to redirect the user to the target page.
   * - In a Route Handler, it will serve a 307 to the caller.
   * - In a Server Action, it will perform a client-side navigation when JavaScript is available or serve a 303 for a progressive enhancement form submission.
   * - In a Server Action, type defaults to 'push' and 'replace' elsewhere.
   *
   * Read more: [Next.js Docs: redirect](https://nextjs.org/docs/app/api-reference/functions/redirect)
   */
  export function redirect<RouteType>(
    /** The URL to redirect to */
    url: __next_route_internal_types__.RouteImpl<RouteType>,
    type?: RedirectType
  ): never;
${"  "}
  /**
   * This function allows you to redirect the user to another URL. It can be used in
   * [Server Components](https://nextjs.org/docs/app/building-your-application/rendering/server-components),
   * [Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers), and
   * [Server Actions](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations).
   *
   * - In a Server Component, this will insert a meta tag to redirect the user to the target page.
   * - In a Route Handler, it will serve a 308 to the caller.
   * - In a Server Action, it will perform a client-side navigation when JavaScript is available or serve a 303 for a progressive enhancement form submission.
   *
   * Read more: [Next.js Docs: redirect](https://nextjs.org/docs/app/api-reference/functions/redirect)
   */
  export function permanentRedirect<RouteType>(
    /** The URL to redirect to */
    url: __next_route_internal_types__.RouteImpl<RouteType>,
    type?: RedirectType
  ): never;
}

declare module 'next/form' {
  import type { FormProps as OriginalFormProps } from 'next/dist/client/form.js'

  type FormRestProps = Omit<OriginalFormProps, 'action'>

  export type FormProps<RouteInferType> = {
    /**
     * \`action\` can be either a \`string\` or a function.
     * - If \`action\` is a string, it will be interpreted as a path or URL to navigate to when the form is submitted.
     *   The path will be prefetched when the form becomes visible.
     * - If \`action\` is a function, it will be called when the form is submitted. See the [React docs](https://react.dev/reference/react-dom/components/form#props) for more.
     */
    action: __next_route_internal_types__.RouteImpl<RouteInferType> | ((formData: FormData) => void)
  } & FormRestProps

  export default function Form<RouteType>(props: FormProps<RouteType>): JSX.Element
}
`;
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
