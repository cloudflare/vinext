/**
 * next/server shim
 *
 * Provides NextRequest, NextResponse, and related types that work with
 * standard Web APIs (Request/Response). This means they work on Node,
 * Cloudflare Workers, Deno, and any WinterCG-compatible runtime.
 *
 * This is a pragmatic subset — we implement the most commonly used APIs
 * rather than bug-for-bug parity with Next.js internals.
 */

import {
  MIDDLEWARE_NEXT_HEADER,
  MIDDLEWARE_REWRITE_HEADER,
  MIDDLEWARE_SET_COOKIE_HEADER,
} from "../server/headers.js";
import { encodeMiddlewareRequestHeaders } from "../utils/middleware-request-headers.js";
import { validateCookieAttributeValue, validateCookieName } from "./internal/cookie-serialize.js";
import { parseEdgeRequestCookieHeader } from "../utils/parse-cookie.js";
import { getRequestExecutionContext } from "./request-context.js";
import {
  bindRequestContextSnapshot,
  getRequestContext,
  isInsideUnifiedScope,
  queueAfterCallback,
} from "./unified-request-context.js";
import { assertSafeNavigationUrl } from "./url-safety.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";

/** @deprecated Import ImageResponse from `next/og` instead. */
export function ImageResponse(): never {
  throw new Error("ImageResponse has moved from next/server to next/og");
}

// ---------------------------------------------------------------------------
// Inlined cache-scope guard for after()
//
// We cannot statically import throwIfInsideCacheScope from headers.ts here
// because headers.ts contains the "use cache" directive string in its error
// message, which causes Vite's use-cache transform to include it in the module
// graph. If headers.ts is pulled in via static import from server.ts, the
// transform fires on it in Pages Router fixtures that lack @vitejs/plugin-rsc.
//
// The connection() function in this file avoids the same problem by using
// `await import("./headers.js")` (dynamic import, async function). after()
// must remain synchronous, so we inline the check using the same Symbol.for
// keys that cache-runtime.ts and cache.ts register their ALS instances with.
// ---------------------------------------------------------------------------

const _USE_CACHE_ALS_KEY = Symbol.for("vinext.cacheRuntime.contextAls");
const _UNSTABLE_CACHE_ALS_KEY = Symbol.for("vinext.unstableCache.als");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;

/**
 * Record an invalid dynamic usage error on the request context so it survives
 * user try/catch and can be forwarded to the dev overlay on client-side navigations.
 */
function _recordInvalidDynamicUsageError(error: Error): void {
  try {
    const _unifiedAls = _g[Symbol.for("vinext.unifiedRequestContext.als")] as
      | { getStore(): unknown }
      | undefined;
    const ctx = _unifiedAls?.getStore() as Record<string, unknown> | undefined;
    if (ctx) ctx.invalidDynamicUsageError = error;
  } catch {
    // Ignore — best-effort recording for dev diagnostics
  }
}

function _throwIfInsideCacheScope(apiName: string): void {
  const cacheAls = _g[_USE_CACHE_ALS_KEY] as { getStore(): unknown } | undefined;
  if (cacheAls?.getStore() != null) {
    const error = new Error(
      `\`${apiName}\` cannot be called inside "use cache". ` +
        `If you need this data inside a cached function, call \`${apiName}\` ` +
        "outside and pass the required data as an argument.",
    );
    _recordInvalidDynamicUsageError(error);
    throw error;
  }
  const unstableAls = _g[_UNSTABLE_CACHE_ALS_KEY] as { getStore(): unknown } | undefined;
  if (unstableAls?.getStore() === true) {
    const error = new Error(
      `\`${apiName}\` cannot be called inside a function cached with \`unstable_cache()\`. ` +
        `If you need this data inside a cached function, call \`${apiName}\` ` +
        "outside and pass the required data as an argument.",
    );
    _recordInvalidDynamicUsageError(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// NextRequest
// ---------------------------------------------------------------------------

export type RequestInit = globalThis.RequestInit & {
  nextConfig?: {
    basePath?: string;
    i18n?: {
      locales: readonly string[];
      defaultLocale: string;
      domains?: ReadonlyArray<{
        domain: string;
        defaultLocale: string;
        locales?: readonly string[];
        http?: true;
      }>;
    } | null;
    trailingSlash?: boolean;
  };
  signal?: AbortSignal;
  duplex?: "half";
};

export class NextRequest extends Request {
  private _nextUrl: NextURL;
  private _url: string;
  private _cookies: RequestCookies;

  constructor(input: URL | RequestInfo, init?: RequestInit) {
    // Match Next.js: reject relative URLs with the canonical error before any
    // fallback URL parsing kicks in. Next.js calls `validateURL(url)` at the
    // top of its NextRequest constructor; we mirror that here so middleware
    // tests asserting on the error message text get the documented string.
    // Reuse the local `validateURL` helper so the message format stays in lockstep
    // with NextResponse, and so `javascript:` / `data:` URIs are blocked too.
    const rawUrl = typeof input !== "string" && "url" in input ? input.url : String(input);
    validateURL(rawUrl);
    // Strip nextConfig before passing to super() — it's vinext-internal,
    // not a valid RequestInit property.
    const { nextConfig: _nextConfig, ...requestInit } = init ?? {};
    if (input instanceof Request) {
      // Keep caller-owned request bodies readable after wrapping. Middleware and
      // route-handler plumbing may need the source Request after this wrapper runs.
      const requestInput =
        requestInit.body === undefined && input.body && !input.bodyUsed ? input.clone() : input;
      super(requestInput, requestInit);
      const cf = Reflect.get(input, "cf");
      if (cf !== undefined) {
        Object.defineProperty(this, "cf", {
          value: cf,
          enumerable: true,
          configurable: true,
        });
      }
    } else {
      super(input, requestInit);
    }
    const url =
      typeof input === "string"
        ? new URL(input, "http://localhost")
        : input instanceof URL
          ? input
          : new URL(input.url, "http://localhost");
    const i18n = _nextConfig?.i18n
      ? {
          locales: [..._nextConfig.i18n.locales],
          defaultLocale: _nextConfig.i18n.defaultLocale,
          domains: _nextConfig.i18n.domains?.map((domain) => ({
            ...domain,
            locales: domain.locales ? [...domain.locales] : undefined,
          })),
        }
      : undefined;
    const urlConfig: NextURLConfig | undefined = _nextConfig
      ? {
          basePath: _nextConfig.basePath,
          nextConfig: { i18n, trailingSlash: _nextConfig.trailingSlash },
        }
      : undefined;
    this._nextUrl = new NextURL(url, undefined, urlConfig);
    this._url = process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE
      ? url.toString()
      : this._nextUrl.toString();
    this._cookies = new RequestCookies(this.headers);
  }

  get nextUrl(): NextURL {
    return this._nextUrl;
  }

  get url(): string {
    return this._url;
  }

  get cookies(): RequestCookies {
    return this._cookies;
  }

  get page(): void {
    throw new Error("NextRequest.page has been removed; use URLPattern instead");
  }

  get ua(): void {
    throw new Error("NextRequest.ua has been removed; use userAgent() instead");
  }

  /**
   * Client IP address. Prefers Cloudflare's trusted CF-Connecting-IP header
   * over the spoofable X-Forwarded-For. Returns undefined if unavailable.
   */
  get ip(): string | undefined {
    return (
      this.headers.get("cf-connecting-ip") ??
      this.headers.get("x-real-ip") ??
      this.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      undefined
    );
  }

  /**
   * Geolocation data. Platform-dependent (e.g., Cloudflare, Vercel).
   * Returns undefined if not available.
   */
  get geo():
    | { city?: string; country?: string; region?: string; latitude?: string; longitude?: string }
    | undefined {
    // Check Cloudflare-style headers, Vercel-style headers
    const country =
      this.headers.get("cf-ipcountry") ?? this.headers.get("x-vercel-ip-country") ?? undefined;
    if (!country) return undefined;
    return {
      country,
      city: this.headers.get("cf-ipcity") ?? this.headers.get("x-vercel-ip-city") ?? undefined,
      region:
        this.headers.get("cf-region") ??
        this.headers.get("x-vercel-ip-country-region") ??
        undefined,
      latitude:
        this.headers.get("cf-iplatitude") ?? this.headers.get("x-vercel-ip-latitude") ?? undefined,
      longitude:
        this.headers.get("cf-iplongitude") ??
        this.headers.get("x-vercel-ip-longitude") ??
        undefined,
    };
  }

  /**
   * The build ID of the Next.js application.
   * Delegates to `nextUrl.buildId` to match Next.js API surface.
   * Can be used in middleware to detect deployment skew between client and server.
   */
  get buildId(): string | undefined {
    return this._nextUrl.buildId;
  }
}

// ---------------------------------------------------------------------------
// NextResponse
// ---------------------------------------------------------------------------

/** Valid HTTP redirect status codes, matching Next.js's REDIRECTS set. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateURL(url: string | URL | { toString(): string }): string {
  assertSafeNavigationUrl(String(url));
  try {
    return String(new URL(String(url)));
  } catch (error) {
    throw new Error(
      `URL is malformed "${String(
        url,
      )}". Please use only absolute URLs - https://nextjs.org/docs/messages/middleware-relative-urls`,
      { cause: error },
    );
  }
}

export class NextResponse<_Body = unknown> extends Response {
  private _cookies: ResponseCookies;

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init);
    this._cookies = new MiddlewareResponseCookies(this.headers);
  }

  get cookies(): ResponseCookies {
    return this._cookies;
  }

  /**
   * Create a JSON response.
   */
  static json<JsonBody>(body: JsonBody, init?: ResponseInit): NextResponse<JsonBody> {
    const response = Response.json(body, init);
    return new NextResponse(response.body, response) as NextResponse<JsonBody>;
  }

  /**
   * Create a redirect response.
   */
  static redirect(
    url: string | URL | { toString(): string },
    init?: number | ResponseInit,
  ): NextResponse {
    const status = typeof init === "number" ? init : (init?.status ?? 307);
    if (!REDIRECT_STATUSES.has(status)) {
      throw new RangeError(`Failed to execute "redirect" on "response": Invalid status code`);
    }
    const headers = new Headers(typeof init === "object" ? init?.headers : undefined);
    headers.set("Location", validateURL(url));
    return new NextResponse(null, { status, headers });
  }

  /**
   * Create a rewrite response (middleware pattern).
   * Sets the x-middleware-rewrite header.
   */
  static rewrite(
    destination: string | URL | { toString(): string },
    init?: MiddlewareResponseInit,
  ): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set(MIDDLEWARE_REWRITE_HEADER, validateURL(destination));
    if (init?.request?.headers) {
      encodeMiddlewareRequestHeaders(headers, init.request.headers);
    }
    return new NextResponse(null, { ...init, headers });
  }

  /**
   * Continue to the next handler (middleware pattern).
   * Sets the x-middleware-next header.
   */
  static next(init?: MiddlewareResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set(MIDDLEWARE_NEXT_HEADER, "1");
    if (init?.request?.headers) {
      encodeMiddlewareRequestHeaders(headers, init.request.headers);
    }
    return new NextResponse(null, { ...init, headers });
  }
}

// ---------------------------------------------------------------------------
// NextURL — lightweight URL wrapper with pathname helpers
// ---------------------------------------------------------------------------

export type NextURLConfig = {
  basePath?: string;
  nextConfig?: {
    i18n?: {
      locales: string[];
      defaultLocale: string;
      domains?: Array<{
        domain: string;
        defaultLocale: string;
        locales?: string[];
      }>;
    };
    /**
     * When true, `href`/`toString()` formats non-root, non-file-like pathnames
     * with a trailing slash. Matches Next.js's `formatNextPathnameInfo` so that
     * `NextResponse.redirect(request.nextUrl)` and `NextResponse.rewrite(url)`
     * honour the user's `trailingSlash` config.
     */
    trailingSlash?: boolean;
  };
};

export class NextURL {
  /** Internal URL stores the pathname WITHOUT basePath or locale prefix. */
  private _url: URL;
  /**
   * The configured basePath (from nextConfig). May differ from the active
   * `_basePath`: parsing only activates basePath when the URL's pathname
   * actually carries the configured prefix.
   */
  private _configBasePath: string;
  private _basePath: string;
  private _trailingSlash: boolean;
  private _locale: string | undefined;
  private _configDefaultLocale: string | undefined;
  private _defaultLocale: string | undefined;
  private _locales: string[] | undefined;
  private _domains: NonNullable<NonNullable<NextURLConfig["nextConfig"]>["i18n"]>["domains"];
  private _domainLocale:
    | NonNullable<NonNullable<NonNullable<NextURLConfig["nextConfig"]>["i18n"]>["domains"]>[number]
    | undefined;

  constructor(input: string | URL, base?: string | URL, config?: NextURLConfig) {
    this._url = new URL(input.toString(), base);
    this._configBasePath = config?.basePath ?? "";
    this._basePath = this._configBasePath;
    this._trailingSlash = config?.nextConfig?.trailingSlash ?? false;
    this._stripBasePath();
    const i18n = config?.nextConfig?.i18n;
    if (i18n) {
      this._locales = [...i18n.locales];
      this._domains = i18n.domains?.map((domain) => ({
        ...domain,
        locales: domain.locales ? [...domain.locales] : undefined,
      }));
      this._configDefaultLocale = i18n.defaultLocale;
      this._analyzeI18n();
    }
  }

  /** Strip basePath prefix from the internal pathname.
   * Mirrors Next.js's getNextPathnameInfo (re-run by NextURL.analyze() on
   * every parse, including `href` reassignment): basePath is only considered
   * active when the URL's pathname actually starts with the configured
   * basePath prefix. If the pathname is outside the basePath, the active
   * basePath is cleared to "" so that request.nextUrl.basePath reflects the
   * actual URL rather than the config value; if a later `href` assignment
   * moves the URL back inside the basePath, it is re-activated from the
   * configured value. This matches the Next.js behavior tested by
   * middleware-base-path's "should execute from absolute paths" case.
   */
  private _stripBasePath(): void {
    if (!this._configBasePath) return;
    if (!hasBasePath(this._url.pathname, this._configBasePath)) {
      this._basePath = "";
      return;
    }
    this._basePath = this._configBasePath;
    this._url.pathname = stripBasePath(this._url.pathname, this._configBasePath);
  }

  /** Extract locale from pathname, stripping it from the internal URL. */
  private _detectPathnameLocale(locales: string[]): string | undefined {
    const segments = this._url.pathname.split("/");
    const candidate = segments[1]?.toLowerCase();
    const match = locales.find((l) => l.toLowerCase() === candidate);
    if (match) {
      this._url.pathname = "/" + segments.slice(2).join("/");
    }
    return match;
  }

  private _analyzeI18n(): void {
    if (!this._locales || !this._configDefaultLocale) return;
    const detectedLocale = this._detectPathnameLocale(this._locales);
    const detectedLocaleLower = detectedLocale?.toLowerCase();
    const hostname = this._url.hostname.toLowerCase();
    this._domainLocale = this._domains?.find(
      (domain) =>
        domain.domain.split(":", 1)[0].toLowerCase() === hostname ||
        detectedLocaleLower === domain.defaultLocale.toLowerCase() ||
        domain.locales?.some((locale) => locale.toLowerCase() === detectedLocaleLower),
    );
    this._defaultLocale = this._domainLocale?.defaultLocale ?? this._configDefaultLocale;
    this._locale = detectedLocale ?? this._defaultLocale;
  }

  /**
   * Reconstruct the full pathname with basePath + locale prefix and apply
   * the configured trailingSlash policy.
   * Mirrors Next.js's internal formatNextPathnameInfo().
   */
  private _formatPathname(): string {
    // Build prefix: basePath + locale (skip defaultLocale — Next.js omits it)
    let prefix = this._basePath;
    const inner = this._url.pathname;
    const innerLower = inner.toLowerCase();
    const isApiPath = innerLower === "/api" || innerLower.startsWith("/api/");
    if (!isApiPath && this._locale && this._locale !== this._defaultLocale) {
      prefix += "/" + this._locale;
    }
    const composed = !prefix ? inner : inner === "/" ? prefix : prefix + inner;
    return this._applyTrailingSlash(composed);
  }

  /**
   * Apply the configured trailingSlash policy to a composed pathname. Matches
   * Next.js's `formatNextPathnameInfo`: when `trailingSlash` is true, add a
   * trailing slash unless the path is empty/root; when false, strip a trailing
   * slash unless the path is empty/root.
   */
  private _applyTrailingSlash(pathname: string): string {
    // Never strip or add a slash to the root path.
    if (pathname === "" || pathname === "/") return pathname;
    if (this._trailingSlash) {
      return pathname.endsWith("/") ? pathname : pathname + "/";
    }
    return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  }

  get href(): string {
    const formatted = this._formatPathname();
    if (formatted === this._url.pathname) return this._url.href;
    // Replace pathname in href via string slicing — avoids URL allocation.
    // URL.href is always <origin+auth><pathname><search><hash>.
    const { href, pathname, search, hash } = this._url;
    const baseEnd = href.length - pathname.length - search.length - hash.length;
    return href.slice(0, baseEnd) + formatted + search + hash;
  }
  set href(value: string) {
    this._url.href = value;
    this._stripBasePath();
    this._analyzeI18n();
  }

  get origin(): string {
    return this._url.origin;
  }

  get protocol(): string {
    return this._url.protocol;
  }
  set protocol(value: string) {
    this._url.protocol = value;
  }

  get username(): string {
    return this._url.username;
  }
  set username(value: string) {
    this._url.username = value;
  }

  get password(): string {
    return this._url.password;
  }
  set password(value: string) {
    this._url.password = value;
  }

  get host(): string {
    return this._url.host;
  }
  set host(value: string) {
    this._url.host = value;
  }

  get hostname(): string {
    return this._url.hostname;
  }
  set hostname(value: string) {
    this._url.hostname = value;
  }

  get port(): string {
    return this._url.port;
  }
  set port(value: string) {
    this._url.port = value;
  }

  /** Returns the pathname WITHOUT basePath or locale prefix. */
  get pathname(): string {
    return this._url.pathname;
  }
  set pathname(value: string) {
    this._url.pathname = value;
  }

  get search(): string {
    return this._url.search;
  }
  set search(value: string) {
    this._url.search = value;
  }

  get searchParams(): URLSearchParams {
    return this._url.searchParams;
  }

  get hash(): string {
    return this._url.hash;
  }
  set hash(value: string) {
    this._url.hash = value;
  }

  get basePath(): string {
    return this._basePath;
  }
  set basePath(value: string) {
    this._basePath = value === "" ? "" : value.startsWith("/") ? value : "/" + value;
  }

  get locale(): string {
    return this._locale ?? "";
  }
  set locale(value: string | undefined) {
    if (this._locales) {
      if (!value) {
        this._locale = this._defaultLocale;
        return;
      }
      if (!this._locales.includes(value)) {
        throw new TypeError(
          `The locale "${value}" is not in the configured locales: ${this._locales.join(", ")}`,
        );
      }
    }
    this._locale = this._locales ? value : this._locale;
  }

  get defaultLocale(): string | undefined {
    return this._defaultLocale;
  }

  get domainLocale(): typeof this._domainLocale {
    if (!this._domainLocale) return undefined;
    return {
      ...this._domainLocale,
      locales: this._domainLocale.locales ? [...this._domainLocale.locales] : undefined,
    };
  }

  get locales(): string[] | undefined {
    return this._locales ? [...this._locales] : undefined;
  }

  clone(): NextURL {
    const nextConfig: NonNullable<NextURLConfig["nextConfig"]> = {};
    if (this._locales) {
      nextConfig.i18n = {
        locales: [...this._locales],
        defaultLocale: this._configDefaultLocale!,
        domains: this._domains?.map((domain) => ({
          ...domain,
          locales: domain.locales ? [...domain.locales] : undefined,
        })),
      };
    }
    if (this._trailingSlash) {
      nextConfig.trailingSlash = true;
    }
    const config: NextURLConfig = {
      basePath: this._basePath,
      nextConfig: Object.keys(nextConfig).length > 0 ? nextConfig : undefined,
    };
    // Pass the full href (with locale/basePath re-added) so the constructor
    // can re-analyze and extract locale correctly.
    return new NextURL(this.href, undefined, config);
  }

  toString(): string {
    return this.href;
  }

  toJSON(): string {
    return this.href;
  }

  /**
   * The build ID of the Next.js application.
   * Set from `generateBuildId` in next.config.js, or a random UUID if not configured.
   * Can be used in middleware to detect deployment skew between client and server.
   * Matches the Next.js API: `request.nextUrl.buildId`.
   */
  get buildId(): string | undefined {
    return process.env.__VINEXT_BUILD_ID ?? undefined;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers (minimal implementations)
// ---------------------------------------------------------------------------

type CookieEntry = {
  name: string;
  value: string;
};

export class RequestCookies {
  private _headers: Headers;
  private _parsed: Map<string, string>;

  constructor(headers: Headers) {
    this._headers = headers;
    this._parsed = parseEdgeRequestCookieHeader(headers.get("cookie") ?? "");
  }

  get(name: string): CookieEntry | undefined {
    const value = this._parsed.get(name);
    return value !== undefined ? { name, value } : undefined;
  }

  getAll(nameOrOptions?: string | CookieEntry): CookieEntry[] {
    const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions?.name;
    return [...this._parsed.entries()]
      .filter(([cookieName]) => name === undefined || cookieName === name)
      .map(([cookieName, value]) => ({ name: cookieName, value }));
  }

  has(name: string): boolean {
    return this._parsed.has(name);
  }

  set(nameOrOptions: string | CookieEntry, value?: string): this {
    let cookieName: string;
    let cookieValue: string;
    if (typeof nameOrOptions === "string") {
      cookieName = nameOrOptions;
      cookieValue = value ?? "";
    } else {
      cookieName = nameOrOptions.name;
      cookieValue = nameOrOptions.value;
    }
    validateCookieName(cookieName);
    this._parsed.set(cookieName, cookieValue);
    this._syncHeader();
    return this;
  }

  delete(names: string | string[]): boolean | boolean[] {
    if (Array.isArray(names)) {
      const results = names.map((name) => {
        validateCookieName(name);
        return this._parsed.delete(name);
      });
      this._syncHeader();
      return results;
    }
    validateCookieName(names);
    const result = this._parsed.delete(names);
    this._syncHeader();
    return result;
  }

  clear(): this {
    this._parsed.clear();
    this._syncHeader();
    return this;
  }

  get size(): number {
    return this._parsed.size;
  }

  toString(): string {
    return this._serialize();
  }

  private _serialize(): string {
    return [...this._parsed.entries()].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("; ");
  }

  private _syncHeader(): void {
    if (this._parsed.size === 0) {
      this._headers.delete("cookie");
    } else {
      this._headers.set("cookie", this._serialize());
    }
  }

  [Symbol.iterator](): MapIterator<[string, CookieEntry]> {
    return new Map(this.getAll().map((cookie) => [cookie.name, cookie] as const)).entries();
  }
}

// Keep this error message in sync with headers.ts. This adapter backs
// NextRequest cookies, while headers.ts owns the next/headers cookies object.
class ReadonlyRequestCookiesError extends Error {
  constructor() {
    super(
      "Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options",
    );
  }

  static callable(this: void): never {
    throw new ReadonlyRequestCookiesError();
  }
}

const REQUEST_HEADERS_MUTATING_METHODS = new Set(["set", "delete", "append"]);

// Keep this error message in sync with headers.ts. This adapter backs
// NextRequest headers in force-static route handlers, while headers.ts owns the
// next/headers object.
class ReadonlyRequestHeadersError extends Error {
  constructor() {
    super(
      "Headers cannot be modified. Read more: https://nextjs.org/docs/app/api-reference/functions/headers",
    );
  }

  static callable(this: void): never {
    throw new ReadonlyRequestHeadersError();
  }
}

export function sealRequestHeaders(headers: Headers): Headers {
  return new Proxy<Headers>(headers, {
    get(target, prop) {
      if (typeof prop === "string" && REQUEST_HEADERS_MUTATING_METHODS.has(prop)) {
        return ReadonlyRequestHeadersError.callable;
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function sealRequestCookies(cookies: RequestCookies): RequestCookies {
  return new Proxy<RequestCookies>(cookies, {
    get(target, prop) {
      if (prop === "set" || prop === "delete" || prop === "clear") {
        return ReadonlyRequestCookiesError.callable;
      }

      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class ResponseCookies {
  private _headers: Headers;
  /** Internal map keyed by cookie name — single source of truth. */
  private _parsed: Map<string, ResponseCookieEntry> = new Map();

  constructor(headers: Headers) {
    this._headers = headers;

    const setCookie = headers.getSetCookie?.() ?? headers.get("set-cookie") ?? [];
    const cookieStrings = Array.isArray(setCookie) ? setCookie : splitSetCookieString(setCookie);
    for (const header of cookieStrings) {
      const entry = parseSetCookieHeader(header);
      if (entry) this._parsed.set(entry.name, entry);
    }
  }

  set(
    ...args:
      | [name: string, value: string, options?: CookieOptions]
      | [options: CookieOptions & { name: string; value: string }]
  ): this {
    const [name, value, opts] = parseCookieSetArgs(args);
    validateCookieName(name);

    const entry = normalizeResponseCookie(name, value, opts);
    validateResponseCookieAttributes(entry);
    this._parsed.set(name, entry);
    this._syncHeaders();
    return this;
  }

  get(...args: [name: string] | [options: { name: string }]): ResponseCookieEntry | undefined {
    const key = typeof args[0] === "string" ? args[0] : args[0].name;
    return this._parsed.get(key);
  }

  has(name: string): boolean {
    return this._parsed.has(name);
  }

  getAll(...args: [name: string] | [options: { name: string }] | []): ResponseCookieEntry[] {
    const all = [...this._parsed.values()];
    if (args.length === 0) return all;
    const key = typeof args[0] === "string" ? args[0] : args[0].name;
    return all.filter((c) => c.name === key);
  }

  delete(
    ...args:
      | [name: string]
      | [options: Omit<CookieOptions & { name: string }, "maxAge" | "expires">]
  ): this {
    const [name, options] =
      typeof args[0] === "string" ? [args[0], undefined] : [args[0].name, args[0]];
    return this.set({ ...options, name, value: "", expires: new Date(0) });
  }

  [Symbol.iterator](): MapIterator<[string, ResponseCookieEntry]> {
    return new Map(
      [...this._parsed.values()].map((entry) => [entry.name, entry] as const),
    ).entries();
  }

  toString(): string {
    return [...this._parsed.values()].map(stringifyResponseCookie).join("; ");
  }

  /** Delete all Set-Cookie headers and re-append from the internal map. */
  private _syncHeaders(): void {
    this._headers.delete("Set-Cookie");
    for (const entry of this._parsed.values()) {
      this._headers.append("Set-Cookie", stringifyResponseCookie(entry));
    }
  }
}

class MiddlewareResponseCookies extends ResponseCookies {
  private _responseHeaders: Headers;

  constructor(headers: Headers) {
    super(headers);
    this._responseHeaders = headers;
  }

  override set(
    ...args:
      | [name: string, value: string, options?: CookieOptions]
      | [options: CookieOptions & { name: string; value: string }]
  ): this {
    super.set(...args);
    this._syncMiddlewareCookieHeader();
    return this;
  }

  override delete(
    ...args:
      | [name: string]
      | [options: Omit<CookieOptions & { name: string }, "maxAge" | "expires">]
  ): this {
    super.delete(...args);
    this._syncMiddlewareCookieHeader();
    return this;
  }

  private _syncMiddlewareCookieHeader(): void {
    const cookies = this._responseHeaders.getSetCookie();
    if (cookies.length === 0) {
      this._responseHeaders.delete(MIDDLEWARE_SET_COOKIE_HEADER);
      return;
    }

    this._responseHeaders.set(MIDDLEWARE_SET_COOKIE_HEADER, cookies.join(","));
  }
}

type CookieOptions = {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date | number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: true | false | "strict" | "lax" | "none";
  partitioned?: boolean;
  priority?: "low" | "medium" | "high";
};

type ResponseCookieEntry = CookieEntry & CookieOptions;

function normalizeResponseCookie(
  name: string,
  value: string,
  options?: CookieOptions,
): ResponseCookieEntry {
  const cookie: ResponseCookieEntry = {
    name,
    value,
    ...options,
  };
  if (typeof cookie.expires === "number") {
    cookie.expires = new Date(cookie.expires);
  }
  if (cookie.maxAge) {
    cookie.expires = new Date(Date.now() + cookie.maxAge * 1000);
  }
  if (cookie.path == null) {
    cookie.path = "/";
  }
  return cookie;
}

function parseSetCookieHeader(header: string): ResponseCookieEntry | undefined {
  if (!header) return undefined;

  const [[name, value], ...attributes] = parseResponseCookiePairs(header);
  const { domain, expires, httponly, maxage, path, samesite, secure, partitioned, priority } =
    Object.fromEntries(
      attributes.map(([key, attributeValue]) => [
        key.toLowerCase().replaceAll("-", ""),
        attributeValue,
      ]),
    );
  const cookie = {
    name,
    value: decodeURIComponent(value),
    domain,
    ...(expires && { expires: new Date(expires) }),
    ...(httponly && { httpOnly: true }),
    ...(typeof maxage === "string" && { maxAge: Number(maxage) }),
    path,
    ...(samesite && { sameSite: parseResponseCookieSameSite(samesite) }),
    ...(secure && { secure: true }),
    ...(priority && { priority: parseResponseCookiePriority(priority) }),
    ...(partitioned && { partitioned: true }),
  };

  return compactResponseCookie(cookie) as ResponseCookieEntry;
}

function parseResponseCookiePairs(cookie: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of cookie.split(/; */)) {
    if (!pair) continue;
    const splitAt = pair.indexOf("=");
    if (splitAt === -1) {
      map.set(pair, "true");
      continue;
    }
    const key = pair.slice(0, splitAt);
    const value = pair.slice(splitAt + 1);
    try {
      map.set(key, decodeURIComponent(value ?? "true"));
    } catch {
      // Match @edge-runtime/cookies: ignore malformed encoded pairs.
    }
  }
  return map;
}

function compactResponseCookie<T extends object>(cookie: T): T {
  const compact = {} as T;
  for (const key in cookie) {
    if (cookie[key]) compact[key] = cookie[key];
  }
  return compact;
}

function parseResponseCookieSameSite(value: string): CookieOptions["sameSite"] {
  const sameSite = value.toLowerCase();
  return sameSite === "strict" || sameSite === "lax" || sameSite === "none" ? sameSite : undefined;
}

function parseResponseCookiePriority(value: string): CookieOptions["priority"] {
  const priority = value.toLowerCase();
  return priority === "low" || priority === "medium" || priority === "high" ? priority : undefined;
}

function validateResponseCookieAttributes(cookie: ResponseCookieEntry): void {
  if (cookie.path) validateCookieAttributeValue(cookie.path, "Path");
  if (cookie.domain) validateCookieAttributeValue(cookie.domain, "Domain");
}

function stringifyResponseCookie(cookie: ResponseCookieEntry): string {
  const attributes = [
    cookie.path && `Path=${cookie.path}`,
    (cookie.expires || cookie.expires === 0) &&
      `Expires=${(typeof cookie.expires === "number" ? new Date(cookie.expires) : cookie.expires).toUTCString()}`,
    typeof cookie.maxAge === "number" && `Max-Age=${cookie.maxAge}`,
    cookie.domain && `Domain=${cookie.domain}`,
    cookie.secure && "Secure",
    cookie.httpOnly && "HttpOnly",
    cookie.sameSite && `SameSite=${cookie.sameSite}`,
    cookie.partitioned && "Partitioned",
    cookie.priority && `Priority=${cookie.priority}`,
  ].filter(Boolean);
  const stringified = `${cookie.name}=${encodeURIComponent(cookie.value ?? "")}`;
  return attributes.length === 0 ? stringified : `${stringified}; ${attributes.join("; ")}`;
}

function splitSetCookieString(value: string): string[] {
  const cookies: string[] = [];
  let position = 0;
  let start = 0;

  const skipWhitespace = (): boolean => {
    while (position < value.length && /\s/.test(value.charAt(position))) position++;
    return position < value.length;
  };

  while (position < value.length) {
    start = position;
    let separatorFound = false;

    while (skipWhitespace()) {
      if (value.charAt(position) !== ",") {
        position++;
        continue;
      }

      const lastComma = position++;
      skipWhitespace();
      const nextStart = position;
      while (position < value.length && !"=;,".includes(value.charAt(position))) position++;
      if (position < value.length && value.charAt(position) === "=") {
        separatorFound = true;
        position = nextStart;
        cookies.push(value.substring(start, lastComma));
        start = position;
      } else {
        position = lastComma + 1;
      }
    }

    if (!separatorFound || position >= value.length) {
      cookies.push(value.substring(start));
    }
  }

  return cookies;
}

/**
 * Parse the overloaded arguments for ResponseCookies.set():
 *   - (name, value, options?) — positional form
 *   - ({ name, value, ...options }) — object form
 */
function parseCookieSetArgs(
  args:
    | [name: string, value: string, options?: CookieOptions]
    | [options: CookieOptions & { name: string; value: string }],
): [string, string, CookieOptions | undefined] {
  if (typeof args[0] === "string") {
    return [args[0], args[1] as string, args[2] as CookieOptions | undefined];
  }
  const { name, value, ...opts } = args[0];
  return [name, value, opts as CookieOptions];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MiddlewareResponseInit = {
  request?: {
    headers?: Headers;
  };
} & ResponseInit;

export type NextMiddlewareResult = NextResponse | Response | null | undefined | void;

export type NextMiddleware = (
  request: NextRequest,
  event: NextFetchEvent,
) => NextMiddlewareResult | Promise<NextMiddlewareResult>;

/**
 * Minimal NextFetchEvent — extends FetchEvent where available,
 * otherwise provides the waitUntil pattern standalone.
 */
export class NextFetchEvent {
  sourcePage: string;
  private _waitUntilPromises: Promise<unknown>[] = [];

  constructor(params: {
    request?: Request;
    page: string;
    context?: { waitUntil(promise: Promise<unknown>): void };
  }) {
    this.sourcePage = params.page;
    if (params.context) {
      this._externalWaitUntil = params.context.waitUntil.bind(params.context);
    }
  }

  private _externalWaitUntil?: (promise: Promise<unknown>) => void;

  get request(): void {
    throw new Error(
      `The middleware signature for ${this.sourcePage} no longer exposes event.request`,
    );
  }

  respondWith(): void {
    throw new Error(`The middleware signature for ${this.sourcePage} no longer uses respondWith()`);
  }

  passThroughOnException(): void {}

  waitUntil(promise: Promise<unknown>): void {
    if (this._externalWaitUntil) {
      this._externalWaitUntil(promise);
      return;
    }
    this._waitUntilPromises.push(promise);
  }

  get waitUntilPromises(): Promise<unknown>[] {
    return this._waitUntilPromises;
  }

  /** Drain all waitUntil promises. Returns a single promise that settles when all are done. */
  drainWaitUntil(): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.allSettled(this._waitUntilPromises);
  }
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

/**
 * Parse user agent string. Minimal implementation — for full UA parsing,
 * apps should use a dedicated library like `ua-parser-js`.
 */
export function userAgentFromString(ua: string | undefined): UserAgent {
  const input = ua ?? "";
  return {
    isBot: /bot|crawler|spider|crawling/i.test(input),
    ua: input,
    browser: {},
    device: {},
    engine: {},
    os: {},
    cpu: {},
  };
}

export function userAgent({ headers }: { headers: Headers }): UserAgent {
  return userAgentFromString(headers.get("user-agent") ?? undefined);
}

export type UserAgent = {
  isBot: boolean;
  ua: string;
  browser: { name?: string; version?: string; major?: string };
  device: { model?: string; type?: string; vendor?: string };
  engine: { name?: string; version?: string };
  os: { name?: string; version?: string };
  cpu: { architecture?: string };
};

/**
 * after() — schedule work after the response is sent.
 *
 * Uses the platform's `waitUntil` (via the per-request ExecutionContext) when
 * available so the task survives past the response on Cloudflare Workers.
 * Node.js dev drains callbacks from its response finish/close lifecycle.
 *
 * Throws when called inside a cached scope — request-specific
 * side-effects must not leak into cached results.
 */
export function after<T>(task: Promise<T> | (() => T | Promise<T>)): void {
  _throwIfInsideCacheScope("after()");

  const requestContext = isInsideUnifiedScope() ? getRequestContext() : null;

  if (!requestContext) {
    const executionContext = getRequestExecutionContext();
    if (executionContext) {
      if (
        typeof task !== "function" &&
        (task == null || typeof (task as PromiseLike<T>).then !== "function")
      ) {
        throw new TypeError("`after()`: Argument must be a promise or a function");
      }
      const promise = typeof task === "function" ? Promise.resolve().then(task) : task;
      const guarded = Promise.resolve(promise).catch((error) => {
        console.error("[vinext] after() task failed:", error);
      });
      executionContext.waitUntil(guarded);
      return;
    }
    throw new Error("`after()` was called outside a request scope");
  }

  if (typeof task !== "function") {
    if (task == null || typeof (task as PromiseLike<T>).then !== "function") {
      throw new TypeError("`after()`: Argument must be a promise or a function");
    }
    const guarded = Promise.resolve(task).catch((error) => {
      console.error("[vinext] after() task failed:", error);
    });
    getRequestExecutionContext()?.waitUntil(guarded);
    return;
  }

  queueAfterCallback(requestContext, bindRequestContextSnapshot(requestContext, task));
}

/**
 * connection() — signals that the response requires a live connection
 * (not a static/cached response). Opts the page out of ISR caching
 * and sets Cache-Control: no-store on the response.
 */
export async function connection(): Promise<void> {
  const {
    getHeadersContext,
    markDynamicUsage,
    markRenderRequestApiUsage,
    suspendConnectionProbe,
    throwIfInsideCacheScope,
  } = await import("./headers.js");
  if (getHeadersContext()?.forceStatic) {
    return;
  }
  markRenderRequestApiUsage("connection");
  throwIfInsideCacheScope("connection()");
  markDynamicUsage();
  const pendingProbe = suspendConnectionProbe();
  if (pendingProbe) {
    await pendingProbe;
  }
}

/**
 * URLPattern re-export — used in middleware for route matching.
 * Available natively in Node 20+, Cloudflare Workers, Deno.
 * Falls back to urlpattern-polyfill if the global is not available.
 */
export const URLPattern: typeof globalThis.URLPattern =
  globalThis.URLPattern ??
  (() => {
    throw new Error(
      "URLPattern is not available in this runtime. " +
        "Install the `urlpattern-polyfill` package or upgrade to Node 20+.",
    );
  });
