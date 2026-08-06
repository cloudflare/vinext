import type { NextI18nConfig } from "../config/next-config.js";
import {
  NextRequest,
  RequestCookies,
  sealRequestCookies,
  sealRequestHeaders,
  type NextURL,
} from "vinext/shims/server";
import { buildRequestHeadersFromMiddlewareResponse } from "../utils/middleware-request-headers.js";
import { addBasePathToPathname } from "../utils/base-path.js";

const ROUTE_HANDLER_HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
] as const;

export type RouteHandlerHttpMethod = (typeof ROUTE_HANDLER_HTTP_METHODS)[number];

export type RouteHandlerModule = Partial<Record<RouteHandlerHttpMethod | "default", unknown>>;

/**
 * Checks whether a string is a recognized HTTP method for App Router route
 * handlers. Invalid methods must be rejected with 400 before any auto-OPTIONS
 * or 405 logic runs.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/http.ts
 */
export function isValidHTTPMethod(maybeMethod: string): maybeMethod is RouteHandlerHttpMethod {
  return (ROUTE_HANDLER_HTTP_METHODS as readonly string[]).includes(maybeMethod);
}

export function collectRouteHandlerMethods(handler: RouteHandlerModule): RouteHandlerHttpMethod[] {
  const methods = ROUTE_HANDLER_HTTP_METHODS.filter(
    (method) => typeof handler[method] === "function",
  );

  if (methods.includes("GET") && !methods.includes("HEAD")) {
    methods.push("HEAD");
  }

  return methods;
}

export function buildRouteHandlerAllowHeader(exportedMethods: readonly string[]): string {
  const allow = new Set(exportedMethods);
  allow.add("OPTIONS");
  return Array.from(allow).sort().join(", ");
}

const _KNOWN_DYNAMIC_APP_ROUTE_HANDLERS_KEY = Symbol.for(
  "vinext.appRouteHandlerRuntime.knownDynamicHandlers",
);
const _g = globalThis as unknown as Record<PropertyKey, unknown>;

// NOTE: This set starts empty on cold start. The first request may serve a
// stale ISR cache entry before the handler runs and signals dynamic usage.
// Next.js avoids this by determining dynamism statically at build time; vinext
// learns it at runtime and remembers the result for the process lifetime.
const knownDynamicAppRouteHandlers = (_g[_KNOWN_DYNAMIC_APP_ROUTE_HANDLERS_KEY] ??=
  new Set<string>()) as Set<string>;

export function isKnownDynamicAppRoute(pattern: string): boolean {
  return knownDynamicAppRouteHandlers.has(pattern);
}

export function markKnownDynamicAppRoute(pattern: string): void {
  knownDynamicAppRouteHandlers.add(pattern);
}

type RequestDynamicAccess =
  | "request.headers"
  | "request.cookies"
  | "request.ip"
  | "request.geo"
  | "request.url"
  | "request.body"
  | "request.blob"
  | "request.json"
  | "request.text"
  | "request.arrayBuffer"
  | "request.formData";

type NextUrlDynamicAccess =
  | "nextUrl.search"
  | "nextUrl.searchParams"
  | "nextUrl.url"
  | "nextUrl.href"
  | "nextUrl.toJSON"
  | "nextUrl.toString"
  | "nextUrl.origin";

type AppRouteDynamicRequestAccess = RequestDynamicAccess | NextUrlDynamicAccess;
type AppRouteRequestMode = "auto" | "force-static" | "error";

type TrackedAppRouteRequestOptions = {
  basePath?: string;
  i18n?: NextI18nConfig | null;
  trailingSlash?: boolean;
  middlewareHeaders?: Headers | null;
  onDynamicAccess?: (access: AppRouteDynamicRequestAccess) => void;
  requestMode?: AppRouteRequestMode;
  staticGenerationErrorMessage?: (expression?: string) => string;
};

type TrackedAppRouteRequest = {
  request: NextRequest;
  didAccessDynamicRequest(): boolean;
};

function bindMethodIfNeeded<T>(value: T, target: object): T {
  return typeof value === "function" ? (value.bind(target) as T) : value;
}

// Request properties whose access must be reported as dynamic in "auto" mode.
// Kept in sync with RequestDynamicAccess so `request.${prop}` types correctly.
const AUTO_TRACKED_REQUEST_PROPS = [
  "headers",
  "cookies",
  "ip",
  "geo",
  "url",
  "body",
  "blob",
  "json",
  "text",
  "arrayBuffer",
  "formData",
] as const;

/**
 * Walks the prototype chain (own properties first) to find a property's
 * original descriptor before it is shadowed by an own tracking accessor, so the
 * tracking getter can still read through to the real NextRequest/Request value.
 */
function resolveInheritedDescriptor(
  target: object,
  prop: PropertyKey,
): PropertyDescriptor | undefined {
  let current: object | null = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, prop);
    if (descriptor) {
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function buildNextConfig(options: TrackedAppRouteRequestOptions): {
  basePath?: string;
  i18n?: NextI18nConfig;
  trailingSlash?: boolean;
} | null {
  if (!options.basePath && !options.i18n && !options.trailingSlash) {
    return null;
  }

  return {
    basePath: options.basePath,
    i18n: options.i18n ?? undefined,
    trailingSlash: options.trailingSlash,
  };
}

function rebuildRequestWithHeaders(input: Request, headers: Headers): Request {
  const method = input.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    cache: input.cache,
    credentials: input.credentials,
    integrity: input.integrity,
    keepalive: input.keepalive,
    mode: input.mode,
    redirect: input.redirect,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    signal: input.signal,
  };

  if (hasBody && input.body) {
    init.body = input.body;
    init.duplex = "half";
  }

  return new Request(input.url, init);
}

function cleanStaticUrl(url: string): string {
  const cleanUrl = new URL(url);
  cleanUrl.protocol = "http:";
  cleanUrl.host = "localhost:3000";
  cleanUrl.username = "";
  cleanUrl.password = "";
  cleanUrl.search = "";
  cleanUrl.hash = "";
  return cleanUrl.href;
}

function readEmptyBodyAsArrayBuffer(): Promise<ArrayBuffer> {
  return new Response(null).arrayBuffer();
}

function readEmptyBodyAsBlob(): Promise<Blob> {
  return new Response(null).blob();
}

// Empty JSON/form-data parses reject naturally; that keeps force-static body
// stubs aligned with a bodyless request instead of inventing synthetic data.
function readEmptyBodyAsFormData(): Promise<FormData> {
  return new Response(null).formData();
}

function readEmptyBodyAsJson(): Promise<unknown> {
  return new Response(null).json();
}

function readEmptyBodyAsText(): Promise<string> {
  return new Response(null).text();
}

export function createTrackedAppRouteRequest(
  request: Request,
  options: TrackedAppRouteRequestOptions = {},
): TrackedAppRouteRequest {
  let didAccessDynamicRequest = false;
  const requestMode = options.requestMode ?? "auto";
  const nextConfig = buildNextConfig(options);

  const markDynamicAccess = (access: AppRouteDynamicRequestAccess): void => {
    didAccessDynamicRequest = true;
    options.onDynamicAccess?.(access);
  };

  // Mirror the dynamic request reads that Next.js tracks inside
  // packages/next/src/server/route-modules/app-route/module.ts
  // via proxyNextRequest(), but keep the logic in a normal typed module.
  const wrapNextUrl = (nextUrl: NextURL): NextURL => {
    const nextUrlHandler: ProxyHandler<NextURL> = {
      get(target, prop): unknown {
        switch (prop) {
          case "search":
          case "searchParams":
          case "url":
          case "href":
          case "toJSON":
          case "toString":
          case "origin":
            markDynamicAccess(`nextUrl.${String(prop)}` as NextUrlDynamicAccess);
            return bindMethodIfNeeded(Reflect.get(target, prop, target), target);
          case "clone":
            return () => wrapNextUrl(target.clone());
          default:
            return bindMethodIfNeeded(Reflect.get(target, prop, target), target);
        }
      },
    };

    return new Proxy(nextUrl, nextUrlHandler);
  };

  const wrapForceStaticNextUrl = (nextUrl: NextURL): NextURL => {
    const emptySearchParams = new URLSearchParams();
    const staticHref = cleanStaticUrl(nextUrl.href);
    const nextUrlHandler: ProxyHandler<NextURL> = {
      get(target, prop): unknown {
        switch (prop) {
          case "search":
            return "";
          case "searchParams":
            return emptySearchParams;
          case "href":
            return staticHref;
          case "url":
            return undefined;
          case "toJSON":
          case "toString":
            return () => staticHref;
          case "clone":
            return () => wrapForceStaticNextUrl(target.clone());
          default:
            return bindMethodIfNeeded(Reflect.get(target, prop, target), target);
        }
      },
    };

    return new Proxy(nextUrl, nextUrlHandler);
  };

  const throwStaticGenerationError = (expression: string): never => {
    throw new Error(
      options.staticGenerationErrorMessage?.(expression) ??
        `Route handler with \`dynamic = "error"\` used ${expression}.`,
    );
  };

  const wrapRequireStaticNextUrl = (nextUrl: NextURL): NextURL => {
    const nextUrlHandler: ProxyHandler<NextURL> = {
      get(target, prop): unknown {
        switch (prop) {
          case "search":
          case "searchParams":
          case "url":
          case "href":
          case "toJSON":
          case "toString":
          case "origin":
            return throwStaticGenerationError(`nextUrl.${String(prop)}`);
          case "clone":
            return () => wrapRequireStaticNextUrl(target.clone());
          default:
            return bindMethodIfNeeded(Reflect.get(target, prop, target), target);
        }
      },
    };

    return new Proxy(nextUrl, nextUrlHandler);
  };

  const wrapRequest = (rawInput: Request): NextRequest => {
    // App Router route handlers only run for in-basePath requests — the
    // routing layer strips the basePath prefix before invoking them. Re-add
    // the configured prefix so the NextRequest mirrors the original URL
    // Next.js hands to route handlers: request.url keeps the prefix while
    // NextURL strips it back during construction, so nextUrl.pathname stays
    // basePath-free and nextUrl.basePath reports the configured value.
    let input = rawInput;
    if (options.basePath) {
      const inputUrl = new URL(rawInput.url);
      const prefixedPathname = addBasePathToPathname(inputUrl.pathname, options.basePath);
      if (prefixedPathname !== inputUrl.pathname) {
        inputUrl.pathname = prefixedPathname;
        // Transfer the body instead of cloning: `rawInput` is replaced here and
        // its body is never read again, so a tee would just leave an unread
        // branch buffering the whole request in memory.
        input = new Request(inputUrl, rawInput);
      }
    }
    const requestHeaders = options.middlewareHeaders
      ? buildRequestHeadersFromMiddlewareResponse(input.headers, options.middlewareHeaders)
      : null;
    const requestWithOverrides = requestHeaders
      ? rebuildRequestWithHeaders(input, requestHeaders)
      : input;
    const nextRequest =
      requestWithOverrides instanceof NextRequest
        ? requestWithOverrides
        : new NextRequest(requestWithOverrides, { nextConfig: nextConfig ?? undefined });

    // Route handlers routinely hand this request to fetch-based handler
    // libraries (oRPC, Hono, …) that re-wrap it via `new Request(request, init)`.
    // A Proxy is not a real Request: on workerd `new Request(proxy)` cannot read
    // the native internal slots and coerces the proxy to the URL string
    // "[object Request]" (Node's undici instead throws "Cannot read private
    // member #state"), which crashes the handler. So in the common "auto" mode
    // we track dynamic access with own accessor properties on the real
    // NextRequest instead of a Proxy, keeping the object a genuine, re-wrappable
    // Request.
    //
    // The value-substituting static-generation modes below deliberately keep the
    // Proxy: own accessors can only *shadow* JS getters, but `new Request(req)`
    // copies the native internal slots, bypassing them. So stubbing those modes
    // with own accessors would silently leak the real URL (incl. credentials and
    // query), headers, cookies, and body on re-wrap — exactly what force-static
    // strips. Keeping the Proxy makes a re-wrap throw instead of leak (and in
    // "error" mode throwing on request access is the intended behaviour), which
    // is the safe outcome for the contradictory case of a static route handler
    // that hands its request to a fetch-based library.
    if (requestMode === "auto") {
      let proxiedNextUrl: NextURL | null = null;
      // Because the tracking getters live on the real instance, a getter that
      // internally reads another tracked property (e.g. the shim's `ip`/`geo`
      // reading `this.headers`) would re-mark it. Suppress marking while a
      // tracked value is being resolved so only the outer access is reported —
      // matching the previous Proxy behaviour that read through the untracked
      // target.
      let resolvingTrackedValue = false;
      const readUntracked = <T>(read: () => T): T => {
        const previous = resolvingTrackedValue;
        resolvingTrackedValue = true;
        try {
          return read();
        } finally {
          resolvingTrackedValue = previous;
        }
      };
      for (const prop of AUTO_TRACKED_REQUEST_PROPS) {
        const original = resolveInheritedDescriptor(nextRequest, prop);
        Object.defineProperty(nextRequest, prop, {
          configurable: true,
          get() {
            if (!resolvingTrackedValue) {
              markDynamicAccess(`request.${prop}`);
            }
            const value = readUntracked(() =>
              original?.get ? original.get.call(nextRequest) : original?.value,
            );
            return bindMethodIfNeeded(value, nextRequest);
          },
        });
      }
      const originalNextUrl = resolveInheritedDescriptor(nextRequest, "nextUrl");
      Object.defineProperty(nextRequest, "nextUrl", {
        configurable: true,
        get() {
          proxiedNextUrl ??= wrapNextUrl(
            readUntracked(() =>
              originalNextUrl?.get ? originalNextUrl.get.call(nextRequest) : originalNextUrl?.value,
            ) as NextURL,
          );
          return proxiedNextUrl;
        },
      });
      // `clone` is always present on the Request prototype chain; capture it in a
      // plain variable so calling it neither trips no-unsafe-optional-chaining nor
      // references an unbound prototype method.
      const originalClone = resolveInheritedDescriptor(nextRequest, "clone")
        ?.value as () => Request;
      Object.defineProperty(nextRequest, "clone", {
        configurable: true,
        value: () => wrapRequest(readUntracked(() => originalClone.call(nextRequest))),
      });
      return nextRequest;
    }

    let forceStaticNextUrl: NextURL | null = null;
    let requireStaticNextUrl: NextURL | null = null;
    let forceStaticHeaders: Headers | null = null;
    let forceStaticCookies: RequestCookies | null = null;

    const requestHandler: ProxyHandler<NextRequest> = {
      get(target, prop): unknown {
        if (requestMode === "force-static") {
          switch (prop) {
            case "nextUrl":
              forceStaticNextUrl ??= wrapForceStaticNextUrl(target.nextUrl);
              return forceStaticNextUrl;
            case "headers":
              forceStaticHeaders ??= sealRequestHeaders(new Headers());
              return forceStaticHeaders;
            case "cookies":
              forceStaticCookies ??= sealRequestCookies(new RequestCookies(new Headers()));
              return forceStaticCookies;
            case "url":
              return cleanStaticUrl(target.nextUrl.href);
            case "ip":
            case "geo":
              return undefined;
            case "body":
              return null;
            case "arrayBuffer":
              return readEmptyBodyAsArrayBuffer;
            case "blob":
              return readEmptyBodyAsBlob;
            case "formData":
              return readEmptyBodyAsFormData;
            case "json":
              return readEmptyBodyAsJson;
            case "text":
              return readEmptyBodyAsText;
            case "clone":
              return () => wrapRequest(target.clone());
            default:
              return bindMethodIfNeeded(Reflect.get(target, prop, target), target);
          }
        }

        if (requestMode === "error") {
          switch (prop) {
            case "nextUrl":
              requireStaticNextUrl ??= wrapRequireStaticNextUrl(target.nextUrl);
              return requireStaticNextUrl;
            case "headers":
            case "cookies":
            case "url":
            // Deliberate vinext divergence from Next.js: ip/geo are exposed
            // on NextRequest for Cloudflare compatibility, so require-static
            // treats them as dynamic request APIs instead of falling through.
            case "ip":
            case "geo":
            case "body":
            case "blob":
            case "json":
            case "text":
            case "arrayBuffer":
            case "formData":
              return throwStaticGenerationError(`request.${String(prop)}`);
            case "clone":
              return () => wrapRequest(target.clone());
            default:
              return bindMethodIfNeeded(Reflect.get(target, prop, target), target);
          }
        }

        // "auto" mode is handled with own accessors before the Proxy is built,
        // and force-static/error return within their branches above. Fall back
        // to a transparent passthrough for any other property.
        return bindMethodIfNeeded(Reflect.get(target, prop, target), target);
      },
    };

    return new Proxy(nextRequest, requestHandler);
  };

  return {
    request: wrapRequest(request),
    didAccessDynamicRequest() {
      return didAccessDynamicRequest;
    },
  };
}
