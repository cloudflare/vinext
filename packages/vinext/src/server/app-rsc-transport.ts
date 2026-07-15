import { decodeBase64Url, encodeBase64Url } from "../utils/base64url.js";
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

export function isCloudflareRscTransportEnabled(): boolean {
  return process.env.__VINEXT_CLOUDFLARE_RSC_TRANSPORT === "true";
}

/**
 * Transport asset names encode the full visible pathname as one opaque
 * base64url token. Structured filenames (`/about.rsc` plus `__root.rsc` /
 * `__index.rsc` sentinels) are not injective: legal routes like `/__root` or
 * `/docs/__index` alias the sentinels for `/` and `/docs/`. The token keeps
 * the route-to-asset mapping bijective for every legal pathname.
 */
const textEncoder = new TextEncoder();

// Transport route pathnames come from `url.pathname` and go back into
// `mappedUrl.pathname`, so they must already be in URL-serialized form:
// parsing the value as a path and reading the pathname back must be the
// identity. This rejects everything the URL implementation would rewrite on
// pathname assignment — `?`/`#` (truncated), `\` (normalized to `/`),
// tab/newline (stripped), other control chars, spaces, and raw non-ASCII
// (percent-encoded), plus `.`/`..` segments (resolved) — keeping decoded
// route tokens bijective with the request pathname they map to. This is
// deliberately stricter than `isInterceptionMatchedUrlPath`, which accepts
// decoded pathnames like `/café`.
function isUrlSerializedPathname(value: string): boolean {
  // `//` parses as a protocol-relative authority, never as a pathname.
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  try {
    return new URL(value, "http://n").pathname === value;
  } catch {
    return false;
  }
}
// fatal: invalid UTF-8 must reject the token, not collapse different byte
// sequences into the same replacement-character route.
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function encodeRouteToken(routePathname: string): string {
  return encodeBase64Url(textEncoder.encode(routePathname));
}

function decodeRouteToken(token: string): string | null {
  const bytes = decodeBase64Url(token);
  // Accept only the canonical spelling: forgiving base64 tolerates nonzero
  // padding bits, `=` padding, and the `+`/`/` alphabet, which would give one
  // route many accepted transport URLs (e.g. Lx/Ly/Lz all decode like Lw).
  if (bytes === null || encodeBase64Url(bytes) !== token) return null;
  try {
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
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
  if (!isUrlSerializedPathname(routePathname)) {
    throw new Error(`Invalid RSC transport route pathname: ${routePathname}`);
  }
  return `/${encodeRouteToken(routePathname)}.rsc`;
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
  if (!assetPathname.startsWith("/") || !assetPathname.endsWith(".rsc")) return null;
  const token = assetPathname.slice(1, -4);
  if (token.length === 0 || token.includes("/")) return null;
  const routePathname = decodeRouteToken(token);
  return routePathname !== null && isUrlSerializedPathname(routePathname) ? routePathname : null;
}

export function resolveRscTransportRequest(
  request: Request,
  url = new URL(request.url),
  routePathname = resolveRscTransportRoutePathname(url.pathname),
): Request {
  if (routePathname === null) return request;

  const mappedUrl = new URL(url);
  mappedUrl.pathname = routePathname;
  return new Request(mappedUrl, request);
}
