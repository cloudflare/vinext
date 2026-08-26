export const CACHEABILITY_MANIFEST_PLACEHOLDER =
  "__VINEXT_CACHEABILITY_MANIFEST_7A4D2D86_5848_4C3D_A2D5_52B32F178CF9__";

/** Reserved attached module populated by two-stage Cloudflare deploys. */
export const CACHEABILITY_MANIFEST_MODULE_FILE =
  "__vinext_cacheability_manifest.vinext-cacheability";

export type CacheabilityRouteKind = "app-page" | "app-route" | "pages-page";

export type CacheabilityRouteState =
  | "static-candidate"
  | "dynamic"
  | "runtime-check"
  | "probe-failed";

export type CacheabilityManifestRoute = {
  /** The probe observed dynamic usage that an explicit cache policy deliberately authorized. */
  explicitPolicyDynamicOverride?: boolean;
  /** The pathname came from generateStaticParams/getStaticPaths discovery. */
  generatedPath?: boolean;
  /** Compact pattern-level membership for generated paths not fully probed. */
  generatedPaths?: CacheabilityGeneratedPaths;
  kind: CacheabilityRouteKind;
  /** Concrete public pathname classified by this entry. Omitted for the pattern fallback. */
  path?: string;
  pattern: string;
  state: CacheabilityRouteState;
};

export type CacheabilityGeneratedPathBlocks = {
  /** Exact, sorted path membership encoded in independently searchable blocks. */
  blocks: string[];
  encoding: "front-coded-v1";
};

/** Arrays are accepted for compatibility with early probe artifacts and tests. */
export type CacheabilityGeneratedPaths = string[] | CacheabilityGeneratedPathBlocks;

export type CacheabilityManifest = {
  buildId?: string;
  routes: Record<string, CacheabilityManifestRoute>;
  version: 1;
};

declare const __VINEXT_CACHEABILITY_MANIFEST__: string | undefined;

let parsedManifest: CacheabilityManifest | null | undefined;
let parsedBindingManifest: CacheabilityManifest | null | undefined;
let parsedBindingManifestRaw: string | undefined;

export function cacheabilityRouteKey(
  kind: CacheabilityRouteKind,
  pattern: string,
  path?: string,
): string {
  // Retain the original readable key for pattern fallbacks. Exact-path keys use
  // a JSON tuple so arbitrary dynamic-pattern/path characters cannot collide.
  if (path !== undefined) return JSON.stringify([kind, pattern, path]);
  return `${kind}:${pattern}`;
}

const GENERATED_PATH_BLOCK_SIZE = 64;

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function appendFrontCodedPath(encoded: string, previous: string, pathname: string): string {
  const prefixLength = commonPrefixLength(previous, pathname);
  const suffix = pathname.slice(prefixLength);
  return `${encoded}${prefixLength.toString(36)}:${suffix.length.toString(36)}:${suffix}`;
}

function readFrontCodedPath(
  block: string,
  offset: number,
  previous: string,
): { nextOffset: number; pathname: string } | null {
  const prefixEnd = block.indexOf(":", offset);
  if (prefixEnd < 0) return null;
  const suffixLengthEnd = block.indexOf(":", prefixEnd + 1);
  if (suffixLengthEnd < 0) return null;
  const prefixLength = Number.parseInt(block.slice(offset, prefixEnd), 36);
  const suffixLength = Number.parseInt(block.slice(prefixEnd + 1, suffixLengthEnd), 36);
  const suffixStart = suffixLengthEnd + 1;
  const nextOffset = suffixStart + suffixLength;
  if (
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > previous.length ||
    !Number.isSafeInteger(suffixLength) ||
    suffixLength < 0 ||
    nextOffset > block.length
  ) {
    return null;
  }
  return {
    nextOffset,
    pathname: previous.slice(0, prefixLength) + block.slice(suffixStart, nextOffset),
  };
}

function firstFrontCodedPath(block: string): string | null {
  return readFrontCodedPath(block, 0, "")?.pathname ?? null;
}

/**
 * Front coding preserves exact membership (there are no hash false positives)
 * while avoiding one repeated route prefix and one JS object per generated
 * pathname. Blocks keep lookup bounded instead of decoding the full set on
 * every request.
 */
export function encodeCacheabilityGeneratedPaths(
  paths: readonly string[],
): CacheabilityGeneratedPathBlocks {
  const sorted = Array.from(new Set(paths)).sort();
  const blocks: string[] = [];
  for (let start = 0; start < sorted.length; start += GENERATED_PATH_BLOCK_SIZE) {
    let previous = "";
    let block = "";
    for (const pathname of sorted.slice(start, start + GENERATED_PATH_BLOCK_SIZE)) {
      block = appendFrontCodedPath(block, previous, pathname);
      previous = pathname;
    }
    blocks.push(block);
  }
  return { blocks, encoding: "front-coded-v1" };
}

function validateGeneratedPathBlocks(value: unknown): value is CacheabilityGeneratedPathBlocks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.encoding !== "front-coded-v1" ||
    !Array.isArray(record.blocks) ||
    !record.blocks.every((block) => typeof block === "string")
  ) {
    return false;
  }
  let priorBlockLast = "";
  for (const block of record.blocks) {
    let offset = 0;
    let previous = "";
    let entries = 0;
    while (offset < block.length) {
      const decoded = readFrontCodedPath(block, offset, previous);
      if (
        !decoded ||
        !decoded.pathname.startsWith("/") ||
        (previous !== "" && decoded.pathname <= previous) ||
        (previous === "" && priorBlockLast !== "" && decoded.pathname <= priorBlockLast)
      ) {
        return false;
      }
      previous = decoded.pathname;
      offset = decoded.nextOffset;
      entries += 1;
      if (entries > GENERATED_PATH_BLOCK_SIZE) return false;
    }
    if (entries === 0) return false;
    priorBlockLast = previous;
  }
  return true;
}

export function cacheabilityManifestHasGeneratedPath(
  generatedPaths: CacheabilityGeneratedPaths | undefined,
  pathname: string,
): boolean {
  if (!generatedPaths) return false;
  if (!Array.isArray(generatedPaths)) {
    let low = 0;
    let high = generatedPaths.blocks.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const first = firstFrontCodedPath(generatedPaths.blocks[middle]);
      if (first === null) return false;
      if (first <= pathname) low = middle + 1;
      else high = middle - 1;
    }
    if (high < 0) return false;
    const block = generatedPaths.blocks[high];
    let offset = 0;
    let previous = "";
    while (offset < block.length) {
      const decoded = readFrontCodedPath(block, offset, previous);
      if (!decoded) return false;
      if (decoded.pathname === pathname) return true;
      if (decoded.pathname > pathname) return false;
      previous = decoded.pathname;
      offset = decoded.nextOffset;
    }
    return false;
  }
  let low = 0;
  let high = generatedPaths.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = generatedPaths[middle];
    if (candidate === pathname) return true;
    if (candidate < pathname) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function isCacheabilityRouteKind(value: unknown): value is CacheabilityRouteKind {
  return value === "app-page" || value === "app-route" || value === "pages-page";
}

function isCacheabilityRouteState(value: unknown): value is CacheabilityRouteState {
  return (
    value === "static-candidate" ||
    value === "dynamic" ||
    value === "runtime-check" ||
    value === "probe-failed"
  );
}

export function parseCacheabilityManifest(
  value: string | null | undefined,
): CacheabilityManifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.routes || typeof record.routes !== "object") return null;

    const routes: Record<string, CacheabilityManifestRoute> = {};
    for (const [key, entry] of Object.entries(record.routes as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const route = entry as Record<string, unknown>;
      let generatedPaths: CacheabilityGeneratedPaths | undefined;
      if (route.generatedPaths !== undefined) {
        if (
          Array.isArray(route.generatedPaths) &&
          route.generatedPaths.every(
            (pathname) => typeof pathname === "string" && pathname.startsWith("/"),
          )
        ) {
          generatedPaths = Array.from(new Set<string>(route.generatedPaths)).sort();
        } else if (validateGeneratedPathBlocks(route.generatedPaths)) {
          generatedPaths = {
            blocks: [...route.generatedPaths.blocks],
            encoding: "front-coded-v1",
          };
        } else {
          return null;
        }
      }
      if (
        !isCacheabilityRouteKind(route.kind) ||
        typeof route.pattern !== "string" ||
        !route.pattern.startsWith("/") ||
        (route.path !== undefined &&
          (typeof route.path !== "string" || !route.path.startsWith("/"))) ||
        (route.generatedPath !== undefined && typeof route.generatedPath !== "boolean") ||
        (route.explicitPolicyDynamicOverride !== undefined &&
          typeof route.explicitPolicyDynamicOverride !== "boolean") ||
        !isCacheabilityRouteState(route.state) ||
        key !==
          cacheabilityRouteKey(
            route.kind,
            route.pattern,
            typeof route.path === "string" ? route.path : undefined,
          )
      ) {
        return null;
      }
      routes[key] = {
        ...(route.explicitPolicyDynamicOverride === true
          ? { explicitPolicyDynamicOverride: true }
          : {}),
        ...(route.generatedPath === true ? { generatedPath: true } : {}),
        ...(generatedPaths ? { generatedPaths } : {}),
        kind: route.kind,
        ...(typeof route.path === "string" ? { path: route.path } : {}),
        pattern: route.pattern,
        state: route.state,
      };
    }

    return {
      ...(typeof record.buildId === "string" ? { buildId: record.buildId } : {}),
      routes,
      version: 1,
    };
  } catch {
    return null;
  }
}

export function cacheabilityRouteAllowsPath(
  _route: CacheabilityManifestRoute,
  _pathname: string,
): boolean {
  return true;
}

export function getEmbeddedCacheabilityManifest(): CacheabilityManifest | null {
  if (parsedManifest !== undefined) return parsedManifest;
  const raw =
    typeof __VINEXT_CACHEABILITY_MANIFEST__ === "string"
      ? __VINEXT_CACHEABILITY_MANIFEST__
      : CACHEABILITY_MANIFEST_PLACEHOLDER;
  parsedManifest = parseCacheabilityManifest(raw);
  return parsedManifest;
}

/** Parse the immutable attached Worker module at most once per isolate/version. */
export function getBoundCacheabilityManifest(raw: string): CacheabilityManifest | null {
  if (parsedBindingManifestRaw === raw && parsedBindingManifest !== undefined) {
    return parsedBindingManifest;
  }
  parsedBindingManifestRaw = raw;
  parsedBindingManifest = parseCacheabilityManifest(raw);
  return parsedBindingManifest;
}

/** Test-only reset for modules whose compile-time define is stubbed between cases. */
export function resetEmbeddedCacheabilityManifestForTests(): void {
  parsedManifest = undefined;
  parsedBindingManifest = undefined;
  parsedBindingManifestRaw = undefined;
}
