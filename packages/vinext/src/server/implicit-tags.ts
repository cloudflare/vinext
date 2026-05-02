const NEXT_CACHE_IMPLICIT_TAG_ID = "_N_T_";

type AppCacheLeafKind = "page" | "route";

function appendUnique(tags: string[], tag: string): void {
  if (!tags.includes(tag)) tags.push(tag);
}

// App route segments come from raw filesystem directories, so dynamic
// segments are already in bracket notation such as [slug] or [...all].
function normalizeRouteSegment(segment: string): string | null {
  if (!segment || segment === "." || segment.startsWith("@")) return null;
  return segment;
}

function buildRouteCachePath(routeSegments: string[], leafKind: AppCacheLeafKind): string {
  const parts: string[] = [];
  for (const segment of routeSegments) {
    const normalized = normalizeRouteSegment(segment);
    if (normalized) parts.push(normalized);
  }
  parts.push(leafKind);
  return `/${parts.join("/")}`;
}

function appendDerivedTags(tags: string[], routePath: string): void {
  appendUnique(tags, `${NEXT_CACHE_IMPLICIT_TAG_ID}/layout`);

  if (!routePath.startsWith("/")) return;

  const routeParts = routePath.split("/");
  const leafIndex = routeParts.length - 1;
  for (let i = 1; i <= routeParts.length; i++) {
    let currentPathname = routeParts.slice(0, i).join("/");
    if (!currentPathname) continue;

    const isLeaf = i - 1 === leafIndex;
    if (!isLeaf) {
      currentPathname = `${currentPathname}/layout`;
    }

    appendUnique(tags, `${NEXT_CACHE_IMPLICIT_TAG_ID}${currentPathname}`);
  }
}

export function buildPageCacheTags(
  pathname: string,
  extraTags: string[],
  routeSegments: string[],
  leafKind: AppCacheLeafKind,
): string[] {
  const tags = [pathname, `${NEXT_CACHE_IMPLICIT_TAG_ID}${pathname}`];
  if (pathname === "/") appendUnique(tags, `${NEXT_CACHE_IMPLICIT_TAG_ID}/index`);
  if (pathname === "/index") appendUnique(tags, `${NEXT_CACHE_IMPLICIT_TAG_ID}/`);
  appendDerivedTags(tags, buildRouteCachePath(routeSegments, leafKind));

  for (const tag of extraTags) {
    appendUnique(tags, tag);
  }

  return tags;
}
