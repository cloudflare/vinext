import { hasBasePath, stripBasePath, removeTrailingSlash } from "../utils/base-path.js";
import {
  INTERNAL_HEADERS,
  MIDDLEWARE_HEADER_PREFIX,
  VINEXT_INTERNAL_HEADERS,
  VINEXT_STATIC_FILE_HEADER,
} from "./headers.js";
import { MIDDLEWARE_CACHE_HEADER } from "../utils/protocol-headers.js";
import { forbiddenResponse, notFoundResponse } from "./http-error-responses.js";
import { isOpenRedirectShaped } from "./open-redirect.js";

export { isOpenRedirectShaped } from "./open-redirect.js";

const PATHNAME_CANONICALIZATION_BASE = new URL("http://vinext.invalid/");

/**
 * Apply the URL Standard's pathname canonicalization without decoding and
 * re-encoding ordinary percent escapes.
 *
 * In particular, WHATWG URLs remove literal and percent-encoded dot segments
 * (`/%2e/about` becomes `/about`) while preserving unrelated spellings such
 * as `/%61bout`, `%2F`, `%5C`, and `%252F` byte-for-byte. Node request adapters
 * must do this before comparing raw route/config/basePath identity so those
 * comparisons agree with the `Request` that userland eventually receives.
 */
export function canonicalizeRequestPathname(pathname: string): string {
  const url = new URL(PATHNAME_CANONICALIZATION_BASE);
  url.pathname = pathname;
  return url.pathname;
}

/** Canonicalize only the pathname portion while preserving the raw query. */
export function canonicalizeRequestUrlPathname(url: string): string {
  const queryIndex = url.indexOf("?");
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : url.slice(queryIndex);
  return canonicalizeRequestPathname(pathname) + search;
}

/**
 * Shared request pipeline utilities.
 *
 * Extracted from generated entries and server hot paths to keep codegen focused
 * on app shape while normal modules own request behavior. Some dev-server and
 * worker-template setup code still has inline normalization that should be
 * migrated in follow-up work.
 *
 * These utilities handle the common request lifecycle steps: protocol-
 * relative URL guards, basePath stripping, trailing slash normalization,
 * and CSRF origin validation.
 *
 * Plain-text error response builders (forbidden / not-found / etc.) live in
 * `./http-error-responses.ts`.
 */

/**
 * Guard against protocol-relative URL open redirects.
 *
 * Paths like `//example.com/` would be redirected to `//example.com` by the
 * trailing-slash normalizer, which browsers interpret as `http://example.com`.
 * Backslashes are equivalent to forward slashes in the URL spec
 * (e.g. `/\evil.com` is treated as `//evil.com` by browsers).
 *
 * Next.js returns 404 for these paths. We check the RAW pathname before
 * normalization so the guard fires before normalizePath collapses `//`.
 *
 * Percent-encoded variants are also blocked because:
 *   - `%5C` decodes to `\` (browsers treat `/\evil.com` as `//evil.com`).
 *   - `%2F` decodes to `/` (so `/%2F/evil.com` effectively becomes `//evil.com`).
 * These forms survive segment-wise decoding that re-encodes path delimiters
 * (e.g. `normalizePathnameForRouteMatchStrict`), so a later trailing-slash
 * redirect would still echo the encoded form in its `Location` header. See
 * `isOpenRedirectShaped` for the full list of rejected leading-segment forms.
 *
 * @param rawPathname - The raw pathname from the URL, before any normalization
 * @returns A 404 Response if the path is protocol-relative, or null to continue
 */
export function guardProtocolRelativeUrl(rawPathname: string): Response | null {
  if (isOpenRedirectShaped(rawPathname)) {
    return notFoundResponse();
  }
  return null;
}

/**
 * Strip the basePath prefix from a pathname.
 *
 * All internal routing uses basePath-free paths. If the pathname starts
 * with the configured basePath, it is removed. Returns the stripped
 * pathname, or the original pathname if basePath is empty or doesn't match.
 *
 * @param pathname - The pathname to strip
 * @param basePath - The basePath from next.config.js (empty string if not set)
 * @returns The pathname with basePath removed
 */
export { hasBasePath, stripBasePath };

export type HeaderRecord = Record<string, string | string[]>;

type StaticFileSignalContext = {
  headers: Headers | null;
  status: number | null;
};

type ResolvePublicFileRouteOptions = {
  cleanPathname: string;
  middlewareContext: StaticFileSignalContext;
  pathname: string;
  publicFiles: ReadonlySet<string>;
  request: Request;
};

const FILE_LIKE_PATHNAME_RE = /\.[^/]+\/?$/;

function isWellKnownPathname(pathname: string): boolean {
  return pathname === "/.well-known" || pathname.startsWith("/.well-known/");
}

export function createStaticFileSignal(
  pathname: string,
  context: StaticFileSignalContext,
): Response {
  const headers = new Headers({
    [VINEXT_STATIC_FILE_HEADER]: encodeURIComponent(pathname),
  });
  if (context.headers) {
    for (const [key, value] of context.headers) {
      headers.append(key, value);
    }
  }
  return new Response(null, {
    status: context.status ?? 200,
    headers,
  });
}

/**
 * Resolve the public/ filesystem-route slot in the Next.js routing order.
 *
 * Public files are checked after middleware and before afterFiles/fallback
 * rewrites. The generated App Router entry provides the public-file set; this
 * helper owns the request-method and RSC exclusions plus static-file signaling.
 */
export function resolvePublicFileRoute(options: ResolvePublicFileRouteOptions): Response | null {
  if (options.request.method !== "GET" && options.request.method !== "HEAD") return null;
  if (options.pathname.endsWith(".rsc")) return null;
  if (!options.publicFiles.has(options.cleanPathname)) return null;
  return createStaticFileSignal(options.cleanPathname, options.middlewareContext);
}

export function normalizeTrailingSlashPathname(
  pathname: string,
  trailingSlash: boolean,
): string | null {
  if (pathname === "/" || pathname === "/api" || pathname.startsWith("/api/")) {
    return null;
  }

  const hasTrailing = pathname.endsWith("/");

  if (trailingSlash) {
    // Next.js emits two internal redirect rules for trailingSlash:true:
    // file-looking paths lose a trailing slash, non-file paths gain one, and
    // /.well-known stays untouched for RFC-defined discovery URLs.
    if (isWellKnownPathname(pathname)) return null;
    if (FILE_LIKE_PATHNAME_RE.test(pathname)) {
      const normalized = removeTrailingSlash(pathname);
      return normalized === pathname ? null : normalized;
    }
    if (!hasTrailing && !pathname.endsWith(".rsc")) return `${pathname}/`;
    return null;
  }

  if (hasTrailing) return removeTrailingSlash(pathname);
  return null;
}

/**
 * Check if the pathname needs a trailing slash redirect, and return the
 * redirect Response if so.
 *
 * Follows Next.js behavior:
 * - `/api` routes are never redirected
 * - The root path `/` is never redirected
 * - If `trailingSlash` is true, redirect `/about` → `/about/`
 * - If `trailingSlash` is true, redirect file-looking `/file.ext/` → `/file.ext`
 * - If `trailingSlash` is true, do not redirect `/.well-known/*`
 * - If `trailingSlash` is false (default), redirect `/about/` → `/about`
 *
 * @param pathname - The basePath-stripped pathname
 * @param basePath - The basePath to prepend to the redirect Location
 * @param trailingSlash - Whether trailing slashes should be enforced
 * @param search - The query string (including `?`) to preserve in the redirect
 * @returns A 308 redirect Response, or null if no redirect is needed
 */
export function normalizeTrailingSlash(
  pathname: string,
  basePath: string,
  trailingSlash: boolean,
  search: string,
): Response | null {
  if (pathname === "/" || pathname === "/api" || pathname.startsWith("/api/")) {
    return null;
  }
  // Defense-in-depth: `guardProtocolRelativeUrl` runs earlier and should
  // have rejected these shapes. Refuse to emit a Location header that the
  // browser would resolve as protocol-relative, even if a caller somehow
  // bypassed the upstream guard.
  if (isOpenRedirectShaped(pathname)) {
    return notFoundResponse();
  }
  const normalizedPathname = normalizeTrailingSlashPathname(pathname, trailingSlash);
  if (normalizedPathname === null) return null;
  // `pathname` arrives segment-wise percent-decoded with path delimiters
  // already re-encoded (see app-rsc-request-normalization → encodePathDelimiters,
  // which leaves `%23 %3F %2F %5C` in place). It can still carry raw spaces or
  // characters above U+00FF (e.g. CJK slugs, emoji). Those must be encoded
  // before building the Location: an un-encoded space is a malformed redirect
  // target, and a non-Latin-1 character makes the Headers constructor throw
  // 'Cannot convert argument to a ByteString' (→ 500 instead of 308).
  // Percent-encode every character that is not a valid RFC 3986 path character,
  // i.e. everything outside `pchar`/`/`. We deliberately keep `%` in the safe
  // set so existing `%xx` escapes are preserved rather than double-encoded
  // (`encodeURI` would wrongly turn `%23` into `%2523`). Sub-delimiters
  // (`!$&'()*+,;=`) and `:@` are valid `pchar` and are left raw, matching
  // Next.js — `+` in particular only carries space semantics in the query
  // string, which we leave untouched. The `u` flag makes the regex match
  // astral code points whole, so emoji surrogate pairs aren't split. The query
  // string comes verbatim from the request URL and is already encoded, so it
  // must not be re-encoded here. Refs cloudflare/vinext#1979
  const encodedPathname = normalizedPathname.replace(
    /[^A-Za-z0-9\-._~!$&'()*+,;=:@/%]/gu,
    encodeURIComponent,
  );
  return new Response(null, {
    status: 308,
    headers: { Location: basePath + encodedPathname + search },
  });
}

/**
 * Validate CSRF origin for server action requests.
 *
 * Matches Next.js behavior: compares the Origin header against the Host
 * header. If they don't match, the request is rejected with 403 unless
 * the origin is in the allowedOrigins list.
 *
 * @param request - The incoming Request
 * @param allowedOrigins - Origins from experimental.serverActions.allowedOrigins
 * @returns A 403 Response if origin validation fails, or null to continue
 */
export function validateCsrfOrigin(
  request: Request,
  allowedOrigins: string[] = [],
): Response | null {
  const originHeader = request.headers.get("origin");
  // If there's no Origin header, allow the request — same-origin requests
  // from non-fetch navigations (e.g. SSR) may lack an Origin header.
  // The x-rsc-action custom header already provides protection against simple
  // form-based CSRF since custom headers can't be set by cross-origin forms.
  if (!originHeader) return null;

  // Origin "null" is sent by browsers in opaque/privacy-sensitive contexts
  // (sandboxed iframes, data: URLs, etc.). Treat it as an explicit cross-origin
  // value — only allow it if "null" is explicitly listed in allowedOrigins.
  // This prevents CSRF via sandboxed contexts (CVE: GHSA-mq59-m269-xvcx).
  if (originHeader === "null") {
    if (allowedOrigins.includes("null")) return null;
    console.warn(
      `[vinext] CSRF origin "null" blocked for server action. To allow requests from sandboxed contexts, add "null" to experimental.serverActions.allowedOrigins.`,
    );
    return forbiddenResponse();
  }

  let originHost: string;
  try {
    originHost = new URL(originHeader).host.toLowerCase();
  } catch {
    return forbiddenResponse();
  }

  // Only use the Host header for origin comparison — never trust
  // X-Forwarded-Host here, since it can be freely set by the client
  // and would allow the check to be bypassed if it matched a spoofed
  // Origin. The prod server's resolveHost() handles trusted proxy
  // scenarios separately. If Host is missing, fall back to request.url
  // so handcrafted requests don't fail open.
  const hostHeader =
    (request.headers.get("host") || "").split(",")[0].trim().toLowerCase() ||
    new URL(request.url).host.toLowerCase();

  // Same origin — allow
  if (originHost === hostHeader) return null;

  // Check allowedOrigins from next.config.js
  if (allowedOrigins.length > 0 && isOriginAllowed(originHost, allowedOrigins)) return null;

  console.warn(
    `[vinext] CSRF origin mismatch: origin "${originHost}" does not match host "${hostHeader}". Blocking server action request.`,
  );
  return forbiddenResponse();
}

/**
 * Reject malformed Flight container reference graphs in server action payloads.
 *
 * `@vitejs/plugin-rsc` vendors its own React Flight decoder. Malicious action
 * payloads can abuse container references (`$Q`, `$W`, `$i`) to trigger very
 * expensive deserialization before the action is even looked up.
 *
 * Legitimate React-encoded container payloads use separate numeric backing
 * fields (e.g. field `1` plus root field `0` containing `"$Q1"`). We reject
 * numeric backing-field graphs that contain missing backing fields or cycles.
 * Regular user form fields are ignored entirely.
 */
export async function validateServerActionPayload(
  body: string | FormData,
): Promise<Response | null> {
  const maxNumericFields = 4096;
  const maxContainerReferences = 16384;
  const maxContainerDepth = 1024;
  const containerRefRe = /"\$([QWi])([0-9a-f]+)(?=[:"])/gi;
  const fieldRefs = new Map<string, Set<string>>();
  let referenceCount = 0;

  const invalidPayloadResponse = (): Response =>
    new Response("Invalid server action payload", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });

  const collectRefs = (fieldKey: string, text: string): boolean => {
    if (fieldRefs.has(fieldKey)) return true;
    if (fieldRefs.size >= maxNumericFields) return false;

    const refs = new Set<string>();
    let match: RegExpExecArray | null;
    containerRefRe.lastIndex = 0;
    while ((match = containerRefRe.exec(text)) !== null) {
      const previousSize = refs.size;
      refs.add(String(Number.parseInt(match[2], 16)));
      if (refs.size !== previousSize && ++referenceCount > maxContainerReferences) return false;
    }
    fieldRefs.set(fieldKey, refs);
    return true;
  };

  if (typeof body === "string") {
    if (!collectRefs("0", body)) return invalidPayloadResponse();
  } else {
    for (const [key, value] of body.entries()) {
      if (!/^\d+$/.test(key)) continue;
      if (typeof value === "string") {
        if (!collectRefs(key, value)) return invalidPayloadResponse();
        continue;
      }
      if (typeof value?.text === "function") {
        if (!collectRefs(key, await value.text())) return invalidPayloadResponse();
      }
    }
  }

  if (fieldRefs.size === 0) return null;

  const knownFields = new Set(fieldRefs.keys());
  for (const refs of fieldRefs.values()) {
    for (const ref of refs) {
      if (!knownFields.has(ref)) {
        return invalidPayloadResponse();
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();

  for (const root of fieldRefs.keys()) {
    if (state.has(root)) continue;

    const stack = [{ node: root, refs: [...(fieldRefs.get(root) ?? [])], nextRef: 0 }];
    state.set(root, "visiting");

    while (stack.length > 0) {
      if (stack.length > maxContainerDepth) return invalidPayloadResponse();

      const frame = stack[stack.length - 1];
      const ref = frame.refs[frame.nextRef++];
      if (ref === undefined) {
        state.set(frame.node, "visited");
        stack.pop();
        continue;
      }

      const refState = state.get(ref);
      if (refState === "visiting") return invalidPayloadResponse();
      if (refState === "visited") continue;

      state.set(ref, "visiting");
      stack.push({ node: ref, refs: [...(fieldRefs.get(ref) ?? [])], nextRef: 0 });
    }
  }

  return null;
}

/**
 * Check if an origin matches any pattern in the allowed origins list.
 * Supports wildcard subdomains (e.g. `*.example.com`).
 */
/**
 * Segment-by-segment domain matching for wildcard origin patterns.
 * `*` matches exactly one DNS label; `**` matches one or more labels.
 *
 * Ported from Next.js: packages/next/src/server/app-render/csrf-protection.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/csrf-protection.ts
 */
function matchWildcardDomain(domain: string, pattern: string): boolean {
  const normalizedDomain = domain.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const normalizedPattern = pattern.replace(/[A-Z]/g, (c) => c.toLowerCase());

  const domainParts = normalizedDomain.split(".");
  const patternParts = normalizedPattern.split(".");

  if (patternParts.length < 1) return false;
  if (domainParts.length < patternParts.length) return false;

  // Prevent wildcards from matching entire domains (e.g. '**' or '*.com')
  if (patternParts.length === 1 && (patternParts[0] === "*" || patternParts[0] === "**")) {
    return false;
  }

  while (patternParts.length) {
    const patternPart = patternParts.pop();
    const domainPart = domainParts.pop();
    if (patternPart === undefined) return false;

    switch (patternPart) {
      case "":
        return false;
      case "*":
        if (domainPart) continue;
        else return false;
      case "**":
        if (patternParts.length > 0) return false;
        return domainPart !== undefined;
      default:
        if (patternPart !== domainPart) return false;
    }
  }

  return domainParts.length === 0;
}

export function isOriginAllowed(origin: string, allowed: string[]): boolean {
  for (const pattern of allowed) {
    if (pattern.includes("*")) {
      if (matchWildcardDomain(origin, pattern)) return true;
    } else if (origin.toLowerCase() === pattern.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * Strip internal `x-middleware-*` headers from a Headers object.
 *
 * Middleware uses `x-middleware-*` headers as internal signals (e.g.
 * `x-middleware-next`, `x-middleware-rewrite`, `x-middleware-request-*`).
 * These must be removed before sending the response to the client.
 *
 * @param headers - The Headers object to modify in place
 */
export function processMiddlewareHeaders(headers: Headers): void {
  const keysToDelete: string[] = [];

  for (const key of headers.keys()) {
    if (key.startsWith(MIDDLEWARE_HEADER_PREFIX) && key !== MIDDLEWARE_CACHE_HEADER) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    headers.delete(key);
  }
}

/**
 * Headers that are only used internally by Next.js and must not be honored
 * from external requests. An attacker could forge these to influence routing
 * or impersonate internal data fetches.
 *
 * @see `./headers.ts` for the canonical definition.
 */
export { INTERNAL_HEADERS, VINEXT_INTERNAL_HEADERS } from "./headers.js";

const STRIPPED_INTERNAL_HEADERS = new Set([...INTERNAL_HEADERS, ...VINEXT_INTERNAL_HEADERS]);

type RequestInitWithCf = RequestInit & { cf?: unknown };

/**
 * Strip internal headers from an inbound request so they cannot be forged by
 * an external attacker to influence routing or impersonate internal state.
 *
 * Must be called at every request entry point BEFORE middleware, routing,
 * or any handler logic accesses the request headers.
 *
 * Returns a new Headers object with internal headers removed. The input
 * is never mutated — Request.headers is immutable in Workers/miniflare
 * environments (see applyMiddlewareRequestHeaders in config-matchers.ts
 * for the same cloning pattern).
 *
 * @param headers - The source Headers (never modified)
 * @returns A new Headers with internal framework headers removed
 */
export function filterInternalHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  for (const [key, value] of headers) {
    if (!STRIPPED_INTERNAL_HEADERS.has(key.toLowerCase())) {
      filtered.append(key, value);
    }
  }
  return filtered;
}

function getRequestCf(request: Request): unknown {
  const cf = Reflect.get(request, "cf");
  return cf === undefined ? undefined : cf;
}

/**
 * Clone a Request while overriding headers, preserving metadata when possible.
 *
 * Some runtimes (Workers) allow `new Request(request, { headers })` which
 * retains redirect/signal/cf data. Others (Node/undici across realms) can throw
 * when cloning a foreign Request instance. In that case, fall back to building
 * a RequestInit with best-effort metadata.
 */
export function cloneRequestWithHeaders(request: Request, headers: Headers): Request {
  let cloned: Request;
  try {
    cloned = new Request(request, { headers });
  } catch {
    const init: RequestInitWithCf = {
      method: request.method,
      headers,
      body: request.body ?? undefined,
      redirect: request.redirect,
      signal: request.signal,
      integrity: request.integrity,
      cache: request.cache,
      mode: request.mode,
      credentials: request.credentials,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    };
    if (request.body) {
      // @ts-expect-error — duplex needed for streaming request bodies
      init.duplex = "half";
    }
    cloned = new Request(request.url, init);
  }
  const cf = getRequestCf(request);
  if (cf !== undefined) {
    // new Request() does not copy Workers-specific cf, so re-attach it.
    Object.defineProperty(cloned, "cf", {
      value: cf,
      enumerable: true,
      configurable: true,
    });
  }
  return cloned;
}

/**
 * Clone a Request while overriding the URL, preserving headers and metadata
 * when possible.
 *
 * Mirrors `cloneRequestWithHeaders`, but rewrites the URL instead of the
 * headers. Workers support `new Request(url, request)` to copy method/headers/
 * body onto a new URL; Node/undici can throw on a foreign Request instance, so
 * we fall back to a manual RequestInit. `new Request()` does not copy the
 * Workers-specific `cf` property and omits `duplex` for streaming bodies, so
 * both are handled explicitly — the same reasons `cloneRequestWithHeaders`
 * exists.
 */
export function cloneRequestWithUrl(request: Request, url: string): Request {
  let cloned: Request;
  try {
    cloned = new Request(url, request);
  } catch {
    const init: RequestInitWithCf = {
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
      redirect: request.redirect,
      signal: request.signal,
      integrity: request.integrity,
      cache: request.cache,
      mode: request.mode,
      credentials: request.credentials,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    };
    if (request.body) {
      // @ts-expect-error — duplex needed for streaming request bodies
      init.duplex = "half";
    }
    cloned = new Request(url, init);
  }
  const cf = getRequestCf(request);
  if (cf !== undefined) {
    // new Request() does not copy Workers-specific cf, so re-attach it.
    Object.defineProperty(cloned, "cf", {
      value: cf,
      enumerable: true,
      configurable: true,
    });
  }
  return cloned;
}
