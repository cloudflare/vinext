import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { normalizePath } from "./normalize-path.js";

declare global {
  var __VINEXT_PREGENERATED_CONCRETE_PATHS: unknown;
}

// Uses the non-strict `normalizePathnameForRouteMatch` on purpose, rather than
// the strict variant the live request pipeline uses to compute `cleanPathname`
// (see `app-rsc-request-normalization.ts`). Registry seeding runs over
// build-time data and must not throw, whereas the strict variant rejects
// malformed percent-encoding so the runtime can return a 400. The two only
// diverge on malformed encoding (e.g. `%GG`), which the runtime rejects before
// any lookup happens, so valid pathnames normalize identically and lookups
// still match. Do not "fix" this to the strict variant — it would reintroduce a
// build-time throw on malformed seed data.
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

/**
 * Records a concrete URL path for a route pattern. The pathname is normalized
 * here so this is the single source of truth: every caller — the Worker global
 * table and the Node `seed-cache.ts` path — stores the canonical form that
 * matches the runtime `cleanPathname` lookup without having to pre-normalize.
 */
export function addPregeneratedConcretePath(routePattern: string, pathname: string): void {
  const normalized = normalizePregeneratedPathname(pathname);
  let paths = concreteUrlPathsByRoute.get(routePattern);
  if (!paths) {
    paths = new Set();
    concreteUrlPathsByRoute.set(routePattern, paths);
  }
  paths.add(normalized);
}

/**
 * Returns the live backing `Set` for a route pattern (not a copy) to keep
 * lookups allocation-free on the serving hot path. The `ReadonlySet` type
 * forbids mutation at compile time. Callers must treat the result as
 * point-in-time and must NOT retain it across a re-seed: each
 * `initPregeneratedPathsFromGlobals` call runs `clearPregeneratedConcretePaths`,
 * which empties the map, leaving any previously-returned reference stale. Read
 * it, use it, drop it — never cache the reference.
 */
export function getRenderedConcreteUrlPathsForRoute(
  routePattern: string,
): ReadonlySet<string> | undefined {
  return concreteUrlPathsByRoute.get(routePattern);
}

/**
 * Populate the registry from `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS`.
 * No-op when the global is not set (Node path — seed-cache handles it later).
 * `addPregeneratedConcretePath` normalizes each pathname so it matches the
 * runtime `cleanPathname`.
 */
export function initPregeneratedPathsFromGlobals(): void {
  const raw = globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
  const data = parsePregeneratedConcretePaths(raw);
  if (!data) return;
  clearPregeneratedConcretePaths();
  for (const [routePattern, pathnames] of data) {
    for (const pathname of pathnames) {
      addPregeneratedConcretePath(routePattern, pathname);
    }
  }
}

// Validates the global table shape strictly: a single malformed entry rejects
// the whole payload. Repeated `routePattern` entries are NOT deduped here by
// design — if `deploy.ts` ever emits the same pattern twice, the paths merge
// additively into one `Set` via `addPregeneratedConcretePath`, which dedups by
// value, so the merged result is identical to a single combined entry. No
// one-entry-per-pattern invariant is enforced because none is needed.
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
