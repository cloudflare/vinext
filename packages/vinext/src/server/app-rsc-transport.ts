import { APP_RSC_RENDER_MODE_NAVIGATION } from "./app-rsc-render-mode.js";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
} from "./headers.js";

export const VINEXT_STATIC_RSC_TRANSPORT_PREFIX = "/_next/static/__vinext/prerendered-rsc";
export const VINEXT_WORKER_RSC_TRANSPORT_PREFIX = "/__vinext/rsc";

const ROOT_RSC_TRANSPORT_FILE = "__root.rsc";
const TRAILING_SLASH_RSC_TRANSPORT_FILE = "__index.rsc";

export function isCloudflareRscTransportEnabled(): boolean {
  return process.env.__VINEXT_CLOUDFLARE_RSC_TRANSPORT === "true";
}

function isStaticRscTransportEligible(headers: Headers): boolean {
  const renderMode = headers.get(VINEXT_RSC_RENDER_MODE_HEADER);
  return (
    !headers.has(NEXT_ROUTER_PREFETCH_HEADER) &&
    !headers.has(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER) &&
    !headers.has(NEXT_ROUTER_STATE_TREE_HEADER) &&
    !headers.has(NEXT_URL_HEADER) &&
    !headers.has(VINEXT_CLIENT_REUSE_MANIFEST_HEADER) &&
    !headers.has(VINEXT_INTERCEPTION_CONTEXT_HEADER) &&
    !headers.has(VINEXT_MOUNTED_SLOTS_HEADER) &&
    (renderMode === null || renderMode === APP_RSC_RENDER_MODE_NAVIGATION)
  );
}

export function createRscTransportAssetPathname(routePathname: string): string {
  if (routePathname === "/") return `/${ROOT_RSC_TRANSPORT_FILE}`;
  if (!routePathname.startsWith("/")) {
    throw new Error(`Invalid RSC transport route pathname: ${routePathname}`);
  }
  if (routePathname.endsWith("/")) {
    return `${routePathname}${TRAILING_SLASH_RSC_TRANSPORT_FILE}`;
  }
  return `${routePathname}.rsc`;
}

export function createRscTransportRequestPathname(routePathname: string, headers: Headers): string {
  const prefix = isStaticRscTransportEligible(headers)
    ? VINEXT_STATIC_RSC_TRANSPORT_PREFIX
    : VINEXT_WORKER_RSC_TRANSPORT_PREFIX;
  return `${prefix}${createRscTransportAssetPathname(routePathname)}`;
}

function stripTransportPrefix(pathname: string, prefix: string): string | null {
  if (pathname === prefix) return "";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
}

export function resolveRscTransportRoutePathname(pathname: string): string | null {
  const assetPathname =
    stripTransportPrefix(pathname, VINEXT_STATIC_RSC_TRANSPORT_PREFIX) ??
    stripTransportPrefix(pathname, VINEXT_WORKER_RSC_TRANSPORT_PREFIX);
  if (assetPathname === null) return null;
  if (assetPathname === `/${ROOT_RSC_TRANSPORT_FILE}`) return "/";
  if (assetPathname.endsWith(`/${TRAILING_SLASH_RSC_TRANSPORT_FILE}`)) {
    return assetPathname.slice(0, -TRAILING_SLASH_RSC_TRANSPORT_FILE.length);
  }
  if (!assetPathname.endsWith(".rsc")) return null;
  const routePathname = assetPathname.slice(0, -4);
  return routePathname.startsWith("/") && routePathname.length > 1 ? routePathname : null;
}

export function resolveRscTransportRequest(request: Request, url = new URL(request.url)): Request {
  const routePathname = resolveRscTransportRoutePathname(url.pathname);
  if (routePathname === null) return request;

  const mappedUrl = `${url.protocol}//${url.host}${routePathname}${url.search}`;
  return new Request(mappedUrl, request);
}
