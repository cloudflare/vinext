import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";

declare global {
  var __VINEXT_PREGENERATED_CONCRETE_PATHS: unknown;
}

export function normalizePregeneratedPathname(pathname: string): string {
  return normalizePath(normalizePathnameForRouteMatch(pathname));
}

/**
 * Stores concrete URL paths pre-rendered at build time per route pattern.
 * Used by the PPR fallback-shell guard to avoid serving fallback shells for
 * known routes whose exact cache entry is temporarily absent.
 *
 * Populated by `seed-cache.ts` (Node) or from `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS`
 * injected by `deploy.ts` after prerender (Workers).
 */
const concreteUrlPathsByRoute = new Map<string, Set<string>>();

export function clearPregeneratedConcretePaths(): void {
  concreteUrlPathsByRoute.clear();
}

export function addPregeneratedConcretePath(routePattern: string, pathname: string): void {
  let paths = concreteUrlPathsByRoute.get(routePattern);
  if (!paths) {
    paths = new Set();
    concreteUrlPathsByRoute.set(routePattern, paths);
  }
  paths.add(pathname);
}

export function getRenderedConcreteUrlPathsForRoute(
  routePattern: string,
): ReadonlySet<string> | undefined {
  return concreteUrlPathsByRoute.get(routePattern);
}

/**
 * Populate the registry from `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS`.
 * No-op when the global is not set (Node path — seed-cache handles it later).
 * Pathnames are normalised so they match the runtime `cleanPathname`.
 */
export function initPregeneratedPathsFromGlobals(): void {
  const raw = globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
  const data = parsePregeneratedConcretePaths(raw);
  if (!data) return;
  clearPregeneratedConcretePaths();
  for (const [routePattern, pathnames] of data) {
    for (const pathname of pathnames) {
      addPregeneratedConcretePath(routePattern, normalizePregeneratedPathname(pathname));
    }
  }
}

function parsePregeneratedConcretePaths(value: unknown): Array<[string, string[]]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Array<[string, string[]]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) return undefined;
    if (entry.length !== 2) return undefined;
    const [pattern, paths] = entry;
    if (typeof pattern !== "string") return undefined;
    if (!Array.isArray(paths)) return undefined;
    const strings: string[] = [];
    for (const p of paths) {
      if (typeof p !== "string") return undefined;
      strings.push(p);
    }
    result.push([pattern, strings]);
  }
  return result;
}
