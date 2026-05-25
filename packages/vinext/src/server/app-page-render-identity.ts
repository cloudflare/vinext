import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { AppElementsWire, type AppElementsInterception } from "./app-elements.js";
import { isInterceptionMatchedUrlPath, normalizePath } from "./normalize-path.js";

type AppPageRenderIdentityInput = {
  displayPathname: string;
  interceptionContext?: string | null;
  interceptSourceMatchedUrl?: string | null;
  interceptSlotId?: string | null;
};

export type AppPageRenderIdentity = {
  displayPathname: string;
  interception: AppElementsInterception | null;
  interceptionContext: string | null;
  matchedRoutePathname: string;
  pageId: string;
  routeId: string;
  targetMatchedPathname: string;
};

function normalizeAppPageRenderMatchedPathname(pathname: string): string {
  if (!pathname.startsWith("/")) {
    throw new Error(`[vinext] App Router render pathname must be absolute: ${pathname}`);
  }
  return normalizePath(normalizePathnameForRouteMatch(pathname));
}

export function normalizeAppPageInterceptionProofPathname(pathname: string | null): string | null {
  if (pathname === null || !isInterceptionMatchedUrlPath(pathname)) return null;
  return normalizeAppPageRenderMatchedPathname(pathname);
}

export function createAppPageRenderIdentity(
  input: AppPageRenderIdentityInput,
): AppPageRenderIdentity {
  const interceptionContext = input.interceptionContext ?? null;
  const targetMatchedPathname = normalizeAppPageRenderMatchedPathname(input.displayPathname);
  const sourceMatchedPathname = normalizeAppPageInterceptionProofPathname(
    input.interceptSourceMatchedUrl ?? null,
  );
  const slotId = input.interceptSlotId ?? null;
  const matchedRoutePathname = sourceMatchedPathname ?? targetMatchedPathname;
  const routeId = AppElementsWire.encodeRouteId(matchedRoutePathname, null);
  const pageId = AppElementsWire.encodePageId(matchedRoutePathname, null);
  const interception =
    sourceMatchedPathname === null || slotId === null
      ? null
      : {
          sourceMatchedUrl: sourceMatchedPathname,
          sourceRouteId: AppElementsWire.encodeRouteId(sourceMatchedPathname, null),
          slotId,
          targetMatchedUrl: targetMatchedPathname,
          targetRouteId: AppElementsWire.encodeRouteId(targetMatchedPathname, null),
        };

  return {
    displayPathname: input.displayPathname,
    interception,
    interceptionContext,
    matchedRoutePathname,
    pageId,
    routeId,
    targetMatchedPathname,
  };
}
